// mcp.ts — POST /mcp: Model Context Protocol over Streamable HTTP (JSON-RPC 2.0, plain JSON
// bodies). Modern era (2026-07-28): server/discover answers identity, capabilities and supported
// versions; legacy initialize is answered too for older clients. Six tools, all backed by the
// same Store the REST and GraphQL surfaces use, so an object created over MCP is the same object
// over REST (ids stable).

import {
  FIXED_EPOCH,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { issueJson, pullJson, repoJson, squashMerge } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonRecord;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const FIXED_ISO = new Date(FIXED_EPOCH * 1000).toISOString();

function toolResult(data: unknown): JsonRecord {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolError(message: string): JsonRecord {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOf(store: Store, args: JsonRecord): Repo | undefined {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repo === '') return undefined;
  return store.getRepo(owner, repo);
}

function callTool(store: Store, name: string, args: JsonRecord): { result: JsonRecord } | { error: { code: number; message: string } } {
  const missing = (keys: readonly string[]): string | null => {
    const absent = keys.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    return absent.length > 0 ? `Missing required argument(s): ${absent.join(', ')}` : null;
  };

  switch (name) {
    case 'create_repo': {
      const problem = missing(['name']);
      if (problem !== null) return { error: { code: -32602, message: problem } };
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return { result: toolError('Repository name is invalid') };
      const existing = store.getRepo(VIEWER_LOGIN, repoName);
      if (existing !== undefined) return { result: toolResult(repoJson(existing)) };
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const problem = missing(['owner', 'repo']);
      if (problem !== null) return { error: { code: -32602, message: problem } };
      const repo = repoOf(store, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const problem = missing(['owner', 'repo', 'title']);
      if (problem !== null) return { error: { code: -32602, message: problem } };
      const repo = repoOf(store, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const issue: Issue = {
        number: repo.nextIssue++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: ++repo.seq,
        cachedJson: null,
        cachedJsonLen: 0,
      };
      repo.issues.push(issue);
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const problem = missing(['owner', 'repo']);
      if (problem !== null) return { error: { code: -32602, message: problem } };
      const repo = repoOf(store, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((issue) => issueJson(repo, issue));
      return { result: toolResult({ issues: list }) };
    }
    case 'create_pull_request': {
      const problem = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (problem !== null) return { error: { code: -32602, message: problem } };
      const repo = repoOf(store, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return { result: toolError('Head or base branch does not exist') };
      const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
      if (existing !== undefined) return { result: toolResult(pullJson(repo, existing)) };
      const pull: Pull = {
        number: repo.nextPull++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
        headSha,
        baseSha,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: ++repo.seq,
      };
      repo.pulls.push(pull);
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const problem = missing(['owner', 'repo', 'pull_number']);
      if (problem !== null) return { error: { code: -32602, message: problem } };
      const repo = repoOf(store, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return { result: toolError('Pull request not found') };
      if (pull.state !== 'open') return { result: toolError('Pull request is not open') };
      const merged = squashMerge(store, repo, pull);
      if (merged === null) return { result: toolError('Merge conflict') };
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = FIXED_ISO;
      pull.mergeCommitSha = merged;
      pull.baseSha = merged;
      return { result: toolResult({ merged: true, number: pull.number, state: 'closed', sha: merged }) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function rpcOk(id: unknown, result: unknown): JsonRecord {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): JsonRecord {
  const error: JsonRecord = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Handle one parsed JSON-RPC request body (a single object; batches are answered one by one by
 * the caller). Returns {status, body} — body null means "no response" (a notification).
 */
export function handleMcp(store: Store, body: unknown): { status: number; body: unknown } {
  if (!isRecord(body)) {
    return { status: 200, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = body.id;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};
  const isNotification = id === undefined;

  if (method === '') {
    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request: missing method') };
  }

  // Notifications (no id) never get a JSON-RPC answer.
  if (isNotification) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcOk(id, {
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      }),
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0]!;
    return {
      status: 200,
      body: rpcOk(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcOk(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcOk(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (toolName === '') {
      return { status: 200, body: rpcError(id, -32602, 'Missing tool name') };
    }
    const called = callTool(store, toolName, args);
    if ('error' in called) {
      return { status: 200, body: rpcError(id, called.error.code, called.error.message) };
    }
    return { status: 200, body: rpcOk(id, called.result) };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
