# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Aethervanguard/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Aethervanguard/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only — no
dependencies, no git binary, no UI.

## What it serves

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 advertisement, ls-refs,
  fetch (full, incremental, shallow/deepen), and v0 receive-pack push with
  report-status. Pack codec (plain objects, ofs/ref deltas on read) is implemented
  on `node:zlib` / `node:crypto`.
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels, issues,
  comments, pull requests and squash merges, with GitHub-shaped errors
  (401/404/409/422) and `X-GitHub-Request-Id` on every reply.
- **GraphQL** (`/api/graphql`): the `viewer`, `repository`, `issue`, `issues`,
  `pullRequests`, `pullRequest`, `node` and `__type` reads plus `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment`
  mutations, with opaque Relay global ids and cursor pagination. Batching
  (several operations in one body) is answered in order.
- **MCP** (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, modern era (`server/discover`,
  revision 2026-07-28) with a legacy `initialize` fallback, and six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) backed by the same store as REST
  and GraphQL, so an object created on one surface is the same object on the others.

## Layout

- `main.ts` — the entry ↔ env lifecycle (rewritten in the agent's own words):
  bind an ephemeral port, register it, poll `/done`, exit 0.
- `app.ts` — the HTTP server and routing (`createApp()`), plus the git smart-HTTP
  glue.
- `store.ts` — the in-memory store: git objects (SHA-1, trees, commits, tags,
  packs), repositories, issues, pull requests, global ids.
- `git.ts` — pkt-line codec, v0/v2 advertisements, fetch planning, pack cache,
  sideband framing, push validation (fast-forward only).
- `rest.ts` — the REST v3 handlers and the squash-merge engine.
- `graphql.ts` — the fixed-document GraphQL executor.
- `mcp.ts` — the MCP endpoint and its six tools.

## Run

```sh
node --experimental-strip-types main.ts   # grading lifecycle (needs MAKEFUN_ENV_URL)
node --experimental-strip-types app.ts --port=18080   # local testing
```

State is in memory and deterministic: no clock, no randomness in responses
(commit timestamps advance from a fixed epoch by a counter), so two runs with
the same requests produce the same exported state.
