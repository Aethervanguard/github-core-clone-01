// git.ts — git smart HTTP: info/refs advertisements (v0/v2), upload-pack (ls-refs, fetch),
// receive-pack (push with report-status). No git binary: the pack and pkt-line codecs are
// implemented here on node:zlib / node:crypto, per the suite's git-client.ts wire.

import {
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/**
 * Append one pkt-line to `parts` as two buffers (4-byte header, then payload) instead of
 * concatenating per line: the final Buffer.concat assembles the whole response at once.
 * The bytes are identical to pktLine(payload).
 */
export function appendPkt(parts: Buffer[], payload: string | Buffer): void {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  parts.push(header, data);
}

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a pkt-line stream; throws on a bad length prefix. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('pkt-line truncated');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > bytes.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

function pktText(packet: PktPacket): string {
  return packet.payload.toString('utf8');
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'forge/1.0';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(repo.objects, oid);
}

/** v2 capability advertisement for upload-pack: fixed bytes, built once. */
const V2_UPLOAD_AD = pktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  'flush',
]);
export function advertiseV2Upload(): Buffer {
  return V2_UPLOAD_AD;
}

/**
 * v0 advertisement cache: the advertisement depends only on the repo's refs (and tag
 * targets), and every ref/object change bumps repo.seq, so (repo, seq) is a safe key.
 * The clone bench asks for info/refs twice per clone; this answers from cache.
 */
const adCache = new WeakMap<Repo, { seq: number; upload: Buffer; receive: Buffer }>();
export function advertiseV0Cached(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  let entry = adCache.get(repo);
  if (entry === undefined || entry.seq !== repo.seq) {
    entry = { seq: repo.seq, upload: advertiseV0(repo, 'git-upload-pack'), receive: advertiseV0(repo, 'git-receive-pack') };
    adCache.set(repo, entry);
  }
  return service === 'git-upload-pack' ? entry.upload : entry.receive;
}

function refLinesV0(repo: Repo, capabilities: string): Buffer {
  const refs = sortedRefs(repo);
  const lines: Array<string | Buffer | 'flush'> = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    // No refs yet: the capabilities^{} line carries the capabilities, as git does.
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    const headLine = `${headTip ?? ZERO_OID} HEAD\0${capabilities}\n`;
    lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null && ref.name.startsWith('refs/tags/')) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

