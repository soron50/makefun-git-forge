// gitproto.ts — the git smart HTTP transport, implemented from the protocol up: pkt-lines,
// ref advertisement (protocol v0 and v2), ls-refs, fetch (v2 command and v0 multi_ack),
// and receive-pack with pack validation, fast-forward checks and report-status. Packs are
// read and written with gitstore.ts; there is no git binary anywhere in the loop.

import { ZERO_OID, peelToCommit, readPack, writePack, type GitObject } from './gitstore.ts';
import type { Forge, Repo } from './forge.ts';
import { readBody, type Ctx } from './web.ts';

const AGENT = 'makefun-forge/1.0.0';
const UPLOAD_CAPS = [
  'multi_ack_detailed', 'no-done', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow',
  'deepen-since', 'deepen-not', 'deepen-relative', 'object-format=sha1', `agent=${AGENT}`,
].join(' ');
const RECEIVE_CAPS = [
  'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'object-format=sha1', `agent=${AGENT}`,
].join(' ');

// ---------------------------------------------------------------------------------------------
// pkt-lines

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length > 65516) throw new Error('pkt-line payload too large');
  const header = (payload.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

type PktEvent =
  | { type: 'line'; data: Buffer }
  | { type: 'flush' }
  | { type: 'delim' }
  | { type: 'response-end' };

class PktReader {
  private offset = 0;
  private readonly buffer: Buffer;
  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  /** The next event, or null at end of input. Throws on malformed framing. */
  next(): PktEvent | null {
    if (this.offset >= this.buffer.length) return null;
    if (this.offset + 4 > this.buffer.length) throw new Error('truncated pkt-line header');
    const header = this.buffer.subarray(this.offset, this.offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header '${header}'`);
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { type: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { type: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { type: 'response-end' };
    }
    if (length < 4) throw new Error(`invalid pkt-line length ${length}`);
    if (this.offset + length > this.buffer.length) throw new Error('truncated pkt-line payload');
    const data = this.buffer.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { type: 'line', data };
  }

  /** All remaining raw bytes (the packfile that follows a receive-pack command block). */
  rest(): Buffer {
    return this.buffer.subarray(this.offset);
  }
}

function readLinesUntilFlush(reader: PktReader): string[] {
  const lines: string[] = [];
  for (;;) {
    const event = reader.next();
    if (event === null || event.type === 'flush') return lines;
    if (event.type === 'line') lines.push(event.data.toString('utf8').replace(/\n$/, ''));
  }
}

// ---------------------------------------------------------------------------------------------
// ref advertisement

interface RefLine {
  oid: string;
  name: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ oid, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertisementV0(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `${UPLOAD_CAPS} symref=HEAD:${headTarget(repo)}`
    : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo)) ?? null;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(forge.store, ref.oid);
        if (peeled && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

export function handleInfoRefs(ctx: Ctx, repo: Repo, service: string | null): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    ctx.res.writeHead(403, { 'Content-Type': 'text/plain', 'X-GitHub-Request-Id': ctx.requestId });
    ctx.res.end('only git-upload-pack and git-receive-pack are supported');
    return;
  }
  const protocol = ctx.req.headers['git-protocol'];
  const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
  const body = isV2 && service === 'git-upload-pack'
    ? advertisementV2()
    : advertisementV0(ctx.forge, repo, service);
  ctx.res.writeHead(200, {
    'Content-Type': `application/x-${service}-advertisement`,
    'Cache-Control': 'no-cache',
    'X-GitHub-Request-Id': ctx.requestId,
  });
  ctx.res.end(body);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

function lsRefs(forge: Forge, repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  for (const arg of args) {
    if (arg === 'peel') wantPeel = true;
    else if (arg === 'symrefs') wantSymrefs = true;
    else if (arg === 'unborn') wantUnborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target) ?? null;
  if (matches('HEAD')) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (wantUnborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${target}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(forge.store, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch: object selection with shallow/deepen semantics

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function selectFetchObjects(forge: Forge, repo: Repo, request: FetchRequest): FetchSelection {
  const store = forge.store;
  const wantCommits: string[] = [];
  const extraRoots: string[] = [];
  for (const want of request.wants) {
    const commit = peelToCommit(store, want);
    if (commit) wantCommits.push(commit);
    if (want !== commit) extraRoots.push(want);
  }

  // Included commits: full closure, or a depth-limited BFS when deepen is in play.
  const included = new Set<string>();
  if (request.deepen !== null) {
    const depth = Math.max(1, request.deepen);
    let frontier = [...new Set(wantCommits)];
    for (const commit of frontier) included.add(commit);
    let generation = 1;
    while (generation < depth && frontier.length) {
      const next: string[] = [];
      for (const commit of frontier) {
        const object = store.get(commit);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseParents(object.data)) {
          if (!included.has(parent)) {
            included.add(parent);
            next.push(parent);
          }
        }
      }
      frontier = next;
      generation += 1;
    }
  } else if (request.deepenSince !== null) {
    const since = request.deepenSince;
    const queue = [...new Set(wantCommits)];
    while (queue.length) {
      const commit = queue.pop()!;
      if (included.has(commit)) continue;
      const object = store.get(commit);
      if (!object || object.type !== 'commit') continue;
      if (commitTime(object.data) < since) continue;
      included.add(commit);
      for (const parent of parseParents(object.data)) queue.push(parent);
    }
  } else {
    for (const commit of wantCommits) {
      for (const oid of store.reachable([commit])) {
        const object = store.get(oid);
        if (object?.type === 'commit') included.add(oid);
      }
    }
  }

  // Boundary: included commits with a parent that exists but is not included.
  const boundary = new Set<string>();
  for (const commit of included) {
    const object = store.get(commit);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseParents(object.data)) {
      if (!included.has(parent) && store.has(parent)) boundary.add(commit);
    }
  }

  // Exclusions: full closure of ordinary haves; tree-only closure of shallow haves;
  // full closure of deepen-not refs.
  const excluded = new Set<string>();
  const shallowHaves = new Set(request.shallowLines);
  for (const have of request.haves) {
    if (!store.has(have)) continue;
    if (shallowHaves.has(have)) {
      for (const oid of store.treeClosure(have)) excluded.add(oid);
    } else {
      for (const oid of store.reachable([have], { allowMissing: true })) excluded.add(oid);
    }
  }
  for (const notRef of request.deepenNot) {
    const tip = forge.resolveRef(repo, notRef);
    if (tip) for (const oid of store.reachable([tip], { allowMissing: true })) excluded.add(oid);
  }

  const objectIds = new Set<string>();
  for (const commit of included) {
    for (const oid of store.treeClosure(commit)) objectIds.add(oid);
  }
  for (const root of extraRoots) {
    for (const oid of store.reachable([root], { allowMissing: true })) objectIds.add(oid);
  }
  for (const oid of excluded) objectIds.delete(oid);

  const objects: GitObject[] = [];
  for (const oid of objectIds) {
    const object = store.get(oid);
    if (object) objects.push(object);
  }
  const clientShallow = new Set(request.shallowLines);
  const unshallow = [...clientShallow].filter((oid) => included.has(oid) && !boundary.has(oid));
  return { objects, shallow: [...boundary], unshallow };
}

// Fetch results are pure functions of the request and the store's contents, so identical
// fetches (a burst of clones of the same tip) share one selection and one packfile. The
// store's version counter — bumped whenever an object lands — plus the resolved deepen-not
// tips make the memo key exact; the moment anything changes, the key changes with it.
interface FetchCacheEntry {
  selection: FetchSelection;
  pack: Buffer;
}
const fetchCache = new Map<string, FetchCacheEntry>();
const FETCH_CACHE_LIMIT = 16;

function cachedFetch(forge: Forge, repo: Repo, request: FetchRequest): FetchCacheEntry {
  const key = [
    forge.store.version,
    request.wants.join(','),
    request.haves.join(','),
    request.shallowLines.join(','),
    request.deepen ?? '',
    request.deepenSince ?? '',
    request.deepenNot.map((ref) => forge.resolveRef(repo, ref) ?? ref).join(','),
  ].join('|');
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const selection = selectFetchObjects(forge, repo, request);
  const entry: FetchCacheEntry = { selection, pack: writePack(selection.objects) };
  if (fetchCache.size >= FETCH_CACHE_LIMIT) fetchCache.clear();
  fetchCache.set(key, entry);
  return entry;
}

function parseParents(commitData: Buffer): string[] {
  const text = commitData.toString('utf8');
  const parents: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice('parent '.length).trim());
    if (line === '') break;
  }
  return parents;
}

function commitTime(commitData: Buffer): number {
  const text = commitData.toString('utf8');
  const match = /^committer .* (\d+) [+-]\d{4}$/m.exec(text);
  return match ? Number(match[1]) : 0;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = {
    wants: [], haves: [], shallowLines: [], deepen: null, deepenSince: null, deepenNot: [], done: false,
  };
  for (const rawLine of lines) {
    const line = rawLine.split('\0')[0]!; // v0 want lines carry capabilities after a NUL
    if (line.startsWith('want ')) request.wants.push(line.slice('want '.length).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice('have '.length).trim());
    else if (line.startsWith('shallow ')) request.shallowLines.push(line.slice('shallow '.length).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice('deepen '.length));
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice('deepen-since '.length));
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice('deepen-not '.length).trim());
    else if (line === 'done') request.done = true;
  }
  return request;
}

export async function handleUploadPack(ctx: Ctx, repo: Repo): Promise<void> {
  const body = await readBody(ctx);
  const reader = new PktReader(body);
  const first = reader.next();
  if (first && first.type === 'line' && first.data.toString('utf8').startsWith('command=')) {
    const commandLine = first.data.toString('utf8').replace(/\n$/, '');
    const command = commandLine.slice('command='.length);
    // Capability lines run until the delimiter packet.
    for (;;) {
      const event = reader.next();
      if (event === null || event.type !== 'line') break;
    }
    const args = readLinesUntilFlush(reader);
    if (command === 'ls-refs') {
      const payload = lsRefs(ctx.forge, repo, args);
      ctx.res.writeHead(200, {
        'Content-Type': 'application/x-git-upload-pack-result',
        'Cache-Control': 'no-cache',
        'X-GitHub-Request-Id': ctx.requestId,
      });
      ctx.res.end(payload);
      return;
    }
    if (command === 'fetch') {
      const request = parseFetchArgs(args);
      const { selection, pack } = cachedFetch(ctx.forge, repo, request);
      const parts: Buffer[] = [];
      // acknowledgments
      const ackLines: string[] = [];
      const common = request.haves.filter((have) => ctx.forge.store.has(have));
      if (common.length === 0) ackLines.push('NAK');
      else {
        for (const have of common) ackLines.push(`ACK ${have}`);
        ackLines[ackLines.length - 1] = `ACK ${common[common.length - 1]} ready`;
      }
      parts.push(pktLine('acknowledgments\n'), ...ackLines.map((line) => pktLine(`${line}\n`)), pktFlush());
      if (request.shallowLines.length || request.deepen !== null || request.deepenSince !== null) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(pktFlush());
      }
      parts.push(pktLine('packfile\n'), ...sidebandPackets(pack), pktFlush());
      ctx.res.writeHead(200, {
        'Content-Type': 'application/x-git-upload-pack-result',
        'Cache-Control': 'no-cache',
        'X-GitHub-Request-Id': ctx.requestId,
      });
      ctx.res.end(Buffer.concat(parts));
      return;
    }
    throw new Error(`unsupported v2 command ${command}`);
  }

  // Protocol v0: wants in the first block, haves after the flush, then done.
  const wantLines: string[] = [];
  if (first && first.type === 'line') wantLines.push(first.data.toString('utf8').replace(/\n$/, ''));
  wantLines.push(...readLinesUntilFlush(reader));
  const haveLines = readLinesUntilFlush(reader);
  const request = parseFetchArgs([...wantLines, ...haveLines]);
  const { selection, pack } = cachedFetch(ctx.forge, repo, request);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = request.haves.filter((have) => ctx.forge.store.has(have));
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${common[common.length - 1]} ready\n`));
  parts.push(...sidebandPackets(pack), pktFlush());
  ctx.res.writeHead(200, {
    'Content-Type': 'application/x-git-upload-pack-result',
    'Cache-Control': 'no-cache',
    'X-GitHub-Request-Id': ctx.requestId,
  });
  ctx.res.end(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(ctx: Ctx, repo: Repo): Promise<void> {
  const { forge } = ctx;
  const body = await readBody(ctx);
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let sideBand = false;
  let reportStatus = false;
  for (;;) {
    const event = reader.next();
    if (event === null || event.type === 'flush') break;
    if (event.type !== 'line') break;
    let text = event.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k') || caps.includes('side-band')) sideBand = true;
      if (caps.includes('report-status')) reportStatus = true;
      text = text.slice(0, nul);
    }
    const fields = text.split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
    }
  }
  const packBytes = reader.rest();

  const reportLines: string[] = [];
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => forge.store.get(oid) });
      for (const [oid, object] of objects) forge.store.add(oid, object);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError.replace(/[\r\n]+/g, ' ')}`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  } else {
    reportLines.push('unpack ok');
    for (const command of commands) {
      reportLines.push(applyPushCommand(forge, repo, command));
    }
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
  let payload: Buffer;
  if (sideBand) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, offset + CHUNK)])));
    }
    parts.push(pktFlush());
    payload = Buffer.concat(parts);
  } else {
    payload = reportStream;
  }
  void reportStatus;
  ctx.res.writeHead(200, {
    'Content-Type': 'application/x-git-receive-pack-result',
    'Cache-Control': 'no-cache',
    'X-GitHub-Request-Id': ctx.requestId,
  });
  ctx.res.end(payload);
}

function applyPushCommand(forge: Forge, repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return `ng ${ref} stale info`;
  if (newOid === ZERO_OID) {
    // Deletion.
    if (ref === headTarget(repo)) return `ng ${ref} deletion of the current branch prohibited`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const object = forge.store.get(newOid);
  if (!object) return `ng ${ref} missing object ${newOid}`;
  if (oldOid !== ZERO_OID) {
    const oldCommit = peelToCommit(forge.store, oldOid);
    const newCommit = peelToCommit(forge.store, newOid);
    if (oldCommit && newCommit && oldCommit !== newCommit && !forge.isAncestor(repo, oldCommit, newCommit)) {
      return `ng ${ref} non-fast-forward`;
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
