// mcp.ts — a JSON-RPC 2.0 MCP server over POST /mcp, for gh and github-mcp-server.
// Modern transport era 2026-07-28: server/discover first, initialize as the fallback.
// The six tools create/get a repository, create/list issues, and create/merge a pull
// request, all against the same in-memory Forge the REST and GraphQL layers use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Forge, type PullRequest, type Repo } from './store.ts';
import { authed, parseJsonBody, readBody, sendError, sendJson } from './http.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        name: { type: 'string', description: 'Alias for repo (repository name)' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        number: { type: 'integer', description: 'Alias for pull_number' },
        merge_method: { type: 'string', description: 'Merge method: merge, squash, or rebase' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    owner: { login: repo.owner },
    ownerLogin: repo.owner,
    full_name: `${repo.owner}/${repo.name}`,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    description: repo.description,
    private: repo.private,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: ReturnType<Forge['createIssue']>): Record<string, unknown> {
  if ('error' in (issue as object)) return { error: (issue as { error: string }).error };
  const item = issue as { number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string };
  return {
    id: item.number,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => ({ name })),
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest, forge: Forge): Record<string, unknown> {
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'merged' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: forge.mergeable(repo, pull),
    head: { ref: pull.headRef, sha: pull.headSha },
    headRef: pull.headRef,
    base: { ref: pull.baseRef, sha: pull.baseSha },
    baseRef: pull.baseRef,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function requireArgs(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { data: unknown } | { jsonRpcError: { code: number; message: string } } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { jsonRpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = requireArgs(args, def.inputSchema.required);
  if (missing !== null) return { jsonRpcError: { code: -32602, message: `Missing required argument: ${missing}` } };

  if (name === 'create_repo') {
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
    const result = forge.createRepo(owner, String(args.name ?? ''), typeof args.description === 'string' ? args.description : '', args.private === true);
    if ('error' in result) return { jsonRpcError: { code: -32602, message: result.error } };
    return { data: repoJson(result) };
  }
  if (name === 'get_repo') {
    const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? args.name ?? ''));
    if (repo === undefined) return { jsonRpcError: { code: -32602, message: `Could not find repository ${String(args.owner)}/${String(args.repo ?? args.name)}` } };
    return { data: repoJson(repo) };
  }
  if (name === 'create_issue') {
    const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
    if (repo === undefined) return { jsonRpcError: { code: -32602, message: `Could not find repository ${String(args.owner)}/${String(args.repo)}` } };
    const issue = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    if ('error' in issue) return { jsonRpcError: { code: -32602, message: issue.error } };
    return { data: issueJson(repo, issue) };
  }
  if (name === 'list_issues') {
    const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
    if (repo === undefined) return { jsonRpcError: { code: -32602, message: `Could not find repository ${String(args.owner)}/${String(args.repo)}` } };
    const state = typeof args.state === 'string' ? args.state : 'all';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return { data: { issues: list.map((issue) => issueJson(repo, issue)) } };
  }
  if (name === 'create_pull_request') {
    const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
    if (repo === undefined) return { jsonRpcError: { code: -32602, message: `Could not find repository ${String(args.owner)}/${String(args.repo)}` } };
    const pull = forge.createPull(
      repo,
      String(args.title ?? ''),
      typeof args.body === 'string' ? args.body : '',
      String(args.head ?? ''),
      String(args.base ?? ''),
    );
    if ('error' in pull) return { jsonRpcError: { code: -32602, message: pull.error } };
    return { data: pullJson(repo, pull, forge) };
  }
  if (name === 'merge_pull_request') {
    const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
    if (repo === undefined) return { jsonRpcError: { code: -32602, message: `Could not find repository ${String(args.owner)}/${String(args.repo)}` } };
    const pull = forge.getPull(repo, Number(args.pull_number ?? args.number ?? 0));
    if (pull === undefined) return { jsonRpcError: { code: -32602, message: `Could not find pull request ${String(args.number)}` } };
    const outcome = forge.mergePull(repo, pull);
    if (outcome.merged === false && outcome.reason === 'already merged') {
      return { data: { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request already merged', pull_request: pullJson(repo, pull, forge) } };
    }
    if (outcome.merged === false) {
      return { jsonRpcError: { code: -32602, message: outcome.reason ?? 'Merge failed' } };
    }
    return { data: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, pull, forge) } };
  }
  return { jsonRpcError: { code: -32602, message: `Unknown tool: ${name}` } };
}

export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendError(res, 404, 'Not Found');
  if (!authed(req)) return sendError(res, 401, 'Requires authentication');
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const request = body as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';

  // Notifications carry no id and expect no reply body.
  if (method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  const reply = (payload: Record<string, unknown>): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, ...payload });
  };

  if (method === 'server/discover') {
    return reply({
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' },
        },
      },
    });
  }
  if (method === 'initialize') {
    return reply({
      result: {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      },
    });
  }
  if (method === 'ping') {
    return reply({ result: {} });
  }
  if (method === 'tools/list') {
    return reply({ result: { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } });
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(forge, toolName, args);
    if ('jsonRpcError' in outcome) return reply({ error: outcome.jsonRpcError });
    const text = JSON.stringify(outcome.data);
    return reply({
      result: {
        content: [{ type: 'text', text }],
        structuredContent: outcome.data,
      },
    });
  }
  return reply({ error: { code: -32601, message: `Method not found: ${method}` } });
}
