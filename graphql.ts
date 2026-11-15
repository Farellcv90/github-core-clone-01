// graphql.ts — a small GraphQL v4 executor for the documents gh and github-mcp-server send:
// viewer/repository reads, issue and pull-request lists with cursors, the __type probes,
// the create/close/merge mutations, Relay node(id:), and batched operation arrays.
// Hand-rolled tokenizer + parser + resolver; no dependencies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, decodeGlobalId, globalId, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';
import { authed, parseJsonBody, readBody, sendError, sendJson } from './http.ts';

// -------------------------------------------------------------------------------------------
// tokenizer + parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          i += 2;
        } else {
          out += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      const raw = input.slice(i, j);
      if (/[.eE]/.test(raw)) tokens.push({ kind: 'float', value: parseFloat(raw) });
      else tokens.push({ kind: 'int', value: parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  children: FieldNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  children: FieldNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, ValueNode | undefined>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value} in GraphQL document`);
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Record<string, FragmentNode> } {
    const operations: Operation[] = [];
    const fragments: Record<string, FragmentNode> = {};
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, varDefs: {}, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        fragments[name] = { kind: 'fragment', typeCondition, children: this.parseSelections() };
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const varDefs: Record<string, ValueNode | undefined> = {};
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
          this.next();
          while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
              this.next();
              varDefs[varName] = this.parseValue();
            } else {
              varDefs[varName] = undefined;
            }
          }
          this.expectPunct(')');
        }
        // Directives (@...) are skipped.
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
          this.next();
          this.expectName();
          if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArgs();
        }
        operations.push({ type, name, varDefs, selections: this.parseSelections() });
        continue;
      }
      throw new Error(`Unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error('Expected a type in GraphQL document');
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek()!;
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek()!;
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', typeCondition, children: this.parseSelections() });
        } else if (next.kind === 'name') {
          // Named fragment spread: resolved by the executor against the document's fragments.
          const name = this.next().value;
          selections.push({ kind: 'fragment', typeCondition: `...${name}`, children: [] });
        } else {
          throw new Error('Bad fragment spread in GraphQL document');
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      let args: Array<{ name: string; value: ValueNode }> = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArgs();
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
        this.next();
        this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArgs();
      }
      let children: FieldNode[] = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') children = this.parseSelections() as FieldNode[];
      selections.push({ kind: 'field', alias, name, args, children });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token)} in GraphQL document`);
  }
}

// -------------------------------------------------------------------------------------------
// schema (field sets for validation and introspection)
// -------------------------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'createdAt', 'updatedAt', 'url', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'url'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  Label: ['id', 'name', 'color', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

class GraphQLError extends Error {}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

type AnyRecord = Record<string, unknown> & { __typename: string };

interface Ctx {
  forge: Forge;
}

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as AnyRecord).__typename === 'string';
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

function repoRecord(forge: Forge, repo: Repo): AnyRecord {
  return { __typename: 'Repository', repo, forge } as unknown as AnyRecord;
}

function issueRecord(repo: Repo, issue: Issue): AnyRecord {
  return { __typename: 'Issue', repo, issue } as unknown as AnyRecord;
}

function pullRecord(forge: Forge, repo: Repo, pull: PullRequest): AnyRecord {
  return { __typename: 'PullRequest', forge, repo, pull } as unknown as AnyRecord;
}

function pageInfoFor(total: number, start: number, end: number): AnyRecord {
  return {
    __typename: 'PageInfo',
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: total === 0 ? null : encodeCursor(start),
    // The end cursor points at the next index, so a client that passes it as `after`
    // resumes one past the last item it saw (cursors are opaque to it anyway).
    endCursor: end === 0 ? null : encodeCursor(end),
  } as unknown as AnyRecord;
}

/** Resolve one field of a typed value. */
function resolveField(ctx: Ctx, fragments: Record<string, FragmentNode>, parentType: string, parent: AnyRecord, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = resolveArgs(field, variables);
  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = ctx.forge.getRepo(owner, name);
        return repo === undefined ? null : repoRecord(ctx.forge, repo);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        const repo = ctx.forge.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        if (decoded.kind === 'repo') return repoRecord(ctx.forge, repo);
        if (decoded.kind === 'issue') {
          const issue = ctx.forge.getIssue(repo, decoded.number);
          return issue === undefined ? null : issueRecord(repo, issue);
        }
        if (decoded.kind === 'pull') {
          const pull = ctx.forge.getPull(repo, decoded.number);
          return pull === undefined ? null : pullRecord(ctx.forge, repo, pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (SCHEMA[name] !== undefined) {
          return {
            __typename: '__Type',
            name,
            kind: 'OBJECT',
            fields: SCHEMA[name]!.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
            enumValues: null,
          };
        }
        if (ENUM_VALUES[name] !== undefined) {
          return {
            __typename: '__Type',
            name,
            kind: 'ENUM',
            fields: null,
            enumValues: ENUM_VALUES[name]!.map((value) => ({ __typename: '__EnumValue', name: value })),
          };
        }
        return null;
      }
      if (field.name === '__schema') {
        return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query' } };
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null) throw new GraphQLError('createIssue: unknown repositoryId');
        const repo = ctx.forge.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) throw new GraphQLError('createIssue: repository does not exist');
        const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        if ('error' in (issue as object)) throw new GraphQLError('createIssue failed');
        return { __typename: 'CreateIssuePayload', issue: issueRecord(repo, issue as Issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (decoded === null) throw new GraphQLError('closeIssue: unknown issueId');
        const repo = ctx.forge.getRepo(decoded.owner, decoded.name);
        const issue = repo === undefined ? undefined : ctx.forge.getIssue(repo, decoded.number);
        if (repo === undefined || issue === undefined) throw new GraphQLError('closeIssue: issue does not exist');
        issue.state = 'closed';
        issue.updatedAt = ctx.forge.nowIso();
        return { __typename: 'CloseIssuePayload', issue: issueRecord(repo, issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null) throw new GraphQLError('createPullRequest: unknown repositoryId');
        const repo = ctx.forge.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) throw new GraphQLError('createPullRequest: repository does not exist');
        const pull = ctx.forge.createPull(repo, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        if ('error' in (pull as object)) throw new GraphQLError(`createPullRequest: ${(pull as { error: string }).error}`);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullRecord(ctx.forge, repo, pull as PullRequest) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (decoded === null) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
        const repo = ctx.forge.getRepo(decoded.owner, decoded.name);
        const pull = repo === undefined ? undefined : ctx.forge.getPull(repo, decoded.number);
        if (repo === undefined || pull === undefined) throw new GraphQLError('mergePullRequest: pull request does not exist');
        ctx.forge.mergePull(repo, pull);
        return { __typename: 'MergePullRequestPayload', pullRequest: pullRecord(ctx.forge, repo, pull) };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (decoded === null) throw new GraphQLError('addComment: unknown subjectId');
        const repo = ctx.forge.getRepo(decoded.owner, decoded.name);
        const issue = repo === undefined ? undefined : ctx.forge.getIssue(repo, decoded.number);
        if (repo === undefined || issue === undefined) throw new GraphQLError('addComment: issue does not exist');
        const comment = ctx.forge.createComment(repo, issue, String(input.body ?? ''));
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'Comment', repo, issue, comment, id: globalId('comment', repo.owner, repo.name, comment.id), body: comment.body, createdAt: comment.createdAt },
          },
        };
      }
      break;
    }
    case 'Repository': {
      const repo = (parent as unknown as { repo: Repo }).repo;
      if (field.name === 'id') return globalId('repo', repo.owner, repo.name);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001, name: repo.owner, email: '' };
      if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch, target: null };
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}`;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'issue') {
        const issue = ctx.forge.getIssue(repo, Number(args.number ?? 0));
        return issue === undefined ? null : issueRecord(repo, issue);
      }
      if (field.name === 'issues') {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => {
          const bySeq = (a.seq - b.seq) * direction;
          if (orderBy.field === 'CREATED_AT' || orderBy.field === undefined) return bySeq === 0 ? (a.number - b.number) * direction : bySeq;
          return bySeq;
        });
        const first = typeof args.first === 'number' ? args.first : list.length;
        const start = decodeCursor(args.after);
        const slice = list.slice(start, start + first);
        return {
          __typename: 'IssueConnection',
          nodes: slice.map((issue) => issueRecord(repo, issue)),
          edges: slice.map((issue, index) => ({ __typename: 'IssueEdge', node: issueRecord(repo, issue), cursor: encodeCursor(start + index) })),
          pageInfo: pageInfoFor(list.length, start, start + slice.length),
          totalCount: list.length,
        };
      }
      if (field.name === 'pullRequests') {
        let list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const start = decodeCursor(args.after);
        const slice = list.slice(start, start + first);
        return {
          __typename: 'PullRequestConnection',
          nodes: slice.map((pull) => pullRecord(ctx.forge, repo, pull)),
          edges: slice.map((pull, index) => ({ __typename: 'IssueEdge', node: pullRecord(ctx.forge, repo, pull), cursor: encodeCursor(start + index) })),
          pageInfo: pageInfoFor(list.length, start, start + slice.length),
          totalCount: list.length,
        };
      }
      if (field.name === 'pullRequest') {
        const pull = ctx.forge.getPull(repo, Number(args.number ?? 0));
        return pull === undefined ? null : pullRecord(ctx.forge, repo, pull);
      }
      break;
    }
    case 'Issue': {
      const { issue, repo } = parent as unknown as { issue: Issue; repo: Repo };
      if (field.name === 'id') return globalId('issue', repo.owner, repo.name, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      if (field.name === 'labels') return issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' }));
      if (field.name === 'author') return { __typename: 'User', login: issue.userLogin, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'comments') {
        return {
          __typename: 'IssueConnection',
          nodes: issue.comments.map((comment) => ({ __typename: 'Comment', repo, issue, comment, id: globalId('comment', repo.owner, repo.name, comment.id), body: comment.body, createdAt: comment.createdAt })),
          edges: [],
          pageInfo: pageInfoFor(issue.comments.length, 0, issue.comments.length),
          totalCount: issue.comments.length,
        };
      }
      break;
    }
    case 'PullRequest': {
      const { pull, repo, forge } = parent as unknown as { pull: PullRequest; repo: Repo; forge: Forge };
      if (field.name === 'id') return globalId('pull', repo.owner, repo.name, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') return forge.mergeable(repo, pull);
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRef') return { __typename: 'Ref', name: pull.headRef, target: null };
      if (field.name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef, target: null };
      if (field.name === 'createdAt') return pull.createdAt;
      if (field.name === 'updatedAt') return pull.updatedAt;
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field.name === 'files') {
        const files = forge.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const slice = files.slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: slice.map((entry) => ({
            __typename: 'PullRequestChangedFile',
            path: entry.path,
            additions: entry.status === 'removed' ? 0 : 1,
            deletions: entry.status === 'added' ? 0 : 1,
            changes: 1,
          })),
          edges: [],
          pageInfo: pageInfoFor(files.length, 0, slice.length),
          totalCount: files.length,
        };
      }
      break;
    }
    case 'User': {
      const user = parent as unknown as { login: string; id: number; name: string; email: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return user.id;
      if (field.name === 'name') return user.name ?? user.login;
      if (field.name === 'email') return user.email ?? '';
      break;
    }
    case 'Ref': {
      const ref = parent as unknown as { name: string; target: unknown };
      if (field.name === 'name') return ref.name;
      if (field.name === 'target') return ref.target ?? null;
      break;
    }
    case 'Comment': {
      const comment = parent as unknown as { id: string; body: string; createdAt: string };
      if (field.name === 'id') return comment.id;
      if (field.name === 'body') return comment.body;
      if (field.name === 'createdAt') return comment.createdAt;
      if (field.name === 'author') return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      break;
    }
    case '__Type': {
      const type = parent as unknown as { name: string; kind: string; fields: unknown; enumValues: unknown };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return type.kind;
      if (field.name === 'fields') return type.fields ?? null;
      if (field.name === 'enumValues') return type.enumValues ?? null;
      if (field.name === 'description') return null;
      break;
    }
    case '__Field': {
      const f = parent as unknown as { name: string };
      if (field.name === 'name') return f.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return null;
      break;
    }
    case '__EnumValue': {
      const v = parent as unknown as { name: string };
      if (field.name === 'name') return v.name;
      if (field.name === 'description') return null;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = parent as unknown as { issue: AnyRecord };
      if (field.name === 'issue') return payload.issue;
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = parent as unknown as { pullRequest: AnyRecord };
      if (field.name === 'pullRequest') return payload.pullRequest;
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      const payload = parent as unknown as { commentEdge: AnyRecord };
      if (field.name === 'commentEdge') return payload.commentEdge;
      if (field.name === 'comment') return null;
      if (field.name === 'clientMutationId') return null;
      break;
    }
    case 'IssueCommentEdge':
    case 'IssueEdge': {
      const edge = parent as unknown as { node: AnyRecord; cursor: string };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor ?? '';
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const connection = parent as unknown as { nodes: unknown[]; edges: unknown[]; pageInfo: AnyRecord; totalCount: number };
      if (field.name === 'nodes') return connection.nodes;
      if (field.name === 'edges') return connection.edges;
      if (field.name === 'pageInfo') return connection.pageInfo;
      if (field.name === 'totalCount') return connection.totalCount;
      break;
    }
    case 'PageInfo': {
      const info = parent as unknown as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'hasPreviousPage') return info.hasPreviousPage;
      if (field.name === 'startCursor') return info.startCursor;
      if (field.name === 'endCursor') return info.endCursor;
      break;
    }
    case 'PullRequestChangedFile': {
      const file = parent as unknown as { path: string; additions: number; deletions: number; changes: number };
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changes') return file.changes;
      break;
    }
    case 'Label': {
      const label = parent as unknown as { name: string; color: string; description: string };
      if (field.name === 'name') return label.name;
      if (field.name === 'color') return label.color;
      if (field.name === 'description') return label.description;
      if (field.name === 'id') return label.name;
      break;
    }
    case '__Schema': {
      if (field.name === 'queryType') return { __typename: '__Type', name: 'Query', kind: 'OBJECT', fields: [], enumValues: null };
      break;
    }
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${parentType}".`);
}

