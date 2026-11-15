// git.ts — git smart HTTP: info/refs advertisements (v0 and protocol v2), upload-pack
// (v2 fetch with shallow/deepen, v0 fallback) and receive-pack (v0, report-status in
// sideband). Implements the wire exactly as the suite's git-client speaks it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ObjectStore, ZERO_OID, decodePktLines, isOid, parseCommit, parseTag, parseTree, pktDelim, pktFlush, pktLine, readPack, writePack, type GitObj } from './forge.ts';
import { authed, nextRequestId, readBody, sendError } from './http.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0';
const SIDEBAND_CHUNK = 32768;

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

/** Sorted ref names, with HEAD's target first in the v0 advertisement. */
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** Peeled target of a tag ref (the commit it points at), or the oid itself. */
function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const obj = repo.store.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** v0 ref advertisement lines for a service, capabilities on the first line. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`
      : `side-band-64k shallow thin-pack ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const name of refs) {
      const oid = repo.refs.get(name)!;
      parts.push(pktLine(`${oid} ${name}\n`));
      if (name.startsWith('refs/tags/')) {
        const peeled = peel(repo, oid);
        if (peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Protocol v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function sendSideband(res: ServerResponse, contentType: string, data: Buffer): void {
  sendRaw(res, 200, contentType, data);
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2Fetch(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) continue; // command= / agent= / object-format= lines
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = Number(text.slice(7).trim());
  }
  return args;
}

function parseV0Fetch(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      // The first want may carry capabilities after a space; the oid is the first token.
      args.wants.push(text.slice(5).split(' ')[0]!);
    } else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = Number(text.slice(7).trim());
    void section;
  }
  return args;
}

/** The tree and blob objects under a tree, into `into` (stack-based, cycle-safe). */
function collectTreeObjects(store: ObjectStore, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    into.add(oid);
    for (const entry of parseTree(obj.data)) {
      const child = store.get(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') stack.push(entry.oid);
      else into.add(entry.oid);
    }
  }
}