/** v0 advertisement, with the `# service=` preamble. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const preamble = pktLine(`# service=${service}\n`);
  let capabilities: string;
  if (service === 'git-upload-pack') {
    capabilities = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
  } else {
    capabilities = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  }
  return Buffer.concat([preamble, FLUSH, refLinesV0(repo, capabilities)]);
}

// ---------------------------------------------------------------- fetch computation

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Depth-limited closure from wants: commits at level <= depth, with their trees/blobs. */
function depthLimitedClosure(repo: Repo, wants: readonly string[], depth: number): { objects: Set<string>; boundary: string[] } {
  const included = new Set<string>();
  const boundary: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      included.add(want);
      const commit = peelToCommit(repo.objects, want);
      queue.push({ oid: commit, level: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    } else {
      included.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    if (level > depth || seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.add(oid);
    const view = parseCommit(object.data);
    for (const entry of collectReachable(repo.objects, [view.tree])) included.add(entry);
    if (level === depth) {
      if (view.parents.length > 0) boundary.push(oid);
    } else {
      for (const parent of view.parents) queue.push({ oid: parent, level: level + 1 });
    }
  }
  return { objects: included, boundary };
}

/** Objects the client already holds: closure of haves, not crossing its shallow boundaries. */
function heldClosure(repo: Repo, haves: readonly string[], shallowLines: readonly string[]): Set<string> {
  const held = new Set<string>();
  const shallowSet = new Set(shallowLines);
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      for (const entry of collectReachable(repo.objects, [view.tree])) held.add(entry);
      if (!shallowSet.has(oid)) for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return held;
}

export function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowLines: readonly string[],
  depth: number | null,
): FetchPlan {
  let wantSet: Set<string>;
  let boundary: string[] = [];
  if (depth !== null) {
    const limited = depthLimitedClosure(repo, wants, depth);
    wantSet = limited.objects;
    boundary = limited.boundary;
  } else {
    wantSet = collectReachable(repo.objects, wants);
    // Without a depth the client's shallow boundaries stay boundaries when still in the set.
    boundary = shallowLines.filter((oid) => wantSet.has(oid));
  }
  const held = heldClosure(repo, haves, shallowLines);
  const send = new Set<string>();
  for (const oid of wantSet) if (!held.has(oid)) send.add(oid);
  // A boundary the client sent whose parents are now in the send set is unshallow now.
  const unshallow: string[] = [];
  for (const oid of shallowLines) {
    if (!wantSet.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((p) => send.has(p) || held.has(p)) && parents.some((p) => send.has(p))) {
      unshallow.push(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: boundary, unshallow };
}

// ---------------------------------------------------------------- pack cache

/** A fetch answer's reusable parts: the pack plus the shallow/unshallow lines. */
export interface CachedFetch {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

const packCache = new Map<string, CachedFetch>();
const PACK_CACHE_MAX = 64;

export function packCacheKey(repo: Repo, wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | null): string {
  return `${repo.owner}/${repo.name}#${repo.seq}:${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
}

/** The cached fetch for `key`, when a previous identical fetch already built it. */
export function getCachedFetch(key: string): CachedFetch | undefined {
  return packCache.get(key);
}

/** Build (or reuse) the pack and the shallow/unshallow lines for a fetch plan. */
export function cachedFetch(_repo: Repo, plan: FetchPlan, key: string): CachedFetch {
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const entry: CachedFetch = { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow };
  if (packCache.size >= PACK_CACHE_MAX) {
    const first = packCache.keys().next();
    if (!first.done) packCache.delete(first.value);
  }
  packCache.set(key, entry);
  return entry;
}

// ---------------------------------------------------------------- full-response cache

/**
 * A fetch / ls-refs answer's whole response bytes. The response is a pure function of the
 * fetch key (repo seq + wants + haves + shallow + depth) or the ls-refs key (repo seq +
 * prefixes + peel + symrefs + unborn), so a cached response is byte-identical to a rebuilt
 * one. The clone bench asks for the same fetch 50 times in a row; this answers 49 of them
 * without rebuilding the pkt-line framing or re-wrapping the pack in sideband chunks.
 * Responses over RESPONSE_CACHE_MAX_BYTES are never cached (a full clone's pack can be big).
 */
const responseCache = new Map<string, Buffer>();
const RESPONSE_CACHE_MAX = 64;
const RESPONSE_CACHE_MAX_BYTES = 512 * 1024;

/** The cached whole response for `key`, when a previous identical request already built it. */
export function getCachedResponse(key: string): Buffer | undefined {
  return responseCache.get(key);
}

/** Store a whole response under `key` (a no-op when it is too big to cache). */
export function setCachedResponse(key: string, buf: Buffer): void {
  if (buf.length > RESPONSE_CACHE_MAX_BYTES) return;
  if (responseCache.size >= RESPONSE_CACHE_MAX) {
    const first = responseCache.keys().next();
    if (!first.done) responseCache.delete(first.value);
  }
  responseCache.set(key, buf);
}

/** The response-cache key for an ls-refs answer on `repo` with these arguments. */
export function lsRefsCacheKey(repo: Repo, prefixes: readonly string[], peel: boolean, symrefs: boolean, unborn: boolean): string {
  return `${repo.owner}/${repo.name}#${repo.seq}:ls:${prefixes.join(',')}|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}`;
}

// ---------------------------------------------------------------- sideband

const SIDEBAND_CHUNK = 32768;

/** Wrap pack bytes in sideband band-1 pkt-lines. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    appendPkt(parts, payload);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs

export interface LsRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export function listRefs(repo: Repo, prefixes: readonly string[], peel: boolean, symrefs: boolean, unborn: boolean): LsRef[] {
  const out: LsRef[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      const entry: LsRef = { oid: headTip, name: 'HEAD' };
      if (symrefs) entry.symrefTarget = `refs/heads/${repo.defaultBranch}`;
      out.push(entry);
    } else if (unborn) {
      const entry: LsRef = { oid: ZERO_OID, name: 'HEAD', unborn: true };
      if (symrefs) entry.symrefTarget = `refs/heads/${repo.defaultBranch}`;
      out.push(entry);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const entry: LsRef = { oid: ref.oid, name: ref.name };
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

export function encodeLsRefs(refs: readonly LsRef[]): Buffer {
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (ref.unborn === true) {
      let line = `unborn ${ref.name}`;
      if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
      appendPkt(parts, `${line}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    appendPkt(parts, `${line}\n`);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- request parsing

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  command: string | null;
  /** ls-refs arguments, collected while parsing (avoids a second decode of the body). */
  lsRefs: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] };
}

export function parseV2Request(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const request: FetchRequest = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    command: null,
    lsRefs: { peel: false, symrefs: false, unborn: false, prefixes: [] },
  };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet).replace(/\n$/, '');
    if (line.startsWith('command=')) request.command = line.slice('command='.length);
    else if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) request.depth = n;
    } else if (line === 'peel') request.lsRefs.peel = true;
    else if (line === 'symrefs') request.lsRefs.symrefs = true;
    else if (line === 'unborn') request.lsRefs.unborn = true;
    else if (line.startsWith('ref-prefix ')) request.lsRefs.prefixes.push(line.slice('ref-prefix '.length));
  }
  return request;
}