function executeSelections(
  ctx: Ctx,
  fragments: Record<string, FragmentNode>,
  parentType: string,
  parent: AnyRecord,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition.startsWith('...')) {
        const named = fragments[selection.typeCondition.slice(3)];
        if (named !== undefined) {
          const inner = executeSelections(ctx, fragments, parentType, parent, named.children, variables);
          Object.assign(out, inner);
        }
        continue;
      }
      if (selection.typeCondition !== parentType) continue;
      const inner = executeSelections(ctx, fragments, selection.typeCondition, parent, selection.children, variables);
      Object.assign(out, inner);
      continue;
    }
    const field = selection;
    if (field.name === '__typename') {
      out[field.alias ?? field.name] = parentType;
      continue;
    }
    const allowed = SCHEMA[parentType];
    if (allowed === undefined || !allowed.includes(field.name)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${parentType}".`);
    }
    const value = resolveField(ctx, fragments, parentType, parent, field, variables);
    out[field.alias ?? field.name] = projectValue(ctx, fragments, parentType, field, value, variables);
  }
  return out;
}

function projectValue(
  ctx: Ctx,
  fragments: Record<string, FragmentNode>,
  parentType: string,
  field: FieldNode,
  value: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return null;
  if (field.children.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry === null || entry === undefined) return null;
      if (!isRecord(entry)) return entry;
      return executeSelections(ctx, fragments, entry.__typename, entry, field.children as SelectionNode[], variables);
    });
  }
  if (isRecord(value)) {
    // A field's object type: the record's own __typename (fragments may narrow it).
    return executeSelections(ctx, fragments, value.__typename, value, field.children as SelectionNode[], variables);
  }
  return value;
}

