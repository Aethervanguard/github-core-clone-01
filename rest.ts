// rest.ts — GitHub REST v3 (/api/v3): repositories, branches, commits, contents, issues,
// comments, labels, pull requests and merges. Every reply is JSON; errors carry {message}.

import {
  buildCommit,
  collectCommits,
  flattenTree,
  isOid,
  listDir,
  lookupPath,
  mergeBase,
  parseCommit,
  putObject,
  setPath,
  FIXED_EPOCH,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  VIEWER_EMAIL,
  type GitObject,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  /** Read-only query access; a URLSearchParams or the lazy parser in app.ts. */
  query: { get(name: string): string | null };
  body: unknown;
  host: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Pre-serialized JSON text: app.ts sends it verbatim (no second stringify). */
  rawJson?: string;
  /** Byte length of rawJson, so app.ts skips Buffer.byteLength. */
  rawJsonLen?: number;
}

const FIXED_ISO = new Date(FIXED_EPOCH * 1000).toISOString();

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pagination(req: RestRequest): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? 1) || 1);
  return { page, perPage };
}

function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: RestRequest, path: string, page: number, perPage: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const base = `http://${req.host}/api/v3${path}`;
  return { link: `<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"` };
}

// ---------------------------------------------------------------- shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repoGlobalIdOf(repo),
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    has_issues: true,
  };
}

