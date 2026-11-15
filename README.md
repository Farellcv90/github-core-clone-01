# github-core-clone

A standalone GitHub-compatible git forge, built from the Node standard library
alone — no `git` binary, no outside service, no dependencies.

## What it serves

- **Smart HTTP git** — `info/refs`, `git-upload-pack`, and `git-receive-pack` for
  `/{owner}/{repo}.git`, protocol v0 and v2, with shallow clone/deepen, fetch
  negotiation, and non-fast-forward refusal. Objects are stored in-memory as
  SHA-1 loose objects and plain-object packs (blobs, trees, commits, annotated
  tags).
- **REST v3** under `/api/v3/` — repos, branches, commits, refs, contents,
  labels, issues and their comments, and pull requests with squash merge.
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node(id:)`,
  issue and pull-request connections with cursors, the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest`, and `addComment`
  mutations, plus `__type` introspection. Opaque Relay ids.
- **MCP** at `/mcp` — JSON-RPC 2.0, modern era `2026-07-28` with
  `server/discover` and `initialize`, exposing six tools: `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Running it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

On boot the server binds an ephemeral port, registers it at the env origin in
`MAKEFUN_ENV_URL` (`POST $MAKEFUN_ENV_URL/register {"port": N}`), and waits. When the trial
itself is done, the registry returns `done: true` and the server exits 0.

An in-memory store holds everything for the lifetime of one trial process, so
state resets on restart. A deterministic logical clock (epoch 2025-01-01,
+1s per event) keeps timestamps stable across reads.

Authentication is a single opaque bearer token: requests to `/api/v3/*`
(except the root), every git endpoint, `/api/graphql`, and `/mcp` require
`Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`. If the variable is unset, any
non-empty bearer is accepted (local development only).

## Layout

- `main.ts` — registry lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — HTTP server and the REST v3 routes.
- `git.ts` — smart HTTP: advertisements, fetch negotiation, ls-refs, receive-pack.
- `forge.ts` — git primitives: objects, trees, commits, tags, pack read/write.
- `store.ts` — the Forge: repos, issues, pull requests, labels, comments.
- `graphql.ts` — the GraphQL parser and executor.
- `mcp.ts` — the MCP JSON-RPC server and tools.
- `http.ts` — shared HTTP helpers.
