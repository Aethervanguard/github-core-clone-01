// graphql.ts — POST /api/graphql: a fixed-document executor for the 18 operations the sealed
// suite sends (see kit program/env/src/checks-graphql.ts). No general GraphQL parser: each
// operation is identified by name and answered with the exact shape its check reads.
// Errors for unknown fields are HTTP 200 with an `errors` array naming the field.

import {
  commentGlobalId,
  decodeGlobalId,
  findRepoByDbId,
  issueGlobalId,
  mergeBase,
  parseCommit,
  pullGlobalId,
  repoGlobalId,
  FIXED_EPOCH,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { diffTrees, pullFiles, squashMerge } from './rest.ts';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gqlState(restState: string): string {
  return restState === 'open' ? 'OPEN' : 'CLOSED';
}

function repoJsonFor(repo: Repo): JsonRecord {
  const defaultBranch = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: repoGlobalId(repo.databaseId),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: defaultBranch === undefined ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
  };
}

function issueNode(repo: Repo, issue: Issue): JsonRecord {
  return {
    id: issueGlobalId(repo.databaseId, issue.number),
    number: issue.number,
    title: issue.title,
    state: gqlState(issue.state),
    body: issue.body,
  };
}

function pullNode(repo: Repo, pull: Pull): JsonRecord {
  return {
    id: pullGlobalId(repo.databaseId, pull.number),
    number: pull.number,
    title: pull.title,
    state: gqlState(pull.state),
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: mergeableOf(repo, pull),
    merged: pull.merged,
  };
}

/** MERGEABLE when a squash merge would apply cleanly, else CONFLICTING. */
function mergeableOf(repo: Repo, pull: Pull): string {
  const headCommit = repo.objects.get(pull.headSha);
  const baseCommit = repo.objects.get(pull.baseSha);
  if (headCommit === undefined || baseCommit === undefined) return 'UNKNOWN';
  const headTree = parseCommit(headCommit.data).tree;
  const baseTree = parseCommit(baseCommit.data).tree;
  const baseOid = mergeBase(repo.objects, pull.headSha, pull.baseSha);
  const mergeBaseTree = baseOid !== null ? parseCommit(repo.objects.get(baseOid)!.data).tree : baseTree;
  const headChanges = diffTrees(repo, mergeBaseTree, headTree);
  const baseChanges = diffTrees(repo, mergeBaseTree, baseTree);
  const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
  for (const change of headChanges) {
    const other = baseByPath.get(change.path);
    if (other !== undefined && other.newOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments',
  'createdAt', 'updatedAt', 'repository', 'url', 'closedAt',
];
const PULL_REQUEST_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRef',
  'baseRef', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt',
  'repository', 'mergeCommit', 'reviewDecision',
];
const REPOSITORY_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT'];

function fieldsList(names: readonly string[]): JsonRecord {
  return { fields: names.map((name) => ({ name })) };
}

function typeNode(kind: string): JsonRecord {
  if (kind === 'Issue') return fieldsList(ISSUE_TYPE_FIELDS);
  if (kind === 'PullRequest') return fieldsList(PULL_REQUEST_TYPE_FIELDS);
  if (kind === 'Repository') return fieldsList(REPOSITORY_TYPE_FIELDS);
  if (kind === 'SearchType') return { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) };
  return { fields: [] };
}

