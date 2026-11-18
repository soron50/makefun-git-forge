// forge.ts — the forge's domain model: repositories, refs, labels, issues, pull requests,
// comments, the contents API's tree surgery, and three-way squash merges. Everything is held
// in memory and layered on the object store in gitstore.ts.
//
// Commit timestamps come from a deterministic per-forge counter so server-created commits
// are stable and reproducible within a run.

import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  diffFlat,
  flattenTree,
  lineCounts,
  parseCommit,
  peelToCommit,
  type FlatEntry,
  type FileChange,
} from './gitstore.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';
const BASE_EPOCH = 1739175597; // a fixed base so commit timestamps are deterministic
const FORGE_IDENT = 'makefun forge <forge@localhost>';
const VIEWER_IDENT = `${VIEWER.name} <${VIEWER.email}>`;

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  comments: Comment[];
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  body: string;
  readonly headRef: string;
  readonly baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string | null;
  readonly defaultBranch: string;
  readonly createdAt: number;
  refs: Map<string, string>; // full ref name ("refs/heads/main") -> object id
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // one shared counter for issues and pulls, GitHub-style
  commitSeq: number;
}

export interface MergeOutcome {
  readonly ok: boolean;
  readonly conflict: boolean;
  readonly sha: string | null;
}

export class Forge {
  readonly store = new ObjectStore();
  private reposByKey = new Map<string, Repo>();
  private reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  private nextCommentId = 1;
  private clock = 0;

  now(): number {
    this.clock += 1;
    return BASE_EPOCH + this.clock;
  }

  iso(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toISOString();
  }

  // -------------------------------------------------------------------------------------------
  // repositories

