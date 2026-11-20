// store.ts — the forge's in-memory state: git objects, refs, repositories, issues, pull requests.
//
// Everything lives in memory: one trial is one process, and the suite drives it as a client.
// Responses are deterministic: no clock and no randomness enter any stored value (timestamps are
// a fixed base plus a per-process counter), so two runs over the same requests answer identically.
//
// The viewer is the scenario's token owner. The scenario is fixed by the kit's seed
// (wire.ts SCENARIO_SEED 0x6a09e667f3bcc909n, the same in every practice trial and in grading):
// viewer login "adaiversen", id 1000. Verified by running the kit's own buildScenario().

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- identity

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

/** Fixed base timestamp (2025-01-01T00:00:00Z) for every timestamp the forge writes. */
export const FIXED_EPOCH = 1735689600;

const SHA40 = /^[0-9a-f]{40}$/;
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && SHA40.test(value);
}

// ---------------------------------------------------------------- git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits / tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author?: string;
  committer?: string;
  timestamp?: number;
  message: string;
}): Buffer {
  const ts = fields.timestamp ?? FIXED_EPOCH;
  const who = `${fields.author ?? VIEWER_IDENTITY} ${ts} +0000`;
  const committer = `${fields.committer ?? VIEWER_IDENTITY} ${ts} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const headers = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message,
  };
}

// ---------------------------------------------------------------- packs

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint truncated');
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) copyOffset |= delta[offset++]! << (8 * i);
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) copySize |= delta[offset++]! << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length || written + op > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/** Inflate one zlib stream starting at `offset`; returns the data and the bytes consumed. */
function inflateOne(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** Read a pack (v2/v3): plain objects plus ofs-delta / ref-delta, resolved against `lookup`. */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  interface Raw {
    offset: number;
    type: ObjType | null;
    data: Buffer;
    delta: { kind: 'ofs' | 'ref'; base: string | number } | null;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let delta: Raw['delta'] = null;
    let type: ObjType | null = null;
    if (typeCode === 6) {
      byte = pack[offset++]!;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      delta = { kind: 'ofs', base: start - baseOffset };
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      delta = { kind: 'ref', base: baseOid };
    } else {
      const resolved = CODE_TYPE[typeCode];
      if (resolved === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      type = resolved;
    }
    const { data, consumed } = inflateOne(pack, offset);
    if (data.length !== size) throw new Error(`pack object at ${start} declares ${size} bytes, inflated ${data.length}`);
    offset += consumed;
    byOffset.set(start, raw.length);
    raw.push({ offset: start, type, data, delta });
  }
  const resolved: PackEntry[] = new Array(raw.length);
  const resolving = new Set<number>();
  // Plain objects' oids, built once and only when a ref-delta needs a base lookup: the
  // old findIndex re-hashed every plain object for every ref-delta (O(n) hashes each).
  let plainOidIndex: Map<string, number> | null = null;
  const oidIndex = (): Map<string, number> => {
    if (plainOidIndex === null) {
      plainOidIndex = new Map<string, number>();
      for (let i = 0; i < raw.length; i += 1) {
        const candidate = raw[i]!;
        if (candidate.delta === null) plainOidIndex.set(hashObject(candidate.type!, candidate.data), i);
      }
    }
    return plainOidIndex;
  };
  const resolve = (index: number): PackEntry => {
    const done = resolved[index];
    if (done !== undefined) return done;
    if (resolving.has(index)) throw new Error('delta cycle in pack');
    resolving.add(index);
    const entry = raw[index]!;
    let out: PackEntry;
    if (entry.delta === null) {
      out = { type: entry.type!, data: entry.data, oid: hashObject(entry.type!, entry.data) };
    } else {
      let base: PackEntry;
      if (entry.delta.kind === 'ofs') {
        const baseIndex = byOffset.get(entry.delta.base as number);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseIndex);
      } else {
        const baseOid = entry.delta.base as string;
        const inPack = oidIndex().get(baseOid);
        if (inPack !== undefined) base = resolve(inPack);
        else {
          const external = lookup?.(baseOid);
          if (external === undefined) throw new Error(`ref-delta base ${baseOid} not available`);
          base = { type: external.type, data: external.data, oid: baseOid };
        }
      }
      const data = applyDelta(base.data, entry.data);
      out = { type: base.type, data, oid: hashObject(base.type, data) };
    }
    resolving.delete(index);
    resolved[index] = out;
    return out;
  };
  for (let i = 0; i < raw.length; i += 1) resolve(i);
  return resolved;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const first = (code << 4) | (size & 0x0f);
  size >>= 4;
  const bytes = [size === 0 ? first : first | 0x80];
  while (size !== 0) {
    const next = size & 0x7f;
    size >>= 7;
    bytes.push(size === 0 ? next : next | 0x80);
  }
  return Buffer.from(bytes);
}

/** Write a pack (v2, plain objects, no deltas) with the SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- object graph

/** All objects reachable from `tips` (commits, their trees/blobs, tag targets, parents). */
export function collectReachable(
  objects: Map<string, GitObject>,
  tips: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Peel a tag (recursively) to the commit it points at. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Commits reachable from `tips`, newest-first by discovery (parents after children). */
export function collectCommits(objects: Map<string, GitObject>, tips: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

/** The nearest common ancestor of two commits (first found walking both sides), or null. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set(collectCommits(objects, [a]));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

/** Flat file map of a tree: path -> {oid, mode}. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, path: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const full = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, full);
      else out.set(full, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Look up one path in a tree; returns the blob oid (or the tree oid for a directory), or null. */
export function lookupPath(objects: Map<string, GitObject>, treeOid: string, path: string): { oid: string; mode: string } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    current = entry.oid;
  }
  return null;
}

/** List the direct children of a directory path in a tree. */
export function listDir(objects: Map<string, GitObject>, treeOid: string, path: string): TreeEntry[] | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = objects.get(current);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/** Replace one file in a tree (creating parent dirs as needed); returns the new root tree oid. */
export function setPath(
  objects: Map<string, GitObject>,
  treeOid: string | null,
  path: string,
  blobOid: string | null,
): string {
  const segments = path.split('/').filter((s) => s !== '');
  const build = (tree: string | null, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (tree !== null) {
      const object = objects.get(tree);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth]!;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
      const next = build(childTree, depth + 1);
      const nextObject = objects.get(next);
      if (nextObject !== undefined && nextObject.type === 'tree' && parseTree(nextObject.data).length === 0) {
        entries.delete(name);
      } else {
        entries.set(name, { mode: '40000', name, oid: next });
      }
    }
    return putObject(objects, 'tree', buildTree([...entries.values()]));
  };
  return build(treeOid, 0);
}

// ---------------------------------------------------------------- domain model

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  /**
   * Cached JSON text of issueJson() plus its byte length, for the hot single-issue GET:
   * the bench reads one issue 2,000 times without mutating it. Cleared on any mutation
   * (PATCH, comment add); the shape is fully determined by the issue's own fields.
   */
  cachedJson: string | null;
  cachedJsonLen: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  private: boolean;
  databaseId: number;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextDbId = 1;
  private commitCounter = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      name,
      owner,
      description,
      private: isPrivate,
      databaseId: this.nextDbId++,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  /** A deterministic timestamp for a new commit: fixed base + a per-process counter. */
  nextTimestamp(): number {
    this.commitCounter += 1;
    return FIXED_EPOCH + this.commitCounter;
  }

  /** The ref a branch name resolves to, or null when it does not exist. */
  refTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }
}

// ---------------------------------------------------------------- global ids

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(dbId: number): string {
  return b64url(`Repository:${dbId}`);
}
export function issueGlobalId(dbId: number, number: number): string {
  return b64url(`Issue:${dbId}:${number}`);
}
export function pullGlobalId(dbId: number, number: number): string {
  return b64url(`PullRequest:${dbId}:${number}`);
}
export function commentGlobalId(dbId: number, issueNumber: number, commentId: number): string {
  return b64url(`IssueComment:${dbId}:${issueNumber}:${commentId}`);
}

/** Decode a global id into {kind, dbId, number?, commentId?}, or null. */
export function decodeGlobalId(id: string): { kind: string; dbId: number; number: number; commentId: number } | null {
  const text = unb64url(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0]!;
  const dbId = Number(parts[1]);
  if (!Number.isInteger(dbId) || dbId <= 0) return null;
  return {
    kind,
    dbId,
    number: parts.length >= 3 ? Number(parts[2]) : 0,
    commentId: parts.length >= 4 ? Number(parts[3]) : 0,
  };
}

export function findRepoByDbId(store: Store, dbId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.databaseId === dbId) return repo;
  return undefined;
}
