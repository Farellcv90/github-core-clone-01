// forge.ts — git primitives: object hashing, tree/commit/tag codecs, pkt-line framing,
// packfile read/write, and graph traversal. No git binary, no dependencies: node:crypto
// for SHA-1 and node:zlib for pack inflation, exactly as the suite's own client does it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const HEX40 = /^[0-9a-f]{40}$/;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Uint8Array): string {
  const body = Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

// -------------------------------------------------------------------------------------------
// trees, commits, tags
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buffer.length) throw new Error('malformed tree object');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  // A commit object's message ends with a newline; the message itself does not.
  const trimmed = message.endsWith('\n') ? message.slice(0, -1) : message;
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message: trimmed };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer?: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const author = `${fields.author} ${fields.timestamp} ${tz}`;
  const committer = `${fields.committer ?? fields.author} ${fields.timestamp} ${tz}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  return {
    object,
    type: (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: { object: string; type: ObjType; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${fields.message}`,
    'utf8',
  );
}

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';

export function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Decode a whole pkt-line stream; throws on a malformed length (never crashes the server — callers catch). */
export function decodePktLines(bytes: Uint8Array): Array<{ kind: PktKind; payload: Buffer }> {
  const buffer = Buffer.from(bytes);
  const out: Array<{ kind: PktKind; payload: Buffer }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buffer.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// packfiles (plain objects; the suite's client only ever sends and expects these)
// -------------------------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let offset = start;
  const first = buffer[offset] ?? 0;
  let size = first & 0x0f;
  let shift = 4;
  let cont = (first & 0x80) !== 0;
  offset += 1;
  while (cont) {
    const byte = buffer[offset] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    cont = (byte & 0x80) !== 0;
    offset += 1;
  }
  return { size, next: offset, first };
}

/** Read a packfile; returns objects keyed by recomputed id. Delta entries are rejected (never sent by the client). */
export function readPack(pack: Uint8Array): Map<string, GitObj> {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObj>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not supported');
    // inflateSync ignores trailing bytes and throws on a truncated stream. Find the stream's
    // length: grow an upper bound that inflates (`hi`, success) from a lower bound that does
    // not (`lo`, failure), then binary-search the smallest succeeding length.
    const rest = buffer.subarray(offset, trailerStart);
    const data = inflateSync(rest);
    let lo = 0;
    let hi = Math.min(16, rest.length);
    for (;;) {
      try {
        if (inflateSync(rest.subarray(0, hi)).equals(data)) break;
      } catch {
        // too short: keep growing
      }
      lo = hi;
      if (hi >= rest.length) throw new Error('pack entry does not inflate');
      hi = Math.min(hi * 2, rest.length);
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      try {
        if (inflateSync(rest.subarray(0, mid)).equals(data)) hi = mid;
        else lo = mid;
      } catch {
        lo = mid;
      }
    }
    const consumed = hi;
    if (data.length !== header.size) throw new Error(`pack entry declares ${header.size} bytes but inflated to ${data.length}`);
    objects.set(hashObject(type, data), { type, data });
    offset += consumed;
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  return objects;
}

// -------------------------------------------------------------------------------------------
// object store + graph traversal
// -------------------------------------------------------------------------------------------

export class ObjectStore {
  readonly objects = new Map<string, GitObj>();

  put(type: ObjType, data: Uint8Array): string {
    const buf = Buffer.from(data);
    const oid = hashObject(type, buf);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data: buf });
    return oid;
  }

  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** All objects reachable from `tips` (commits, tags, trees, blobs). `depth` caps commit generations. */
  reachable(tips: Iterable<string>, depth?: number): { objects: Set<string>; boundary: string[] } {
    const objects = new Set<string>();
    const boundary: string[] = [];
    const seenCommits = new Set<string>();
    let frontier: Array<{ oid: string; dist: number }> = [...tips].map((oid) => ({ oid, dist: 0 }));
    const maxDist = depth === undefined ? Number.POSITIVE_INFINITY : depth - 1;
    while (frontier.length > 0) {
      const next: Array<{ oid: string; dist: number }> = [];
      for (const { oid, dist } of frontier) {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        const obj = this.objects.get(oid);
        if (obj === undefined) throw new Error(`missing object ${oid}`);
        if (obj.type === 'tag') {
          const tag = parseTag(obj.data);
          objects.add(oid);
          if (!seenCommits.has(tag.object)) next.push({ oid: tag.object, dist });
          continue;
        }
        if (obj.type !== 'commit') {
          // A tip that is not a commit/tag (should not happen for wants, but be liberal).
          this.addTreeObjects(oid, objects);
          continue;
        }
        objects.add(oid);
        const commit = parseCommit(obj.data);
        this.addTreeObjects(commit.tree, objects);
        if (dist >= maxDist) {
          if (commit.parents.length > 0) boundary.push(oid);
          continue;
        }
        for (const parent of commit.parents) {
          if (!seenCommits.has(parent)) next.push({ oid: parent, dist: dist + 1 });
        }
      }
      frontier = next;
    }
    return { objects, boundary };
  }

  private addTreeObjects(treeOid: string, into: Set<string>): void {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (into.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) throw new Error(`missing object ${oid}`);
      into.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          const child = this.objects.get(entry.oid);
          if (child === undefined) throw new Error(`missing object ${entry.oid}`);
          if (child.type === 'tree') stack.push(entry.oid);
          else into.add(entry.oid);
        }
      }
    }
  }

  /** Every commit ancestor of `tip` (including `tip`), by walking parents. Throws on a missing object. */
  ancestors(tip: string): Set<string> {
    const out = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid) || oid === ZERO_OID) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) throw new Error(`missing object ${oid}`);
      if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        stack.push(tag.object);
        continue;
      }
      if (obj.type !== 'commit') continue;
      out.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  /** True when `anc` is `tip` or an ancestor of `tip`. */
  isAncestor(anc: string, tip: string): boolean {
    if (anc === tip) return true;
    if (anc === ZERO_OID) return true;
    return this.ancestors(tip).has(anc);
  }

  /** The first common ancestor of two commits (BFS from both sides), or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = this.ancestors(a);
    if (fromA.has(b)) return b;
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (fromA.has(oid)) return oid;
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Flatten a tree into path -> {oid, mode} for every blob (and submodule) under it. */
  flattenTree(treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, path: string): void => {
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, childPath);
        else out.set(childPath, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) a tree from a flat path -> {oid, mode} map; returns the root tree oid. */
  buildTreeFromMap(files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }
}