  createRepo(owner: string, name: string, isPrivate: boolean, description: string | null): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: this.now(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      commitSeq: 0,
    };
    this.reposByKey.set(repoKey(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(repoKey(owner, name));
  }

  repoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repo(owner, name);
    if (!repo) return false;
    this.reposByKey.delete(repoKey(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  reposOf(owner: string): Repo[] {
    return [...this.reposByKey.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.id - b.id);
  }

  // -------------------------------------------------------------------------------------------
  // refs

  /** Resolve a branch name, a full ref, or (rarely) an object id to a commit id. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return peelToCommit(this.store, repo.refs.get(ref)!);
    const asBranch = `refs/heads/${ref}`;
    if (repo.refs.has(asBranch)) return peelToCommit(this.store, repo.refs.get(asBranch)!);
    const asTag = `refs/tags/${ref}`;
    if (repo.refs.has(asTag)) return peelToCommit(this.store, repo.refs.get(asTag)!);
    if (repo.refs.has(`refs/${ref}`)) return peelToCommit(this.store, repo.refs.get(`refs/${ref}`)!);
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = this.store.get(ref);
      if (object?.type === 'commit') return ref;
      if (object) return peelToCommit(this.store, ref);
    }
    return null;
  }

  refTip(repo: Repo, ref: string): string | null {
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const asBranch = `refs/heads/${ref}`;
    if (repo.refs.has(asBranch)) return repo.refs.get(asBranch)!;
    const asTag = `refs/tags/${ref}`;
    if (repo.refs.has(asTag)) return repo.refs.get(asTag)!;
    return null;
  }

  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Walk commits from a tip, newest first (topological order via DFS on parents). */
  listCommits(repo: Repo, tip: string, limit = 10000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.store.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const commit = parseCommit(object.data);
      for (let index = commit.parents.length - 1; index >= 0; index -= 1) stack.push(commit.parents[index]!);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === ancestor) return true;
      const object = this.store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestors = new Set(this.listCommits(repo, a));
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = this.store.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  treeOfCommit(commitOid: string): string | null {
    const object = this.store.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  flatOfCommit(commitOid: string | null): Map<string, FlatEntry> {
    if (!commitOid) return new Map();
    const tree = this.treeOfCommit(commitOid);
    if (!tree) return new Map();
    return flattenTree(this.store, tree);
  }

  // -------------------------------------------------------------------------------------------
  // server-created commits (contents API, merges)

  private nextAuthorLine(repo: Repo): { line: string; epoch: number } {
    repo.commitSeq += 1;
    const epoch = BASE_EPOCH + repo.commitSeq;
    return { line: `${FORGE_IDENT} ${epoch} +0000`, epoch };
  }

  /** Create a commit on `branch` whose tree is `tree`; returns the new commit id. */
  commitOnBranch(repo: Repo, branch: string, tree: string, message: string, parents?: string[]): string {
    const ref = `refs/heads/${branch}`;
    const existing = repo.refs.get(ref);
    const parentList = parents ?? (existing ? [existing] : []);
    const { line } = this.nextAuthorLine(repo);
    const data = buildCommit({ tree, parents: parentList, author: line, committer: line, message });
    const oid = this.store.put('commit', data);
    repo.refs.set(ref, oid);
    return oid;
  }

  /**
   * The contents API: put or delete a file. Returns the new commit id and the blob id.
   * Throws an Error whose message the REST layer maps to a status code.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer | null,
    message: string,
    branchName: string | null,
    expectedBlobSha: string | null,
  ): { commitSha: string; blobSha: string | null } {
    const branch = branchName ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (!tip && branchName !== null) {
      // A named-but-missing branch is created from the default branch tip (GitHub-compatible
      // behaviour the suite's setup relies on), then the commit lands on it.
      tip = this.defaultTip(repo);
    }
    const flat = this.flatOfCommit(tip);
    const existing = flat.get(path);
    const parents = tip ? [tip] : [];
    if (content === null) {
      if (!existing) throw new Error('not_found');
      if (expectedBlobSha !== null && existing.oid !== expectedBlobSha) throw new Error('stale_sha');
      flat.delete(path);
      const tree = buildTreeFromFlat(this.store, flat);
      const commitSha = this.commitOnBranch(repo, branch, tree, message, parents);
      return { commitSha, blobSha: null };
    }
    if (existing && expectedBlobSha !== null && existing.oid !== expectedBlobSha) throw new Error('stale_sha');
    if (existing && expectedBlobSha === null) throw new Error('needs_sha');
    const blobSha = this.store.put('blob', content);
    flat.set(path, { mode: existing?.mode ?? '100644', oid: blobSha });
    const tree = buildTreeFromFlat(this.store, flat);
    const commitSha = this.commitOnBranch(repo, branch, tree, message, parents);
    return { commitSha, blobSha };
  }

  // -------------------------------------------------------------------------------------------
  // issues, labels, comments

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: 'unknown_label' } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: 'unknown_label' };
      labels.push(label);
    }
    const at = this.now();
    const issue: Issue = {
      id: this.nextEntityId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, createdAt: this.now() };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): Pull {
    const at = this.now();
    const pull: Pull = {
      id: this.nextEntityId++,
      number: repo.nextNumber++,
      title,
      body,
      headRef,
      baseRef,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  pullTips(repo: Repo, pull: Pull): { headSha: string | null; baseSha: string | null } {
    return {
      headSha: this.resolveRef(repo, pull.headRef),
      baseSha: this.resolveRef(repo, pull.baseRef),
    };
  }

  /** File-level diff of a pull: the base branch tip against the head branch tip. */
  pullChanges(repo: Repo, pull: Pull): FileChange[] {
    const { headSha, baseSha } = this.pullTips(repo, pull);
    if (!headSha || !baseSha) return [];
    const mergeBase = this.mergeBase(repo, baseSha, headSha) ?? baseSha;
    return diffFlat(this.flatOfCommit(mergeBase), this.flatOfCommit(headSha));
  }

  changeCounts(change: FileChange): { additions: number; deletions: number } {
    if (change.status === 'added') {
      const data = change.newOid ? this.store.get(change.newOid)?.data : undefined;
      const text = data ? data.toString('utf8') : '';
      return { additions: text === '' ? 0 : text.split('\n').length, deletions: 0 };
    }
    if (change.status === 'removed') {
      const data = change.oldOid ? this.store.get(change.oldOid)?.data : undefined;
      const text = data ? data.toString('utf8') : '';
      return { additions: 0, deletions: text === '' ? 0 : text.split('\n').length };
    }
    const oldText = change.oldOid ? (this.store.get(change.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = change.newOid ? (this.store.get(change.newOid)?.data.toString('utf8') ?? '') : '';
    return lineCounts(oldText, newText);
  }

  /** Would a three-way merge of this pull into its base conflict? (UNKNOWN when refs are gone.) */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state === 'closed' && pull.merged) return 'MERGEABLE';
    const { headSha, baseSha } = this.pullTips(repo, pull);
    if (!headSha || !baseSha) return 'UNKNOWN';
    const outcome = this.tryMerge(repo, baseSha, headSha);
    if (outcome === null) return 'UNKNOWN';
    return outcome ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** Three-way merge test: true when clean, false on conflict, null when it cannot be judged. */
  private tryMerge(repo: Repo, baseTip: string, headTip: string): boolean | null {
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    if (!mergeBase) return null;
    const base = this.flatOfCommit(mergeBase);
    const ours = this.flatOfCommit(baseTip);
    const theirs = this.flatOfCommit(headTip);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const baseEntry = base.get(path)?.oid ?? null;
      const oursEntry = ours.get(path)?.oid ?? null;
      const theirsEntry = theirs.get(path)?.oid ?? null;
      if (oursEntry === theirsEntry) continue;
      if (baseEntry === oursEntry) continue; // only head changed it
      if (baseEntry === theirsEntry) continue; // only base changed it
      return false;
    }
    return true;
  }

  /** Squash-merge a pull into its base branch: one new commit carrying the merged tree. */
  squashMerge(repo: Repo, pull: Pull): MergeOutcome {
    const { headSha, baseSha } = this.pullTips(repo, pull);
    if (!headSha || !baseSha) return { ok: false, conflict: false, sha: null };
    const mergeBase = this.mergeBase(repo, baseSha, headSha);
    if (!mergeBase) return { ok: false, conflict: true, sha: null };
    const base = this.flatOfCommit(mergeBase);
    const ours = this.flatOfCommit(baseSha);
    const theirs = this.flatOfCommit(headSha);
    const merged = new Map<string, FlatEntry>(ours);
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const baseEntry = base.get(path);
      const oursEntry = ours.get(path);
      const theirsEntry = theirs.get(path);
      const baseOid = baseEntry?.oid ?? null;
      const oursOid = oursEntry?.oid ?? null;
      const theirsOid = theirsEntry?.oid ?? null;
      if (oursOid === theirsOid) continue;
      if (baseOid === oursOid) {
        // Only the head side changed this path: take its version (or its deletion).
        if (theirsEntry) merged.set(path, theirsEntry);
        else merged.delete(path);
        continue;
      }
      if (baseOid === theirsOid) continue; // only the base side changed it
      return { ok: false, conflict: true, sha: null };
    }
    const tree = buildTreeFromFlat(this.store, merged);
    const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
    const sha = this.commitOnBranch(repo, pull.baseRef, tree, message, [baseSha]);
    const at = this.now();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = at;
    pull.closedAt = at;
    pull.updatedAt = at;
    pull.mergeCommitSha = sha;
    return { ok: true, conflict: false, sha };
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export { VIEWER_IDENT };