function executeOperation(ctx: Ctx, operation: Operation, fragments: Record<string, FragmentNode>, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of Object.entries(operation.varDefs)) {
    if (vars[name] === undefined && defaultValue !== undefined) vars[name] = resolveValue(defaultValue, {});
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyRecord = { __typename: rootType } as unknown as AnyRecord;
  try {
    const data = executeSelections(ctx, fragments, rootType, root, operation.selections, vars);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

// -------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------

export async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return sendError(res, 404, 'Not Found');
  if (!authed(req)) return sendError(res, 401, 'Requires authentication');
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch {
    return sendJson(res, 400, { errors: [{ message: 'Malformed JSON body' }] });
  }
  const ctx: Ctx = { forge };
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const entry of body) {
      results.push(executeOne(ctx, entry));
    }
    return sendJson(res, 200, results);
  }
  return sendJson(res, 200, executeOne(ctx, body));
}

function executeOne(ctx: Ctx, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || typeof (body as Record<string, unknown>).query !== 'string') {
    return { errors: [{ message: 'A GraphQL query is required' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query as string;
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let parsed: { operations: Operation[]; fragments: Record<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Could not parse the GraphQL document' }] };
  }
  if (parsed.operations.length === 0) return { errors: [{ message: 'The document holds no operation' }] };
  let operation: Operation | undefined;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  if (operationName !== null) operation = parsed.operations.find((op) => op.name === operationName);
  else if (parsed.operations.length === 1) operation = parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'Could not pick an operation to run' }] };
  try {
    return executeOperation(ctx, operation, parsed.fragments, variables);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] };
  }
}
