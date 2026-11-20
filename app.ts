// app.ts — the forge's HTTP surface: one Node http server, routing
//   GET  /healthz              the env's boot check: 200 {"ok":true}
//   POST /mcp                 MCP (JSON-RPC 2.0, Streamable HTTP)
//   POST /api/graphql         GraphQL (single operation or a batch array)
//   /api/v3/*                 GitHub REST v3 (Bearer auth; JSON replies)
//   /{owner}/{repo}.git/*     git smart HTTP (v0/v2 upload-pack, v0 receive-pack)
//   anything else             404 JSON
// main.ts (the starter lifecycle) imports createApp() and owns the bind/register/done loop.
// Run directly (`node --experimental-strip-types app.ts --port=18080`) it serves locally
// without MAKEFUN_ENV_URL, for manual testing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseV0Cached,
  advertiseV2Upload,
  appendPkt,
  applyPush,
  cachedFetch,
  computeFetch,
  encodeLsRefs,
  encodePushReport,
  FLUSH,
  DELIM,
  getCachedFetch,
  getCachedResponse,
  listRefs,
  lsRefsCacheKey,
  packCacheKey,
  parsePushRequest,
  parseV0FetchRequest,
  parseV2Request,
  setCachedResponse,
  sidebandPack,
} from './git.ts';
import { readPack, type Repo } from './store.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function hasBearer(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  // Fast path for the usual `Bearer <token>` (no whitespace inside the token); the regex
  // stays as the fallback so exotic-but-valid separators behave exactly as before.
  if (auth.length > 7 && auth.startsWith('Bearer ') && auth.indexOf(' ', 7) === -1 && auth.indexOf('\t', 7) === -1) return true;
  return /^Bearer\s+\S+$/.test(auth);
}

/**
 * The query string, parsed lazily: the hot single-issue GET never touches the query, so
 * building a URLSearchParams for it is pure waste. `get` matches URLSearchParams for the
 * plain-ASCII keys and values the suite sends (first value wins, `+` is a space,
 * percent-decoding, a bare key is ''). Callers only ever use `.get()`.
 */
class LazyQuery {
  private readonly qs: string;
  private readonly memo = new Map<string, string | null>();

  constructor(qs: string) {
    this.qs = qs;
  }

  get(name: string): string | null {
    const hit = this.memo.get(name);
    if (hit !== undefined) return hit;
    let value: string | null = null;
    if (this.qs !== '') {
      const needle = `${name}=`;
      let start = 0;
      for (;;) {
        const amp = this.qs.indexOf('&', start);
        const pair = amp < 0 ? this.qs.slice(start) : this.qs.slice(start, amp);
        if (pair === name) {
          value = '';
          break;
        }
        if (pair.startsWith(needle)) {
          value = decodeQueryValue(pair.slice(needle.length));
          break;
        }
        if (amp < 0) break;
        start = amp + 1;
      }
    }
    this.memo.set(name, value);
    return value;
  }
}

