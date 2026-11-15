// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, on one
// process and one in-memory store. Only the standard library; no git binary, no outside
// service. Every reply carries X-GitHub-Request-Id, every REST reply is application/json,
// and every authenticated surface answers 401 without a valid bearer token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, globalId, type Issue, type PullRequest, type Repo } from './store.ts';
import { isOid } from './forge.ts';
import { authed, nextRequestId, parseJsonBody, readBody, sendError, sendJson } from './http.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const FORGE_VERSION = '1.0.0';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// -------------------------------------------------------------------------------------------
// serializers (GitHub-shaped JSON; extra fields are allowed by the suite's shape checks)
// -------------------------------------------------------------------------------------------

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('repo', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues + repo.pulls.filter((pull) => pull.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: globalId('comment', repo.owner, repo.name, label?.id ?? 0),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    default: false,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.userLogin, id: issue.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001, type: 'User' },
    assignee: null,
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('pull', repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: pull.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('comment', repo.owner, repo.name, comment.id),
    body: comment.body,
    user: { login: comment.userLogin, id: comment.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function paginationLink(req: IncomingMessage, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const host = req.headers.host ?? 'localhost';
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  const url = `http://${host}/api/v3/user/repos?${next.toString()}`;
  return `<${url}>; rel="next"`;
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

type RestCtx = {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
};

function getRepoOr404(ctx: RestCtx, owner: string, name: string): Repo | null {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

async function handleRest(ctx: RestCtx): Promise<void> {
  const { req, res, segments } = ctx;
  const method = req.method ?? 'GET';

  // The API root: 200 with the token's scopes. (Kept public, as the starter ships it.)
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (!authed(req)) return sendError(res, 401, 'Requires authentication');

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: globalId('repo', VIEWER_LOGIN, ''),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      avatar_url: '',
      html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    });
  }

  // POST /user/repos — create; GET /user/repos — paginated list of the viewer's repos.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      const created = ctx.forge.createRepo(VIEWER_LOGIN, name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
      });
      if ('error' in created) {
        const status = created.error === 'Repository already exists' ? 422 : 422;
        return sendError(res, status, created.error);
      }
      return sendJson(res, 201, repoJson(ctx.forge, created));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      const all = ctx.forge.creationOrder;
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const link = paginationLink(req, ctx.query, page, perPage, start + perPage < all.length);
      return sendJson(res, 200, slice.map((repo) => repoJson(ctx.forge, repo)), link === null ? {} : { link });
    }
    return sendError(res, 404, 'Not Found');
  }

  // /repos/{owner}/{repo}...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeSegment(segments[1]!);
    const name = decodeSegment(segments[2]!);
    const rest = segments.slice(3);
    return handleRepoRoute(ctx, owner, name, rest);
  }

  return sendError(res, 404, 'Not Found');
}

async function handleRepoRoute(ctx: RestCtx, owner: string, name: string, rest: string[]): Promise<void> {
  const { req, res, forge } = ctx;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return;
      return sendJson(res, 200, repoJson(forge, repo));
    }
    if (method === 'PATCH') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return;
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (typeof body.description === 'string') repo.description = body.description;
      if (body.private === true || body.private === false) repo.private = body.private;
      repo.updatedAt = forge.nowIso();
      return sendJson(res, 200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      if (!forge.deleteRepo(owner, name)) return sendError(res, 404, 'Not Found');
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      return res.end();
    }
    return sendError(res, 404, 'Not Found');
  }

  const repo = getRepoOr404(ctx, owner, name);
  if (repo === null) return;
  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      return sendJson(res, 200, branches.map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false })));
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeSegment(rest[1]!);
      const sha = forge.refTip(repo, branch);
      if (sha === undefined) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
    }
    return sendError(res, 404, 'Not Found');
  }

  if (head === 'commits') {
    if (method !== 'GET' || rest.length > 1) return sendError(res, 404, 'Not Found');
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveRef(repo, ref);
    if (tip === undefined) return sendJson(res, 200, []);
    const history = forge.history(repo, tip);
    return sendJson(
      res,
      200,
      history.map((entry) => ({
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
        },
        author: { login: VIEWER_LOGIN },
        committer: { login: VIEWER_LOGIN },
        parents: [],
      })),
    );
  }

  if (head === 'git') {
    return handleGitDataRoute(ctx, repo, rest.slice(1));
  }

  if (head === 'contents') return handleContentsRoute(ctx, repo, rest.slice(1));
  if (head === 'labels') return handleLabelsRoute(ctx, repo, rest.slice(1));
  if (head === 'issues') return handleIssuesRoute(ctx, repo, rest.slice(1));
  if (head === 'pulls') return handlePullsRoute(ctx, repo, rest.slice(1));

  return sendError(res, 404, 'Not Found');
}