/** The objects a fetch sends, plus the shallow-info lines, for wants/haves/depth. */
function computeFetch(repo: Repo, args: FetchArgs): { objects: GitObj[]; shallow: string[]; unshallow: string[]; missing: boolean } {
  const store = repo.store;
  for (const want of args.wants) {
    if (!store.has(want)) return { objects: [], shallow: [], unshallow: [], missing: true };
  }
  let sendSet: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth !== null) {
    const reached = store.reachable(args.wants, args.depth);
    sendSet = reached.objects;
    shallow = reached.boundary;
    for (const old of args.shallow) {
      if (!sendSet.has(old)) continue;
      const obj = store.get(old);
      if (obj === undefined || obj.type !== 'commit') continue;
      // Unshallow when the old boundary's parents are all in the sent set now.
      const parents = parseCommit(obj.data).parents;
      if (parents.every((parent: string) => sendSet.has(parent))) unshallow.push(old);
    }
  } else {
    sendSet = store.reachable(args.wants).objects;
  }
  if (args.haves.length > 0) {
    // What the client already owns: walk the haves, but stop at the client's shallow
    // boundary — below a shallow commit it owns nothing, so those parents must be sent
    // (this is what makes `deepen` deliver exactly one more generation). A have that
    // is not shallow owns its full history, as before.
    const shallowSet = new Set(args.shallow);
    const owned = new Set<string>();
    const seen = new Set<string>();
    const frontier = args.haves.filter((oid) => store.has(oid));
    while (frontier.length > 0) {
      const oid = frontier.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = store.get(oid);
      if (obj === undefined) continue;
      owned.add(oid);
      if (obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (store.has(target)) frontier.push(target);
        continue;
      }
      if (obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      collectTreeObjects(store, commit.tree, owned);
      if (shallowSet.has(oid)) continue;
      for (const parent of commit.parents) {
        if (store.has(parent)) frontier.push(parent);
      }
    }
    for (const oid of owned) sendSet.delete(oid);
  }
  shallow = shallow.filter((oid) => sendSet.has(oid));
  const objects: GitObj[] = [];
  for (const oid of [...sendSet].sort()) {
    const obj = store.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  return { objects, shallow, unshallow, missing: false };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------

async function handleLsRefs(repo: Repo, req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  let prefixes: string[] = [];
  let peelWanted = false;
  let symrefsWanted = false;
  let unbornWanted = false;
  try {
    let seenDelim = false;
    for (const packet of decodePktLines(raw)) {
      if (packet.kind === 'delim') {
        seenDelim = true;
        continue;
      }
      if (packet.kind !== 'data' || !seenDelim) continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (text === 'peel') peelWanted = true;
      else if (text === 'symrefs') symrefsWanted = true;
      else if (text === 'unborn') unbornWanted = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
  } catch {
    return sendError(res, 400, 'Malformed pkt-line request');
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const defaultTarget = `refs/heads/${repo.defaultBranch}`;
  if (prefixes.length === 0) {
    if (head === ZERO_OID) {
      if (unbornWanted) parts.push(pktLine(`unborn HEAD symref-target:${defaultTarget}\n`));
    } else {
      parts.push(pktLine(`${head} HEAD${symrefsWanted ? ` symref-target:${defaultTarget}` : ''}\n`));
    }
  }
  for (const name of sortedRefs(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peelWanted && name.startsWith('refs/tags/')) {
      const peeled = peel(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return sendSideband(res, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function isLsRefsRequest(body: Buffer): boolean {
  try {
    for (const packet of decodePktLines(body)) {
      if (packet.kind === 'data' && packet.payload.toString('utf8').includes('command=ls-refs')) return true;
    }
  } catch {
    // Not a decodable pkt stream; treat as a fetch.
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into command pkt-lines and the pack bytes after the flush. */
function splitReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > body.length) throw new Error('pkt-line length out of range');
    const text = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    offset += len;
  }
  return { commands, pack: body.subarray(packStart) };
}

async function handleReceivePack(forge: Forge, repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let commands: PushCommand[] = [];
  let pack = Buffer.alloc(0);
  try {
    const split = splitReceivePack(raw);
    commands = split.commands;
    pack = split.pack;
  } catch {
    return sendError(res, 400, 'Malformed pkt-line request');
  }
  // Unpack first: every object the push carries enters the store (even for refused refs,
  // matching git, which unpacks before it checks ref updates).
  let unpackError: string | null = null;
  const newObjects = new Map<string, GitObj>();
  if (pack.length > 0) {
    try {
      for (const [oid, obj] of readPack(pack)) newObjects.set(oid, obj);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    for (const [oid, obj] of newObjects) {
      if (!repo.store.has(oid)) repo.store.objects.set(oid, obj);
    }
    reportLines.push('unpack ok\n');
    const combined = new ObjectStore();
    combined.objects = new Map(repo.store.objects);
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reason = 'ref does not exist';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reason = 'non-fast-forward';
        } else {
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reason = 'already exists';
        } else if (!combined.has(command.newOid)) {
          reason = 'missing object';
        } else if (command.ref.startsWith('refs/heads/') && combined.get(command.newOid)?.type !== 'commit') {
          reason = 'not a commit';
        } else {
          ok = true;
        }
      } else {
        // Update: the old value must match, and the new tip must descend from it.
        if (current === undefined) {
          reason = 'ref does not exist';
        } else if (command.oldOid !== current) {
          reason = 'non-fast-forward';
        } else if (!combined.has(command.newOid)) {
          reason = 'missing object';
        } else {
          try {
            ok = combined.isAncestor(command.oldOid, command.newOid);
            if (!ok) reason = 'non-fast-forward';
          } catch {
            reason = 'missing object';
          }
        }
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      }
    }
  }
  const inner = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const parts: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += SIDEBAND_CHUNK) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return sendSideband(res, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export async function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string): Promise<void> {
  const method = req.method ?? 'GET';
  if (!authed(req)) return sendError(res, 401, 'Requires authentication');
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return sendError(res, 404, 'Not Found');

  if (method === 'GET' && tail === 'info/refs') {
    const service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service');
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      return sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', body);
    }
    if (service === 'git-receive-pack') {
      return sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    // ls-refs and fetch share this endpoint under protocol v2; tell them apart by the command.
    const raw = await readBody(req);
    if (isLsRefsRequest(raw)) return handleLsRefs(repo, req, res, raw);
    return handleUploadPackWithBody(forge, repo, req, res, raw);
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    return handleReceivePack(forge, repo, req, res);
  }

  return sendError(res, 404, 'Not Found');
}

async function handleUploadPackWithBody(forge: Forge, repo: Repo, req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let args: FetchArgs;
  try {
    args = isV2 ? parseV2Fetch(raw) : parseV0Fetch(raw);
  } catch {
    return sendError(res, 400, 'Malformed pkt-line request');
  }
  const result = computeFetch(repo, args);
  if (isV2) {
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
    if (result.shallow.length > 0 || result.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    if (result.objects.length > 0) {
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPackets(writePack(result.objects)));
    }
    parts.push(pktFlush());
    return sendSideband(res, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  if (result.objects.length > 0) parts.push(...sidebandPackets(writePack(result.objects)));
  parts.push(pktFlush());
  return sendSideband(res, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}