function decodeQueryValue(text: string): string {
  const plus = text.includes('+') ? text.replace(/\+/g, ' ') : text;
  if (!plus.includes('%')) return plus;
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/**
 * Split req.url into pathname + query without `new URL`: the constructor's parsing is
 * ~2µs a request, paid on every one of the read bench's 2,000 GETs. The fast path covers
 * clean absolute paths (everything the suite sends); anything odd (backslash, `//`,
 * dot segments, a fragment) falls back to `new URL` so behaviour is identical.
 */
function parseRequestUrl(rawUrl: string): { pathname: string; query: { get(name: string): string | null } } {
  const q = rawUrl.indexOf('?');
  const pathPart = q < 0 ? rawUrl : rawUrl.slice(0, q);
  if (
    pathPart.startsWith('/') &&
    !pathPart.includes('\\') &&
    !pathPart.includes('//') &&
    !pathPart.includes('/./') &&
    !pathPart.includes('/../') &&
    !pathPart.endsWith('/.') &&
    !pathPart.endsWith('/..') &&
    !pathPart.includes('#')
  ) {
    return { pathname: pathPart, query: new LazyQuery(q < 0 ? '' : rawUrl.slice(q + 1)) };
  }
  const url = new URL(rawUrl, 'http://127.0.0.1');
  return { pathname: url.pathname, query: url.searchParams };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      // Small bodies arrive in one chunk: keep it and skip the Buffer.concat copy.
      if (first === null && chunks.length === 0) first = chunk;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) resolve(first ?? Buffer.alloc(0));
      else {
        if (first !== null) chunks.unshift(first);
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------- git smart HTTP

/** v2 fetch response: acknowledgments / shallow-info / wanted-refs / packfile sections. */
function v2FetchResponse(repo: Repo, request: ReturnType<typeof parseV2Request>): Buffer {
  const key = packCacheKey(repo, request.wants, request.haves, request.shallow, request.depth);
  const hit = getCachedResponse(key);
  if (hit !== undefined) return hit;
  let cached = getCachedFetch(key);
  if (cached === undefined) {
    const plan = computeFetch(repo, request.wants, request.haves, request.shallow, request.depth);
    cached = cachedFetch(repo, plan, key);
  }
  const pack = cached.pack;
  const acks = request.haves.filter((have) => repo.objects.has(have));
  const parts: Buffer[] = [];
  appendPkt(parts, 'acknowledgments\n');
  if (acks.length > 0) {
    for (const ack of acks) appendPkt(parts, `ACK ${ack}\n`);
    appendPkt(parts, 'ready\n');
  } else {
    appendPkt(parts, 'NAK\n');
  }
  parts.push(DELIM);
  appendPkt(parts, 'shallow-info\n');
  for (const oid of cached.shallow) appendPkt(parts, `shallow ${oid}\n`);
  for (const oid of cached.unshallow) appendPkt(parts, `unshallow ${oid}\n`);
  parts.push(DELIM);
  appendPkt(parts, 'wanted-refs\n');
  for (const want of request.wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) appendPkt(parts, `${oid} ${name}\n`);
    }
  }
  parts.push(DELIM);
  appendPkt(parts, 'packfile\n');
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  setCachedResponse(key, out);
  return out;
}

/** v0 fetch response: NAK/ACK + shallow/unshallow lines, then the sideband pack. */
function v0FetchResponse(repo: Repo, request: ReturnType<typeof parseV0FetchRequest>): Buffer {
  const key = packCacheKey(repo, request.wants, request.haves, request.shallow, request.depth);
  const hit = getCachedResponse(key);
  if (hit !== undefined) return hit;
  let cached = getCachedFetch(key);
  if (cached === undefined) {
    const plan = computeFetch(repo, request.wants, request.haves, request.shallow, request.depth);
    cached = cachedFetch(repo, plan, key);
  }
  const pack = cached.pack;
  const acks = request.haves.filter((have) => repo.objects.has(have));
  const parts: Buffer[] = [];
  if (acks.length > 0) {
    for (const ack of acks) appendPkt(parts, `ACK ${ack}\n`);
  } else {
    appendPkt(parts, 'NAK\n');
  }
  for (const oid of cached.shallow) appendPkt(parts, `shallow ${oid}\n`);
  for (const oid of cached.unshallow) appendPkt(parts, `unshallow ${oid}\n`);
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  setCachedResponse(key, out);
  return out;
}