async function handleGitDataRoute(ctx: RestCtx, repo: Repo, rest: string[]): Promise<void> {
  const { req, res, forge } = ctx;
  const method = req.method ?? 'GET';
  // POST /git/refs — create a branch (or tag) at a commit.
  if (rest[0] === 'refs' && rest.length === 1 && method === 'POST') {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
      return sendError(res, 422, 'Invalid ref');
    }
    if (!isOid(sha) || repo.store.get(sha) === undefined) {
      return sendError(res, 422, 'Object does not exist');
    }
    if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, object: { sha, type: repo.store.get(sha)!.type, url: '' } });
  }
  // GET /git/refs/heads/{branch} and /git/refs/{ref...}
  if (rest[0] === 'refs' && rest.length >= 2 && method === 'GET') {
    const ref = `refs/${rest.slice(1).map(decodeSegment).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { ref, object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } });
  }
  return sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

async function handleContentsRoute(ctx: RestCtx, repo: Repo, rest: string[]): Promise<void> {
  const { req, res, forge } = ctx;
  const method = req.method ?? 'GET';
  const filePath = rest.map(decodeSegment).join('/');
  const ref = ctx.query.get('ref') ?? undefined;

  if (method === 'PUT') {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    if (filePath === '' || contentB64 === '') return sendError(res, 422, 'content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return sendError(res, 422, 'content is not valid base64');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = forge.refTip(repo, branch);
    const existing = tip === undefined ? null : forge.filesAt(repo, tip)?.get(filePath) ?? null;
    if (existing !== null) {
      if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return sendError(res, 409, 'sha does not match the current blob');
      }
      const { commitSha, contentShaByPath } = forge.commitFiles(repo, branch, new Map([[filePath, content]]), message);
      const contentSha = contentShaByPath.get(filePath)!;
      return sendJson(res, 200, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
        commit: { sha: commitSha, message },
      });
    }
    const { commitSha, contentShaByPath } = forge.commitFiles(repo, branch, new Map([[filePath, content]]), message);
    const contentSha = contentShaByPath.get(filePath)!;
    return sendJson(res, 201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = forge.refTip(repo, branch);
    const existing = tip === undefined ? null : forge.filesAt(repo, tip)?.get(filePath) ?? null;
    if (existing === null) return sendError(res, 404, 'Not Found');
    const { commitSha } = forge.commitFiles(repo, branch, new Map(), message, { deletePaths: [filePath] });
    return sendJson(res, 200, { commit: { sha: commitSha, message } });
  }

  if (method !== 'GET') return sendError(res, 404, 'Not Found');
  const refName = ref ?? repo.defaultBranch;
  const files = forge.filesAt(repo, refName);
  if (files === null) return sendError(res, 404, 'Not Found');
  if (filePath === '') {
    // Root directory listing.
    const names = new Set<string>();
    for (const path of files.keys()) names.add(path.split('/')[0]!);
    const entries: Record<string, unknown>[] = [];
    for (const name of [...names].sort()) {
      const sub = `${name}/`;
      const isDir = [...files.keys()].some((path) => path.startsWith(sub));
      if (isDir) {
        entries.push({ type: 'dir', name, path: name, sha: '' });
      } else {
        const entry = files.get(name)!;
        entries.push({ type: 'file', name, path: name, sha: entry.oid, size: 0 });
      }
    }
    return sendJson(res, 200, entries);
  }
  const file = files.get(filePath);
  if (file !== undefined) {
    const obj = repo.store.get(file.oid);
    const content = obj?.data ?? Buffer.alloc(0);
    return sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name: filePath.split('/').pop(),
      path: filePath,
      sha: file.oid,
      content: content.toString('base64'),
    });
  }
  // Directory listing.
  const prefix = `${filePath}/`;
  const children = new Map<string, { isDir: boolean; oid: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest2 = path.slice(prefix.length);
    const first = rest2.split('/')[0]!;
    if (rest2.includes('/')) {
      children.set(first, { isDir: true, oid: '', size: 0 });
    } else {
      children.set(first, { isDir: false, oid: entry.oid, size: repo.store.get(entry.oid)?.data.length ?? 0 });
    }
  }
  if (children.size === 0) return sendError(res, 404, 'Not Found');
  const entries = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, child]) => ({ type: child.isDir ? 'dir' : 'file', name, path: `${filePath}/${name}`, sha: child.oid, size: child.size }));
  return sendJson(res, 200, entries);
}

// -------------------------------------------------------------------------------------------
// labels
// -------------------------------------------------------------------------------------------

async function handleLabelsRoute(ctx: RestCtx, repo: Repo, rest: string[]): Promise<void> {
  const { req, res, forge } = ctx;
  const method = req.method ?? 'GET';
  if (rest.length === 0 && method === 'GET') {
    return sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(repo, label.name)));
  }
  if (rest.length === 0 && method === 'POST') {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return sendError(res, 422, 'name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    const description = typeof body.description === 'string' ? body.description : '';
    forge.createLabel(repo, name, color, description);
    return sendJson(res, 201, labelJson(repo, name));
  }
  return sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function sortIssues(issues: Issue[], sort: string, direction: string): Issue[] {
  const sorted = [...issues];
  const dir = direction === 'asc' ? 1 : -1;
  if (sort === 'created') sorted.sort((a, b) => (a.seq - b.seq) * dir);
  else if (sort === 'updated') sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? -dir : a.updatedAt > b.updatedAt ? dir : (a.seq - b.seq) * dir));
  else sorted.sort((a, b) => (a.seq - b.seq) * dir);
  return sorted;
}

async function handleIssuesRoute(ctx: RestCtx, repo: Repo, rest: string[]): Promise<void> {
  const { req, res, forge } = ctx;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      let list = repo.issues;
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const sorted = sortIssues(list, sort, direction);
      const slice = sorted.slice((page - 1) * perPage, page * perPage);
      return sendJson(res, 200, slice.map((issue) => issueJson(forge, repo, issue)));
    }
    if (method === 'POST') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return sendError(res, 422, 'title is required');
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const entry of rawLabels) {
        if (typeof entry === 'string') labels.push(entry);
        else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string') {
          labels.push((entry as Record<string, unknown>).name as string);
        }
      }
      const created = forge.createIssue(repo, title, bodyText, labels);
      if ('error' in created) return sendError(res, 422, created.error);
      return sendJson(res, 201, issueJson(forge, repo, created));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(res, 404, 'Not Found');
  const issue = forge.getIssue(repo, number);
  if (issue === undefined) return sendError(res, 404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return sendJson(res, 200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = forge.nowIso();
      return sendJson(res, 200, issueJson(forge, repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (rest[1] === 'comments') {
    if (rest.length === 2 && method === 'GET') {
      return sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
    }
    if (rest.length === 2 && method === 'POST') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return sendError(res, 422, 'body is required');
      const comment = forge.createComment(repo, issue, text);
      return sendJson(res, 201, commentJson(repo, issue, comment));
    }
    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function pullFileJson(repo: Repo, entry: { path: string; status: string; oldOid: string | null; newOid: string | null }): Record<string, unknown> {
  const countLines = (oid: string | null): number => {
    if (oid === null) return 0;
    const obj = repo.store.get(oid);
    if (obj === undefined) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const additions = entry.status === 'removed' ? 0 : countLines(entry.newOid);
  const deletions = entry.status === 'added' ? 0 : countLines(entry.oldOid);
  return {
    filename: entry.path,
    status: entry.status,
    additions,
    deletions,
    changes: additions + deletions,
  };
}

async function handlePullsRoute(ctx: RestCtx, repo: Repo, rest: string[]): Promise<void> {
  const { req, res, forge } = ctx;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      let list = repo.pulls;
      if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
      const sorted = [...list].sort((a, b) => b.seq - a.seq);
      const slice = sorted.slice((page - 1) * perPage, page * perPage);
      return sendJson(res, 200, slice.map((pull) => pullJson(forge, repo, pull)));
    }
    if (method === 'POST') {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') return sendError(res, 422, 'title and head are required');
      const created = forge.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
      if ('error' in created) return sendError(res, 422, created.error);
      return sendJson(res, 201, pullJson(forge, repo, created));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(res, 404, 'Not Found');
  const pull = forge.getPull(repo, number);

  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    const files = forge.pullFiles(repo, pull);
    return sendJson(res, 200, files.map((entry) => pullFileJson(repo, entry)));
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    if (method !== 'PUT') return sendError(res, 404, 'Not Found');
    const merged = forge.mergePull(repo, pull);
    if ('status' in merged) return sendError(res, merged.status, merged.error);
    return sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` });
  }

  if (rest.length === 1) {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    if (method === 'GET') return sendJson(res, 200, pullJson(forge, repo, pull));
    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// server
// -------------------------------------------------------------------------------------------

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          return sendJson(res, 200, { ok: true });
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch !== null) {
          return handleGit(forge, req, res, decodeSegment(gitMatch[1]!), decodeSegment(gitMatch[2]!), gitMatch[3] ?? '');
        }

        if (path === '/mcp') {
          return handleMcp(forge, req, res);
        }

        if (path === '/api/graphql') {
          return handleGraphQL(forge, req, res);
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const tail = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = tail === '' ? [] : tail.split('/').filter((segment) => segment !== '');
          let body: unknown = null;
          if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
            const raw = await readBody(req);
            try {
              body = parseJsonBody(raw);
            } catch {
              return sendError(res, 400, 'Malformed JSON body');
            }
          }
          const ctx: RestCtx = { forge, req, res, segments, query: queryOf(req), body };
          return handleRest(ctx);
        }

        return sendError(res, 404, 'Not Found');
      } catch (err) {
        try {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    })();
  });
}