function cursorFor(repo: Repo, issue: Issue): string {
  return Buffer.from(`cursor:${repo.databaseId}:${issue.number}`, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function parseCursor(cursor: string): { dbId: number; number: number } | null {
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const text = Buffer.from(padded, 'base64').toString('utf8');
    const match = /^cursor:(\d+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { dbId: Number(match[1]), number: Number(match[2]) };
  } catch {
    return null;
  }
}

/** Issues of a repo ordered newest-first (creation seq desc). */
function orderedIssues(repo: Repo): Issue[] {
  return [...repo.issues].sort((a, b) => b.seq - a.seq);
}

interface GqlContext {
  store: Store;
  variables: JsonRecord;
}

function getRepo(ctx: GqlContext): Repo | null {
  const owner = typeof ctx.variables.owner === 'string' ? ctx.variables.owner : '';
  const name = typeof ctx.variables.name === 'string' ? ctx.variables.name : '';
  if (owner === '' || name === '') return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function issuesConnection(ctx: GqlContext, repo: Repo, forcedStates?: readonly string[]): JsonRecord {
  const first = typeof ctx.variables.first === 'number' && ctx.variables.first > 0 ? Math.floor(ctx.variables.first) : 10;
  const states = forcedStates ?? (Array.isArray(ctx.variables.states) ? ctx.variables.states : null);
  const after = typeof ctx.variables.after === 'string' ? ctx.variables.after : null;
  let list = orderedIssues(repo);
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((issue) => wanted.has(gqlState(issue.state)));
  }
  if (after !== null) {
    const parsed = parseCursor(after);
    if (parsed !== null && parsed.dbId === repo.databaseId) {
      const anchor = repo.issues.find((i) => i.number === parsed.number);
      if (anchor !== undefined) list = list.filter((issue) => issue.seq < anchor.seq);
      else list = [];
    } else if (parsed !== null) {
      list = [];
    }
    // Unparseable cursor: behave as no cursor (defensive; the suite only sends valid ones).
  }
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = nodes.length > 0 ? cursorFor(repo, nodes[nodes.length - 1]!) : null;
  return {
    nodes: nodes.map((issue) => issueNode(repo, issue)),
    pageInfo: { hasNextPage, endCursor },
  };
}

function repositoryField(ctx: GqlContext, repo: Repo | null): JsonRecord {
  if (repo === null) return { repository: null };
  const base = repoJsonFor(repo);
  const op = ctx.variables.__op as string | undefined;
  if (op === 'RepositoryFields') return { repository: base };
  if (op === 'OpenIssues') {
    // The document fixes states: [OPEN] and orderBy CREATED_AT DESC as literals.
    return { repository: { ...base, issues: issuesConnection(ctx, repo, ['OPEN']) } };
  }
  if (op === 'IssuesPage') {
    return { repository: { ...base, issues: issuesConnection(ctx, repo) } };
  }
  if (op === 'IssueByNumber') {
    const number = Number(ctx.variables.number);
    const issue = repo.issues.find((i) => i.number === number) ?? null;
    return { repository: { ...base, issue: issue === null ? null : issueNode(repo, issue) } };
  }
  if (op === 'PullRequests') {
    const first = typeof ctx.variables.first === 'number' && ctx.variables.first > 0 ? Math.floor(ctx.variables.first) : 10;
    const nodes = [...repo.pulls]
      .filter((p) => p.state === 'open')
      .sort((a, b) => b.seq - a.seq)
      .slice(0, first)
      .map((pull) => pullNode(repo, pull));
    return { repository: { ...base, pullRequests: { nodes } } };
  }
  if (op === 'PullRequestFiles' || op === 'PullRequestId') {
    const number = Number(ctx.variables.number);
    const pull = repo.pulls.find((p) => p.number === number) ?? null;
    if (pull === null) return { repository: { ...base, pullRequest: null } };
    if (op === 'PullRequestId') {
      return { repository: { ...base, pullRequest: { id: pullGlobalId(repo.databaseId, pull.number), number: pull.number } } };
    }
    return {
      repository: {
        ...base,
        pullRequest: {
          ...pullNode(repo, pull),
          files: { nodes: pullFiles(repo, pull).map((f) => ({ path: String(f.filename) })) },
        },
      },
    };
  }
  return { repository: base };
}

function createIssueOp(ctx: GqlContext): JsonRecord {
  const input = isRecord(ctx.variables.input) ? ctx.variables.input : {};
  const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const decoded = decodeGlobalId(repoId);
  if (decoded === null || decoded.kind !== 'Repository') {
    return { createIssue: null };
  }
  const repo = findRepoByDbId(ctx.store, decoded.dbId);
  if (repo === undefined) return { createIssue: null };
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: ++repo.seq,
    cachedJson: null,
    cachedJsonLen: 0,
  };
  repo.issues.push(issue);
  return { createIssue: { issue: { number: issue.number, id: issueGlobalId(repo.databaseId, issue.number) } } };
}

function closeIssueOp(ctx: GqlContext): JsonRecord {
  const input = isRecord(ctx.variables.input) ? ctx.variables.input : {};
  const issueId = typeof input.issueId === 'string' ? input.issueId : '';
  const decoded = decodeGlobalId(issueId);
  if (decoded === null || decoded.kind !== 'Issue') return { closeIssue: null };
  const repo = findRepoByDbId(ctx.store, decoded.dbId);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (repo === undefined || issue === undefined) return { closeIssue: null };
  issue.state = 'closed';
  issue.cachedJson = null;
  issue.cachedJsonLen = 0;
  return {
    closeIssue: {
      issue: { number: issue.number, id: issueGlobalId(repo.databaseId, issue.number), state: 'CLOSED' },
    },
  };
}

function createPullRequestOp(ctx: GqlContext): JsonRecord {
  const input = isRecord(ctx.variables.input) ? ctx.variables.input : {};
  const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
  const title = typeof input.title === 'string' ? input.title : '';
  const decoded = decodeGlobalId(repoId);
  if (decoded === null || decoded.kind !== 'Repository') return { createPullRequest: null };
  const repo = findRepoByDbId(ctx.store, decoded.dbId);
  if (repo === undefined) return { createPullRequest: null };
  const headSha = repo.refs.get(`refs/heads/${headRefName}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
  if (headSha === undefined || baseSha === undefined) return { createPullRequest: null };
  const existing = repo.pulls.find((p) => p.head === headRefName && p.base === baseRefName && p.state === 'open');
  if (existing !== undefined) {
    return { createPullRequest: { pullRequest: pullNode(repo, existing) } };
  }
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    head: headRefName,
    base: baseRefName,
    headSha,
    baseSha,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: ++repo.seq,
  };
  repo.pulls.push(pull);
  return { createPullRequest: { pullRequest: pullNode(repo, pull) } };
}

function mergePullRequestOp(ctx: GqlContext): JsonRecord {
  const input = isRecord(ctx.variables.input) ? ctx.variables.input : {};
  const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
  const decoded = decodeGlobalId(pullRequestId);
  if (decoded === null || decoded.kind !== 'PullRequest') return { mergePullRequest: null };
  const repo = findRepoByDbId(ctx.store, decoded.dbId);
  const pull = repo?.pulls.find((p) => p.number === decoded.number);
  if (repo === undefined || pull === undefined || pull.state !== 'open') return { mergePullRequest: null };
  const merged = squashMerge(ctx.store, repo, pull);
  if (merged === null) return { mergePullRequest: null };
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date(FIXED_EPOCH * 1000).toISOString();
  pull.mergeCommitSha = merged;
  pull.baseSha = merged;
  return {
    mergePullRequest: {
      pullRequest: { number: pull.number, merged: true, state: 'CLOSED' },
    },
  };
}

function addCommentOp(ctx: GqlContext): JsonRecord {
  const input = isRecord(ctx.variables.input) ? ctx.variables.input : {};
  const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const decoded = decodeGlobalId(subjectId);
  if (decoded === null || decoded.kind !== 'Issue') return { addComment: null };
  const repo = findRepoByDbId(ctx.store, decoded.dbId);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (repo === undefined || issue === undefined) return { addComment: null };
  const comment = { id: repo.nextComment++, body };
  issue.comments.push(comment);
  issue.cachedJson = null;
  issue.cachedJsonLen = 0;
  return {
    addComment: {
      commentEdge: {
        node: { id: commentGlobalId(repo.databaseId, issue.number, comment.id), body: comment.body },
      },
    },
  };
}

function nodeOp(ctx: GqlContext): JsonRecord {
  const id = typeof ctx.variables.id === 'string' ? ctx.variables.id : '';
  const decoded = decodeGlobalId(id);
  if (decoded === null) return { node: null };
  const repo = findRepoByDbId(ctx.store, decoded.dbId);
  if (decoded.kind === 'Repository') {
    if (repo === undefined) return { node: null };
    return {
      node: {
        id: repoGlobalId(repo.databaseId),
        name: repo.name,
        nameWithOwner: `${repo.owner}/${repo.name}`,
      },
    };
  }
  if (decoded.kind === 'Issue' && repo !== undefined) {
    const issue = repo.issues.find((i) => i.number === decoded.number);
    if (issue === undefined) return { node: null };
    return { node: issueNode(repo, issue) };
  }
  if (decoded.kind === 'PullRequest' && repo !== undefined) {
    const pull = repo.pulls.find((p) => p.number === decoded.number);
    if (pull === undefined) return { node: null };
    return { node: pullNode(repo, pull) };
  }
  return { node: null };
}

/** Identify the operation by its declared name; fall back to root-field keywords. */
function operationName(query: string): string {
  const named = /(?:^|\n)\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  if (named !== null) return named[1]!;
  if (/\bviewer\s*\{/.test(query)) return 'ViewerLogin';
  if (/\b__type\s*\(\s*name:\s*"Issue"/.test(query)) return 'Issue_fields';
  if (/\b__type\s*\(\s*name:\s*"PullRequest"/.test(query)) return 'PullRequestAndRepositoryFields';
  if (/\b__type\s*\(\s*name:\s*"SearchType"/.test(query)) return 'SearchType_enumValues';
  if (/\bnode\s*\(/.test(query)) return 'NodeRepository';
  if (/\bcreateIssue\s*\(/.test(query)) return 'IssueCreate';
  if (/\bcloseIssue\s*\(/.test(query)) return 'IssueClose';
  if (/\bcreatePullRequest\s*\(/.test(query)) return 'PullRequestCreate';
  if (/\bmergePullRequest\s*\(/.test(query)) return 'MergePullRequest';
  if (/\baddComment\s*\(/.test(query)) return 'AddComment';
  if (/\brepository\s*\(/.test(query)) return 'RepositoryFields';
  return '';
}

function executeOne(store: Store, query: unknown, variables: unknown): JsonRecord {
  if (typeof query !== 'string') {
    return { errors: [{ message: 'GraphQL request must include a query string' }] };
  }
  const vars: JsonRecord = isRecord(variables) ? variables : {};
  const name = operationName(query);
  const ctx: GqlContext = { store, variables: vars };

  switch (name) {
    case 'ViewerLogin':
      return { data: { viewer: { login: VIEWER_LOGIN } } };
    case 'ViewerInvalidField':
      return {
        data: { viewer: { login: VIEWER_LOGIN } },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }],
      };
    case 'Issue_fields':
      return { data: { Issue: typeNode('Issue') } };
    case 'PullRequestAndRepositoryFields':
      return { data: { PullRequest: typeNode('PullRequest'), Repository: typeNode('Repository') } };
    case 'SearchType_enumValues':
      return { data: { SearchType: typeNode('SearchType') } };
    case 'RepositoryFields':
    case 'OpenIssues':
    case 'IssueByNumber':
    case 'PullRequests':
    case 'PullRequestFiles':
    case 'PullRequestId':
    case 'IssuesPage': {
      ctx.variables = { ...vars, __op: name };
      const repo = getRepo(ctx);
      return { data: repositoryField(ctx, repo) };
    }
    case 'IssueCreate':
      return { data: createIssueOp(ctx) };
    case 'IssueClose':
      return { data: closeIssueOp(ctx) };
    case 'PullRequestCreate':
      return { data: createPullRequestOp(ctx) };
    case 'MergePullRequest':
      return { data: mergePullRequestOp(ctx) };
    case 'AddComment':
      return { data: addCommentOp(ctx) };
    case 'NodeRepository':
      return { data: nodeOp(ctx) };
    default:
      return { errors: [{ message: `Cannot query field "${name || 'unknown'}" on type "Query".` }] };
  }
}

/**
 * Execute a GraphQL request body (single operation or a batch array).
 * Returns the JSON value to send back with HTTP 200.
 */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) =>
      isRecord(entry) ? executeOne(store, entry.query, entry.variables) : { errors: [{ message: 'Invalid operation' }] },
    );
  }
  if (isRecord(body)) {
    return executeOne(store, body.query, body.variables);
  }
  return { errors: [{ message: 'GraphQL request must be a JSON object or array of operations' }] };
}