function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, pathname: string, query: { get(name: string): string | null }, body: Buffer): void {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(pathname);
  if (match === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const tail = match[3]!;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Repository not found');
    return;
  }

  try {
    if (req.method === 'GET' && tail === 'info/refs') {
      const service = query.get('service');
      if (service === 'git-upload-pack') {
        const proto = req.headers['git-protocol'];
        const wantsV2 = typeof proto === 'string' && proto.includes('version=2');
        if (wantsV2) {
          sendBuffer(res, 200, advertiseV2Upload(), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBuffer(res, 200, advertiseV0Cached(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertiseV0Cached(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'Unknown service' });
      return;
    }

    if (req.method === 'POST' && tail === 'git-upload-pack') {
      let request;
      try {
        request = parseV2Request(body);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad pkt-line');
        return;
      }
      if (request.command === 'ls-refs') {
        const lsKey = lsRefsCacheKey(repo, request.lsRefs.prefixes, request.lsRefs.peel, request.lsRefs.symrefs, request.lsRefs.unborn);
        let encoded = getCachedResponse(lsKey);
        if (encoded === undefined) {
          const refs = listRefs(repo, request.lsRefs.prefixes, request.lsRefs.peel, request.lsRefs.symrefs, request.lsRefs.unborn);
          encoded = encodeLsRefs(refs);
          setCachedResponse(lsKey, encoded);
        }
        sendBuffer(res, 200, encoded, 'application/x-git-upload-pack-result');
        return;
      }
      if (request.command === 'fetch') {
        sendBuffer(res, 200, v2FetchResponse(repo, request), 'application/x-git-upload-pack-result');
        return;
      }
      // No v2 command: treat it as a v0 fetch.
      let v0;
      try {
        v0 = parseV0FetchRequest(body);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad pkt-line');
        return;
      }
      sendBuffer(res, 200, v0FetchResponse(repo, v0), 'application/x-git-upload-pack-result');
      return;
    }

    if (req.method === 'POST' && tail === 'git-receive-pack') {
      let parsed;
      try {
        parsed = parsePushRequest(body);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad pkt-line');
        return;
      }
      let objects: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer; oid: string }> = [];
      if (parsed.pack.length > 0) {
        try {
          // Reuse the oids readPack already computed: applyPush skips its second SHA-1.
          objects = readPack(parsed.pack).map((entry) => ({ type: entry.type, data: entry.data, oid: entry.oid }));
        } catch {
          sendBuffer(res, 200, encodePushReport(false, 'unpacker error', []), 'application/x-git-receive-pack-result');
          return;
        }
      }
      const results = applyPush(repo, parsed.commands, objects);
      const report = Buffer.concat([encodePushReport(true, '', results), FLUSH]);
      sendBuffer(res, 200, report, 'application/x-git-receive-pack-result');
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  } catch {
    // A malformed git request must never take the server down.
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------- routing

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname, query } = parseRequestUrl(req.url ?? '/');

  // The env's boot check.
  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!hasBearer(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const answered = handleMcp(store, parsed);
    if (answered.body === null) {
      res.writeHead(answered.status);
      res.end();
      return;
    }
    sendJson(res, answered.status, answered.body);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!hasBearer(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
      return;
    }
    sendJson(res, 200, executeGraphQL(store, parsed));
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    requestCounter += 1;
    const extraHeaders = {
      'x-github-request-id': requestCounter.toString(16).padStart(8, '0'),
      'x-oauth-scopes': 'repo, read:org',
    };
    if (!hasBearer(req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, extraHeaders);
      return;
    }
    const segments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
    let parsedBody: unknown;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const body = await readBody(req);
      if (body.length > 0) {
        try {
          parsedBody = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Request body is not valid JSON' }, extraHeaders);
          return;
        }
      }
    }
    let result;
    try {
      result = handleRest(store, { method: req.method ?? 'GET', segments, query, body: parsedBody, host: req.headers.host ?? '127.0.0.1' });
    } catch (err) {
      sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, extraHeaders);
      return;
    }
    if (result.rawJson !== undefined) {
      res.writeHead(result.status, {
        ...extraHeaders,
        'content-type': 'application/json',
        'content-length': result.rawJsonLen ?? Buffer.byteLength(result.rawJson),
      });
      res.end(result.rawJson);
      return;
    }
    if (result.status === 204 || result.body === null) {
      res.writeHead(result.status, extraHeaders);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, { ...extraHeaders, ...(result.headers ?? {}) });
    return;
  }

  // Git smart HTTP.
  if (/^\/[^/]+\/[^/]+\.git\//.test(pathname)) {
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleGit(store, req, res, pathname, query, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server; main.ts owns bind/register/done. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req, res) => {
    handleRequest(store, req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      else res.end();
    });
  });
}

// Local testing: `node --experimental-strip-types app.ts --port=18080` serves without an env.
const argv1 = process.argv[1] ?? '';
if (argv1.endsWith('/app.ts') || argv1.endsWith('\\app.ts') || argv1 === 'app.ts') {
  const portFlag = process.argv.find((a) => a.startsWith('--port='));
  const port = portFlag !== undefined ? Number(portFlag.slice('--port='.length)) : 0;
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    process.stderr.write(`github-core-clone (local) listening on 127.0.0.1:${typeof address === 'object' && address !== null ? address.port : '?'}\n`);
  });
}
