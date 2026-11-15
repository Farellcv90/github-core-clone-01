// store.ts — the forge's in-memory state: repositories, git refs, issues, pull requests,
// labels and comments, plus the operations that move them (contents commits, squash merges).
// Everything is deterministic: ids and timestamps come from counters, never the wall clock,
// so two runs of the same trial leave the same pass/fail bits.

import { ObjectStore, ZERO_OID, buildCommit, hashObject, isOid, parseCommit, parseTag, parseTree } from './forge.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
export const DEFAULT_BRANCH = 'main';

// A fixed logical clock: 2025-01-01T00:00:00Z plus one second per event. Deterministic and
// strictly increasing, so created/merged order is always creation order.
const EPOCH_SEC = 1735689600;

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  id: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
  store: ObjectStore;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly creationOrder: Repo[] = [];
  private repoSeq = 0;
  private repoIdSeq = 5000;
  private globalIdSeq = 1;
  private clockSeq = 0;

  nowSec(): number {
    return EPOCH_SEC + this.clockSeq++;
  }

  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  }

  nextGlobalId(): number {
    return this.globalIdSeq++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): Repo | { error: string } {
    if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name)) {
      return { error: 'Invalid repository name' };
    }
    if (this.repos.has(this.key(owner, name))) return { error: 'Repository already exists' };
    const now = this.nowIso();
    const repo: Repo = {
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      id: this.repoIdSeq++,
      seq: this.repoSeq++,
      createdAt: now,
      updatedAt: now,
      store: new ObjectStore(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    this.creationOrder.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.repos.delete(this.key(owner, name));
    const index = this.creationOrder.indexOf(repo);
    if (index >= 0) this.creationOrder.splice(index, 1);
    return true;
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The ref a name resolves to: a full ref, a branch name, or a raw commit id. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (isOid(ref) && repo.store.has(ref)) return ref;
    return undefined;
  }

  /** Create a commit on `branch` that sets `files` (path -> bytes) over the branch tip's tree. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: Map<string, Buffer>,
    message: string,
    options: { deletePaths?: readonly string[] } = {},
  ): { commitSha: string; contentShaByPath: Map<string, string> } {
    let tip = this.refTip(repo, branch);
    // A new branch starts from the default branch's tip (GitHub's contents-write behaviour).
    if (tip === undefined && branch !== repo.defaultBranch) tip = this.refTip(repo, repo.defaultBranch);
    let flat: Map<string, { oid: string; mode: string }>;
    const parents: string[] = [];
    if (tip !== undefined) {
      parents.push(tip);
      const tipCommit = parseCommit(repo.store.get(tip)!.data);
      flat = repo.store.flattenTree(tipCommit.tree);
    } else {
      flat = new Map();
    }
    const contentShaByPath = new Map<string, string>();
    for (const path of options.deletePaths ?? []) flat.delete(path);
    for (const [path, content] of files) {
      const blobOid = repo.store.put('blob', content);
      contentShaByPath.set(path, blobOid);
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
    const treeOid = repo.store.buildTreeFromMap(flat);
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      timestamp: this.nowSec(),
    });
    const commitSha = repo.store.put('commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentShaByPath };
  }

  /** The flat file map of a ref's tree (empty when the ref has no commit). */
  filesAt(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return null;
    const obj = repo.store.get(tip);
    if (obj === undefined) return null;
    let commitOid = tip;
    if (obj.type === 'tag') {
      commitOid = parseTag(obj.data).object;
    }
    const commitObj = repo.store.get(commitOid);
    if (commitObj === undefined || commitObj.type !== 'commit') return null;
    return repo.store.flattenTree(parseCommit(commitObj.data).tree);
  }

  /** History of a branch tip, newest first (first-parent walk with a visited set). */
  history(repo: Repo, tip: string, limit = 100): Array<{ sha: string; message: string; author: string; committer: string }> {
    const out: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // issues, labels, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { id: repo.nextLabelId++, name, color: color || 'ededed', description };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
    }
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextGlobalId(),
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      seq: repo.nextNumber,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: repo.nextCommentId++,
      body,
      userLogin: VIEWER_LOGIN,
      createdAt: this.nowIso(),
    };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests + squash merges
  // -------------------------------------------------------------------------------------------

  /** The changed paths between the merge-base tree and the head tip's tree. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ path: string; status: string; oldOid: string | null; newOid: string | null }> {
    const headTip = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const base = repo.store.mergeBase(baseTip, headTip) ?? baseTip;
    const baseFiles = this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, headTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ path: string; status: string; oldOid: string | null; newOid: string | null }> = [];
    for (const path of [...paths].sort()) {
      const oldEntry = baseFiles.get(path);
      const newEntry = headFiles.get(path);
      if (oldEntry === undefined && newEntry !== undefined) {
        out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return out;
  }

  filesAtCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const obj = repo.store.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return repo.store.flattenTree(parseCommit(obj.data).tree);
  }

  /** MERGEABLE when the squash would apply cleanly, CONFLICTING when head and base changed the same path differently. */
  mergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    const headTip = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const base = repo.store.mergeBase(baseTip, headTip);
    if (base === null) return 'CONFLICTING';
    const baseFiles = this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, headTip);
    const baseTipFiles = this.filesAtCommit(repo, baseTip);
    const paths = new Set([...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of paths) {
      const fromBase = baseFiles.get(path);
      const head = headFiles.get(path);
      const tip = baseTipFiles.get(path);
      const headChanged = (head?.oid ?? null) !== (fromBase?.oid ?? null);
      const tipChanged = (tip?.oid ?? null) !== (fromBase?.oid ?? null);
      if (headChanged && tipChanged && (head?.oid ?? null) !== (tip?.oid ?? null)) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (headSha === undefined) return { error: `Head branch '${head}' does not exist` };
    if (baseSha === undefined) return { error: `Base branch '${base}' does not exist` };
    const now = this.nowIso();
    const pull: PullRequest = {
      id: this.nextGlobalId(),
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      seq: repo.nextNumber,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or an error. */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    if (this.mergeable(repo, pull) === 'CONFLICTING') {
      return { error: 'Merge conflict', status: 405 };
    }
    const headTip = this.resolveRef(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const base = repo.store.mergeBase(baseTip, headTip) ?? baseTip;
    const baseFiles = this.filesAtCommit(repo, base);
    const headFiles = this.filesAtCommit(repo, headTip);
    const baseTipFiles = this.filesAtCommit(repo, baseTip);
    // Apply the head's diff (merge-base -> head) onto the base tip's tree.
    const merged = new Map(baseTipFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const fromBase = baseFiles.get(path);
      const head = headFiles.get(path);
      if ((fromBase?.oid ?? null) === (head?.oid ?? null)) continue;
      if (head === undefined) merged.delete(path);
      else merged.set(path, head);
    }
    const treeOid = repo.store.buildTreeFromMap(merged);
    const message = `${pull.title} (#${pull.number})\n`;
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: VIEWER_IDENTITY,
      timestamp: this.nowSec(),
    });
    const sha = repo.store.put('commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.baseSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { sha };
  }
}

export function globalId(kind: 'repo' | 'issue' | 'pull' | 'comment', owner: string, name: string, number = 0): string {
  const raw = `${kind}:${owner}/${name}:${number}`;
  return `${kind[0].toUpperCase()}_${Buffer.from(raw, 'utf8').toString('base64')}`;
}

export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number } | null {
  const match = /^([RIPC])_(.+)$/.exec(id);
  if (match === null) return null;
  const kindMap: Record<string, string> = { R: 'repo', I: 'issue', P: 'pull', C: 'comment' };
  const kind = kindMap[match[1]!] ?? '';
  let raw = '';
  try {
    raw = Buffer.from(match[2]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const ownerName = (parts[1] ?? '').split('/');
  if (ownerName.length !== 2) return null;
  return { kind, owner: ownerName[0]!, name: ownerName[1]!, number: Number(parts[2]) };
}