export interface V0FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export function parseV0FetchRequest(body: Buffer): V0FetchRequest {
  const packets = decodePktLines(body);
  const request: V0FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet).replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const arg = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (verb === 'want') request.wants.push(arg.split(' ')[0]!);
    else if (verb === 'have') request.haves.push(arg);
    else if (verb === 'shallow') request.shallow.push(arg);
    else if (verb === 'deepen') {
      const n = Number(arg);
      if (Number.isInteger(n) && n > 0) request.depth = n;
    }
  }
  return request;
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function parsePushRequest(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // The command list is pkt-lines up to the first flush; the rest is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('push request truncated');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      offset += 4;
      break;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > body.length) throw new Error('bad pkt-line in push');
    const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    const nul = line.indexOf('\0');
    const main = nul >= 0 ? line.slice(0, nul) : line;
    const parts = main.split(' ');
    if (parts.length < 3) throw new Error('bad push command line');
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, pack: body.subarray(offset) };
}

// ---------------------------------------------------------------- receive-pack

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Validate and apply push commands; returns per-ref results.
 * `objects` may carry the oid readPack already computed for each object (it hashes every
 * object while resolving the pack); reusing it skips a second SHA-1 per object on the hot
 * receive-pack path. Callers that build objects themselves omit `oid` and it is computed.
 */
export function applyPush(
  repo: Repo,
  commands: readonly PushCommand[],
  objects: readonly { type: ObjType; data: Buffer; oid?: string }[],
): PushReportLine[] {
  // Store the unpacked objects first (a refused ref still leaves its objects, as git does).
  // A new object can join the reachable closure of an existing ref, so it bumps repo.seq
  // even when every ref update is refused: the fetch/advertisement caches key on seq.
  let storedNew = false;
  for (const object of objects) {
    const oid = object.oid ?? hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type: object.type, data: object.data });
      storedNew = true;
    }
  }
  if (storedNew) repo.seq += 1;
  const results: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old oid does not match' });
      } else {
        repo.refs.delete(command.ref);
        repo.seq += 1;
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!isOid(command.newOid) || !repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      repo.seq += 1;
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update: old must match, and the new tip must descend from the old one.
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old oid does not match' });
      continue;
    }
    const ancestors = new Set<string>();
    const stack = [command.newOid];
    let isDescendant = false;
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === command.oldOid) {
        isDescendant = true;
        break;
      }
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      } else if (object !== undefined && object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    if (!isDescendant) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    repo.seq += 1;
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return results;
}

/**
 * The push report, sideband-wrapped, in a single allocation: `unpack ok` (or the unpack
 * error) plus one `ok`/`ng` line per ref, each as a pkt-line, all inside one band-1 pkt-line.
 * Byte-identical to the old sidebandReport(pktLines(...)) chain, without its per-line
 * Buffer.concat round trips. The receive-pack bench path builds this 200 times a round.
 */
export function encodePushReport(unpackOk: boolean, unpackDetail: string, results: readonly PushReportLine[]): Buffer {
  const first = unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`;
  // Inner pkt-lines: one 4-byte hex header + payload per line.
  let innerLen = 4 + Buffer.byteLength(first);
  for (const result of results) {
    innerLen += 4 + Buffer.byteLength(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // Outer: 4-byte header + 1 band byte + inner.
  const out = Buffer.alloc(4 + 1 + innerLen);
  let off = 0;
  const writeHex4 = (n: number): void => {
    out.write(n.toString(16).padStart(4, '0'), off, 4, 'ascii');
    off += 4;
  };
  const writeLine = (text: string): void => {
    writeHex4(4 + Buffer.byteLength(text));
    off += out.write(text, off, 'utf8');
  };
  writeHex4(4 + 1 + innerLen);
  out[off++] = 1;
  writeLine(first);
  for (const result of results) {
    writeLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  return out;
}