function repoGlobalIdOf(repo: Repo): string {
  // Imported lazily to avoid a cycle: the id is just the base64 of "Repository:<dbId>".
  return Buffer.from(`Repository:${repo.databaseId}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalIdOf(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

/** The issue's JSON text, cached on the issue and invalidated on mutation. */
export function issueJsonText(repo: Repo, issue: Issue): string {
  if (issue.cachedJson !== null) return issue.cachedJson;
  const text = JSON.stringify(issueJson(repo, issue));
  issue.cachedJson = text;
  issue.cachedJsonLen = Buffer.byteLength(text);
  return text;
}

function issueGlobalIdOf(repo: Repo, number: number): string {
  return Buffer.from(`Issue:${repo.databaseId}:${number}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pullGlobalIdOf(repo: Repo, number: number): string {
  return Buffer.from(`PullRequest:${repo.databaseId}:${number}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: pullGlobalIdOf(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: headSha },
    base: { ref: pull.base, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

// ---------------------------------------------------------------- git helpers for contents / merges

/** Create a commit on `branch` applying file changes; returns the new commit oid. */
function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  changes: ReadonlyArray<{ path: string; blobOid: string | null }>,
): { commit: string; isNew: boolean } {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  let tree: string | null = null;
  const parents: string[] = [];
  if (tip !== null) {
    const commit = repo.objects.get(tip);
    if (commit !== undefined && commit.type === 'commit') {
      tree = parseCommit(commit.data).tree;
      parents.push(tip);
    }
  }
  for (const change of changes) {
    tree = setPath(repo.objects, tree, change.path, change.blobOid);
  }
  const commitData = buildCommit({
    tree: tree ?? putObject(repo.objects, 'tree', Buffer.alloc(0)),
    parents,
    timestamp: store.nextTimestamp(),
    message,
  });
  const commit = putObject(repo.objects, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commit);
  repo.seq += 1;
  return { commit, isNew: tip === null };
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees (flat maps) into file changes. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo.objects, baseTree);
  const head = flattenTree(repo.objects, headTree);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (old === undefined) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (old.oid !== entry.oid) changes.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

function lineCount(objects: Map<string, GitObject>, oid: string | null): number {
  if (oid === null) return 0;
  const object = objects.get(oid);
  if (object === undefined || object.type !== 'blob') return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const headCommit = repo.objects.get(pull.headSha);
  if (headCommit === undefined || headCommit.type !== 'commit') return [];
  const baseCommit = repo.objects.get(pull.baseSha);
  const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
  const headTree = parseCommit(headCommit.data).tree;
  // The diff the suite reads is merge-base -> head; with a linear history base == merge-base.
  const mergeBaseOid = baseTree !== null ? mergeBase(repo.objects, pull.headSha, pull.baseSha) : null;
  const fromTree =
    mergeBaseOid !== null
      ? parseCommit(repo.objects.get(mergeBaseOid)!.data).tree
      : baseTree;
  if (fromTree === null) return [];
  return diffTrees(repo, fromTree, headTree).map((change) => {
    const additions = change.status === 'removed' ? 0 : lineCount(repo.objects, change.newOid);
    const deletions = change.status === 'added' ? 0 : lineCount(repo.objects, change.oldOid);
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
}

/** Squash-merge a pull request; returns the merge commit oid, or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headCommit = repo.objects.get(pull.headSha);
  // The merge runs against the CURRENT base tip, not the tip recorded when the pull
  // request was opened: another pull request may have moved the base since.
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const baseCommit = repo.objects.get(baseSha);
  if (headCommit === undefined || baseCommit === undefined) return null;
  const headTree = parseCommit(headCommit.data).tree;
  const baseTree = parseCommit(baseCommit.data).tree;
  const baseOid = mergeBase(repo.objects, pull.headSha, baseSha);
  const mergeBaseTree = baseOid !== null ? parseCommit(repo.objects.get(baseOid)!.data).tree : baseTree;
  const headChanges = diffTrees(repo, mergeBaseTree, headTree);
  const baseChanges = diffTrees(repo, mergeBaseTree, baseTree);
  const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
  for (const change of headChanges) {
    const other = baseByPath.get(change.path);
    if (other !== undefined && other.newOid !== change.newOid) return null;
  }
  let tree: string | null = baseTree;
  for (const change of headChanges) {
    tree = setPath(repo.objects, tree, change.path, change.newOid);
  }
  const commitData = buildCommit({
    tree: tree ?? baseTree,
    parents: [baseSha],
    timestamp: store.nextTimestamp(),
    message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`,
  });
  const mergeCommit = putObject(repo.objects, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
  repo.seq += 1;
  return mergeCommit;
}

// ---------------------------------------------------------------- router

export function handleRest(store: Store, req: RestRequest): RestResult {
  const seg = req.segments;
  const method = req.method;

  // GET /api/v3/ — the API root.
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return { status: 200, body: { installed_version: '1.0.0' } };
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return { status: 200, body: { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' } };
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pagination(req);
      const all = store.listRepos(VIEWER_LOGIN);
      const items = pageOf(all, page, perPage);
      return {
        status: 200,
        body: items.map(repoJson),
        headers: linkHeader(req, '/user/repos', page, perPage, page * perPage < all.length),
      };
    }
    if (method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Repository name is invalid');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      return { status: 201, body: repoJson(repo) };
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1]!);
    const name = decodeURIComponent(seg[2]!);
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return err(404, 'Not Found');
    const rest = seg.slice(3);
    return handleRepo(store, req, repo, rest);
  }

  return err(404, 'Not Found');
}

function handleRepo(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  const method = req.method;

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const body = isRecord(req.body) ? req.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0]!;

  // GET /repos/{o}/{r}/branches[/{branch}]
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      return {
        status: 200,
        body: branches.map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) } })),
      };
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1]!);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      return { status: 200, body: { name: branch, commit: { sha: tip } } };
    }
    return err(404, 'Not Found');
  }

  // GET /repos/{o}/{r}/commits
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const branch = req.query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return err(404, 'Not Found');
      const commits = collectCommits(repo.objects, [tip]);
      return {
        status: 200,
        body: commits.map((oid) => {
          const view = parseCommit(repo.objects.get(oid)!.data);
          // GitHub's API presents the message without the commit object's trailing newline.
          const message = view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message;
          return {
            sha: oid,
            commit: {
              message,
              author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
              committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
            },
          };
        }),
      };
    }
    return err(404, 'Not Found');
  }

  // /repos/{o}/{r}/git/refs...
  if (head === 'git') {
    if (rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = isRecord(req.body) ? req.body : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/heads/') || !isOid(sha)) return err(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (object === undefined) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        repo.seq += 1;
        return { status: 201, body: { ref, object: { sha, type: object.type } } };
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).map(decodeURIComponent).join('/');
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } } };
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // /repos/{o}/{r}/contents/{path...}
  if (head === 'contents') {
    return handleContents(store, req, repo, rest.slice(1).map(decodeURIComponent).join('/'));
  }

  // /repos/{o}/{r}/labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = isRecord(req.body) ? req.body : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return err(422, 'Label name is required');
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
      return { status: 201, body: labelJson(repo.labels.get(name)!) };
    }
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.values()].map(labelJson) };
    }
    return err(404, 'Not Found');
  }

  // /repos/{o}/{r}/issues...
  if (head === 'issues') {
    return handleIssues(store, req, repo, rest.slice(1));
  }

  // /repos/{o}/{r}/pulls...
  if (head === 'pulls') {
    return handlePulls(store, req, repo, rest.slice(1));
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function handleContents(store: Store, req: RestRequest, repo: Repo, path: string): RestResult {
  const method = req.method;
  if (method === 'GET') {
    const tip = resolveRef(repo, req.query.get('ref'));
    if (tip === null) return err(404, 'Not Found');
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return err(404, 'Not Found');
    const tree = parseCommit(commit.data).tree;
    if (path === '') {
      const entries = listDir(repo.objects, tree, '') ?? [];
      return { status: 200, body: entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid })) };
    }
    const found = lookupPath(repo.objects, tree, path);
    if (found === null) return err(404, 'Not Found');
    if (found.mode === '40000') {
      const entries = listDir(repo.objects, tree, path) ?? [];
      return {
        status: 200,
        body: entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: `${path}/${e.name}`,
          sha: e.oid,
        })),
      };
    }
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) return err(404, 'Not Found');
    const name = path.split('/').pop() ?? path;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: found.oid,
        size: blob.data.length,
        name,
        path,
      },
    };
  }

  if (method === 'PUT') {
    const body = isRecord(req.body) ? req.body : {};
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    } catch {
      return err(422, 'Content is not valid base64');
    }
    const tip = repo.refs.get(`refs/heads/${branch}`);
    let tree: string | null = null;
    if (tip !== undefined) {
      const commit = repo.objects.get(tip);
      if (commit !== undefined && commit.type === 'commit') tree = parseCommit(commit.data).tree;
    }
    const existing = tree !== null ? lookupPath(repo.objects, tree, path) : null;
    if (existing !== null) {
      if (sha === undefined) return err(422, 'File already exists');
      if (sha !== existing.oid) return err(409, 'sha does not match the current blob');
    } else if (sha !== undefined) {
      return err(422, 'File does not exist');
    }
    const blobOid = putObject(repo.objects, 'blob', content);
    const { commit, isNew } = commitFiles(store, repo, branch, message, [{ path, blobOid }]);
    return {
      status: existing === null ? 201 : 200,
      body: { content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commit } },
    };
  }

  if (method === 'DELETE') {
    const body = isRecord(req.body) ? req.body : {};
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return err(404, 'Not Found');
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return err(404, 'Not Found');
    const tree = parseCommit(commit.data).tree;
    const existing = lookupPath(repo.objects, tree, path);
    if (existing === null || existing.mode === '40000') return err(404, 'Not Found');
    if (sha !== undefined && sha !== existing.oid) return err(409, 'sha does not match the current blob');
    const { commit: newCommit } = commitFiles(store, repo, branch, message, [{ path, blobOid: null }]);
    return { status: 200, body: { commit: { sha: newCommit } } };
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function handleIssues(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
      }
      const issue: Issue = {
        number: repo.nextIssue++,
        title,
        body: issueBody,
        state: 'open',
        labels,
        comments: [],
        seq: ++repo.seq,
        cachedJson: null,
        cachedJsonLen: 0,
      };
      repo.issues.push(issue);
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const { page, perPage } = pagination(req);
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const items = pageOf(list, page, perPage);
      return {
        status: 200,
        body: items.map((issue) => issueJson(repo, issue)),
        headers: linkHeader(req, `/repos/${repo.owner}/${repo.name}/issues`, page, perPage, page * perPage < list.length),
      };
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') {
      const text = issueJsonText(repo, issue);
      return { status: 200, body: null, rawJson: text, rawJsonLen: issue.cachedJsonLen };
    }
    if (method === 'PATCH') {
      const body = isRecord(req.body) ? req.body : {};
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.cachedJson = null;
      issue.cachedJsonLen = 0;
      const text = issueJsonText(repo, issue);
      return { status: 200, body: null, rawJson: text, rawJsonLen: issue.cachedJsonLen };
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const text = typeof body.body === 'string' ? body.body : '';
      const comment: { id: number; body: string } = { id: repo.nextComment++, body: text };
      issue.comments.push(comment);
      issue.cachedJson = null;
      issue.cachedJsonLen = 0;
      return {
        status: 201,
        body: { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FIXED_ISO },
      };
    }
    if (method === 'GET') {
      return {
        status: 200,
        body: issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
          created_at: FIXED_ISO,
        })),
      };
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePulls(store: Store, req: RestRequest, repo: Repo, rest: string[]): RestResult {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      const title = typeof body.title === 'string' ? body.title : '';
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'Head or base branch does not exist');
      const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
      if (existing !== undefined) return err(422, 'A pull request already exists for this branch');
      const pull: Pull = {
        number: repo.nextPull++,
        title,
        body: pullBody,
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
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const { page, perPage } = pagination(req);
      const state = req.query.get('state') ?? 'open';
      const list = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.seq - a.seq);
      const items = pageOf(list, page, perPage);
      return {
        status: 200,
        body: items.map((pull) => pullJson(repo, pull)),
        headers: linkHeader(req, `/repos/${repo.owner}/${repo.name}/pulls`, page, perPage, page * perPage < list.length),
      };
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method === 'GET') return { status: 200, body: pullFiles(repo, pull) };
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method === 'PUT') {
      if (pull.state !== 'open') return err(405, 'Pull request is not open');
      const merged = squashMerge(store, repo, pull);
      if (merged === null) return err(405, 'Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = FIXED_ISO;
      pull.mergeCommitSha = merged;
      pull.baseSha = merged;
      return { status: 200, body: { merged: true, sha: merged, message: `Pull request #${pull.number} merged` } };
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
