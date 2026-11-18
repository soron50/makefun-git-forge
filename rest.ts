// rest.ts — the REST v3 API under /api/v3: repositories, branches, git refs, commits,
// contents, labels, issues, comments and pull requests, GitHub-shaped.

import { VIEWER, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { parseCommit, parseTree, type FlatEntry } from './gitstore.ts';
import { isRecord, paginate, readJsonBody, sendEmpty, sendError, sendJson, type Ctx } from './web.ts';

const API_VERSION = 'makefun-forge 1.0.0';

// ---------------------------------------------------------------------------------------------
// serializers

export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 0,
    type: 'User',
    site_admin: false,
    name: login === VIEWER.login ? VIEWER.name : login,
    email: login === VIEWER.login ? VIEWER.email : null,
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(repo.owner),
    description: repo.description,
    fork: false,
    created_at: forge.iso(repo.createdAt),
    updated_at: forge.iso(repo.createdAt),
    pushed_at: forge.iso(repo.createdAt),
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    forks_count: 0,
    watchers_count: 0,
    stargazers_count: 0,
    size: 0,
    language: null,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    license: null,
  };
}

export function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  let hash = 0;
  for (const ch of label.name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return { id: Math.abs(hash) || 1, name: label.name, color: label.color, default: false, description: null };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(repo.owner),
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    author_association: 'OWNER',
    created_at: forge.iso(issue.createdAt),
    updated_at: forge.iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : forge.iso(issue.closedAt),
  };
}

export function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(repo.owner),
    author_association: 'OWNER',
    created_at: forge.iso(comment.createdAt),
    updated_at: forge.iso(comment.createdAt),
    issue_number: issue.number,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const { headSha, baseSha } = forge.pullTips(repo, pull);
  const refJson = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha: sha ?? '',
    user: userJson(repo.owner),
    repo: repoJson(forge, repo),
  });
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(repo.owner),
    labels: [],
    draft: false,
    head: refJson(pull.headRef, headSha),
    base: refJson(pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : forge.iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.closedAt === null ? null : forge.iso(pull.closedAt),
    created_at: forge.iso(pull.createdAt),
    updated_at: forge.iso(pull.updatedAt),
    author_association: 'OWNER',
    mergeable: null,
    rebaseable: null,
    maintainer_can_modify: false,
    comments: 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = forge.store.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: userJson(repo.owner),
    committer: userJson(repo.owner),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function commitSummaryJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> {
  const object = forge.store.get(sha);
  if (!object || object.type !== 'commit') return { sha };
  const commit = parseCommit(object.data);
  return {
    sha,
    author: identJson(commit.author),
    committer: identJson(commit.committer),
    message: commit.message,
    tree: { sha: commit.tree },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// routing

export async function handleRest(ctx: Ctx, segments: string[]): Promise<void> {
  const { forge } = ctx;
  const method = ctx.method;

  if (segments.length === 0) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, {
      installed_version: API_VERSION,
      is_authenticated: true,
      is_student: false,
      can_upgrade: false,
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, userJson(VIEWER.login));
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paginate(ctx, forge.reposOf(VIEWER.login));
      return sendJson(ctx, 200, slice.map((repo) => repoJson(forge, repo)), headers);
    }
    if (method === 'POST') return createRepo(ctx);
    return sendError(ctx, 404, 'Not Found');
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    return repoRoutes(ctx, owner, name, segments.slice(3));
  }
  return sendError(ctx, 404, 'Not Found');
}

async function createRepo(ctx: Ctx): Promise<void> {
  const parsed = await readJsonBody(ctx);
  if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
  const body = parsed.value;
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return sendError(ctx, 422, 'Repository creation failed: name is required');
  if (ctx.forge.repo(VIEWER.login, name)) {
    return sendError(ctx, 422, 'Repository creation failed: name already exists on this account');
  }
  const repo = ctx.forge.createRepo(
    VIEWER.login,
    name,
    body.private === true,
    typeof body.description === 'string' ? body.description : null,
  );
  return sendJson(ctx, 201, repoJson(ctx.forge, repo));
}

async function repoRoutes(ctx: Ctx, owner: string, name: string, rest: string[]): Promise<void> {
  const { forge, method } = ctx;
  const repo = forge.repo(owner, name);
  if (!repo) return sendError(ctx, 404, 'Not Found');

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(ctx, 200, repoJson(forge, repo));
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return sendEmpty(ctx, 204);
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
      if (typeof parsed.value.description === 'string' || parsed.value.description === null) {
        repo.description = parsed.value.description as string | null;
      }
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.name === 'string' && parsed.value.name) repoNameRename(forge, repo, parsed.value.name);
      return sendJson(ctx, 200, repoJson(forge, repo));
    }
    return sendError(ctx, 404, 'Not Found');
  }

  const head = rest[0]!;
  if (head === 'branches') return branchRoutes(ctx, repo, rest.slice(1));
  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
    const shaParam = ctx.url.searchParams.get('sha');
    const tip = shaParam ? forge.resolveRef(repo, shaParam) : forge.defaultTip(repo);
    if (!tip) return sendJson(ctx, 200, []);
    const list = forge.listCommits(repo, tip).map((sha) => commitJson(forge, repo, sha)!).filter(Boolean);
    return sendJson(ctx, 200, list);
  }
  if (head === 'git' && rest[1] === 'refs') return gitRefRoutes(ctx, repo, rest.slice(2));
  if (head === 'contents') return contentsRoutes(ctx, repo, rest.slice(1));
  if (head === 'labels') return labelRoutes(ctx, repo, rest.slice(1));
  if (head === 'issues') return issueRoutes(ctx, repo, rest.slice(1));
  if (head === 'pulls') return pullRoutes(ctx, repo, rest.slice(1));
  return sendError(ctx, 404, 'Not Found');
}

function repoNameRename(forge: Forge, repo: Repo, newName: string): void {
  // Renames are accepted for API compatibility; the forge keeps the repository addressable
  // under its new name by re-keying the map.
  const old = forge.repo(repo.owner, repo.name);
  if (!old) return;
  forge.deleteRepo(repo.owner, repo.name);
  const created = forge.createRepo(repo.owner, newName, repo.isPrivate, repo.description);
  created.refs = repo.refs;
  created.labels = repo.labels;
  created.issues = repo.issues;
  created.pulls = repo.pulls;
  created.nextNumber = repo.nextNumber;
}

// ---------------------------------------------------------------------------------------------
// branches and git refs

function branchRoutes(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { forge, method } = ctx;
  if (method !== 'GET') return sendError(ctx, 404, 'Not Found');
  if (rest.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return sendJson(ctx, 200, branches);
  }
  const branch = rest.map(decodeURIComponent).join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return sendError(ctx, 404, 'Not Found');
  return sendJson(ctx, 200, { name: branch, commit: { sha }, protected: false });
}

async function gitRefRoutes(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> {
  const { forge, method } = ctx;
  if (method === 'POST' && rest.length === 0) {
    const parsed = await readJsonBody(ctx);
    if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
    const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
    if (!ref.startsWith('refs/') || !forge.store.get(sha)) {
      return sendError(ctx, 422, 'Validation failed: ref or sha is invalid');
    }
    if (repo.refs.has(ref)) return sendError(ctx, 422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return sendJson(ctx, 201, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } });
  }
  if (method === 'GET' && rest.length >= 1) {
    const ref = `refs/${rest.map(decodeURIComponent).join('/')}`;
    const sha = repo.refs.get(ref);
    if (!sha) return sendError(ctx, 404, 'Not Found');
    const object = forge.store.get(sha);
    return sendJson(ctx, 200, { ref, node_id: `REF_${ref}`, object: { sha, type: object?.type ?? 'commit' } });
  }
  return sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// contents

function contentsRoutes(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> | void {
  const { forge, method } = ctx;
  const path = rest.map(decodeURIComponent).join('/');
  const refParam = ctx.url.searchParams.get('ref');
  if (method === 'GET') {
    const tip = refParam ? forge.resolveRef(repo, refParam) : forge.defaultTip(repo);
    if (!tip) return sendError(ctx, 404, 'Not Found');
    const tree = forge.treeOfCommit(tip);
    if (!tree) return sendError(ctx, 404, 'Not Found');
    return sendContentsGet(ctx, repo, tree, path);
  }
  if (method === 'PUT') return contentsPut(ctx, repo, path);
  if (method === 'DELETE') return contentsDelete(ctx, repo, path);
  return sendError(ctx, 404, 'Not Found');
}

function sendContentsGet(ctx: Ctx, repo: Repo, rootTree: string, path: string): void {
  const { forge } = ctx;
  // Walk the tree objects to the requested path.
  let treeOid = rootTree;
  const segments = path === '' ? [] : path.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const object = forge.store.get(treeOid);
    if (!object || object.type !== 'tree') return sendError(ctx, 404, 'Not Found');
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return sendError(ctx, 404, 'Not Found');
    if (index === segments.length - 1) {
      if (entry.mode === '40000') return sendDirListing(ctx, repo, entry.oid, path);
      const blob = forge.store.get(entry.oid);
      if (!blob) return sendError(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, {
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
    }
    if (entry.mode !== '40000') return sendError(ctx, 404, 'Not Found');
    treeOid = entry.oid;
  }
  return sendDirListing(ctx, repo, rootTree, '');
}

function sendDirListing(ctx: Ctx, repo: Repo, treeOid: string, prefix: string): void {
  const object = ctx.forge.store.get(treeOid);
  if (!object || object.type !== 'tree') return sendError(ctx, 404, 'Not Found');
  const entries = parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : ctx.forge.store.get(entry.oid);
    return {
      name: entry.name,
      path: prefix ? `${prefix}/${entry.name}` : entry.name,
      sha: entry.oid,
      size: blob ? blob.data.length : 0,
      type: isDir ? 'dir' : 'file',
    };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sendJson(ctx, 200, entries);
}

async function contentsPut(ctx: Ctx, repo: Repo, path: string): Promise<void> {
  const { forge } = ctx;
  if (!path) return sendError(ctx, 422, 'Validation failed: path is required');
  const parsed = await readJsonBody(ctx);
  if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
  const body = parsed.value;
  const message = typeof body.message === 'string' ? body.message : 'update';
  const branch = typeof body.branch === 'string' ? body.branch : null;
  const expectedSha = typeof body.sha === 'string' ? body.sha : null;
  const contentBase64 = typeof body.content === 'string' ? body.content.replace(/\s+/g, '') : '';
  const content = Buffer.from(contentBase64, 'base64');
  const tip = (branch ? forge.refTip(repo, `refs/heads/${branch}`) : null) ?? forge.defaultTip(repo);
  const existed = tip ? forge.flatOfCommit(tip).has(path) : false;
  try {
    const result = forge.putContent(repo, path, content, message, branch, expectedSha);
    return sendJson(ctx, existed ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: result.blobSha,
        size: content.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: commitSummaryJson(forge, repo, result.commitSha),
    });
  } catch (error) {
    return contentsError(ctx, error);
  }
}

async function contentsDelete(ctx: Ctx, repo: Repo, path: string): Promise<void> {
  const { forge } = ctx;
  const parsed = await readJsonBody(ctx);
  if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
  const body = parsed.value;
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const branch = typeof body.branch === 'string' ? body.branch : null;
  const expectedSha = typeof body.sha === 'string' ? body.sha : null;
  try {
    const result = forge.putContent(repo, path, null, message, branch, expectedSha);
    return sendJson(ctx, 200, { content: null, commit: commitSummaryJson(forge, repo, result.commitSha) });
  } catch (error) {
    return contentsError(ctx, error);
  }
}

function contentsError(ctx: Ctx, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'stale_sha') return sendError(ctx, 409, 'Conflict: the file sha does not match');
  if (message === 'not_found') return sendError(ctx, 404, 'Not Found');
  if (message === 'needs_sha') return sendError(ctx, 422, 'Validation failed: sha is required when updating a file');
  return sendError(ctx, 500, 'Internal Server Error');
}

// ---------------------------------------------------------------------------------------------
// labels

async function labelRoutes(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> {
  const { forge, method } = ctx;
  if (rest.length !== 0) return sendError(ctx, 404, 'Not Found');
  if (method === 'GET') return sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
  if (method !== 'POST') return sendError(ctx, 404, 'Not Found');
  const parsed = await readJsonBody(ctx);
  if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
  const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
  const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
  if (!name) return sendError(ctx, 422, 'Validation failed: name is required');
  if (repo.labels.has(name)) return sendError(ctx, 422, 'Validation failed: label already exists');
  const label = forge.createLabel(repo, name, color);
  return sendJson(ctx, 201, labelJson(label));
}

// ---------------------------------------------------------------------------------------------
// issues and comments

async function issueRoutes(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> {
  const { forge, method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const sort = ctx.url.searchParams.get('sort') ?? 'created';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (sort === 'created' ? a.number - b.number : a.number - b.number));
      if (direction !== 'asc') issues.reverse();
      const { slice, headers } = paginate(ctx, issues);
      return sendJson(ctx, 200, slice.map((issue) => issueJson(forge, repo, issue)), headers);
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
      const body = parsed.value;
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) return sendError(ctx, 422, 'Validation failed: title is required');
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
        }
      }
      const created = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
      if ('error' in created) return sendError(ctx, 422, 'Validation failed: unknown label');
      return sendJson(ctx, 201, issueJson(forge, repo, created));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(ctx, 404, 'Not Found');
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (!issue) return sendError(ctx, 404, 'Not Found');
    if (method === 'GET') return sendJson(ctx, 200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
      const body = parsed.value;
      if (typeof body.title === 'string') (issue as { title: string }).title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? forge.now() : null;
      }
      issue.updatedAt = forge.now();
      return sendJson(ctx, 200, issueJson(forge, repo, issue));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return sendError(ctx, 404, 'Not Found');
    if (method === 'GET') {
      const { slice, headers } = paginate(ctx, issue.comments);
      return sendJson(ctx, 200, slice.map((comment) => commentJson(forge, repo, issue, comment)), headers);
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
      const text = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      const comment = forge.addComment(issue, text);
      return sendJson(ctx, 201, commentJson(forge, repo, issue, comment));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  return sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// pull requests

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

async function pullRoutes(ctx: Ctx, repo: Repo, rest: string[]): Promise<void> {
  const { forge, method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const { slice, headers } = paginate(ctx, pulls);
      return sendJson(ctx, 200, slice.map((pull) => pullJson(forge, repo, pull)), headers);
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
      const body = parsed.value;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? stripOwnerPrefix(body.head) : '';
      const base = typeof body.base === 'string' ? stripOwnerPrefix(body.base) : '';
      if (!title || !head || !base) return sendError(ctx, 422, 'Validation failed: title, head and base are required');
      if (!forge.resolveRef(repo, head) || !forge.resolveRef(repo, base)) {
        return sendError(ctx, 422, 'Validation failed: head or base ref does not exist');
      }
      const pull = forge.createPull(repo, head, base, title, typeof body.body === 'string' ? body.body : '');
      return sendJson(ctx, 201, pullJson(forge, repo, pull));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(ctx, 404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (!pull) return sendError(ctx, 404, 'Not Found');
    if (method === 'GET') return sendJson(ctx, 200, pullJson(forge, repo, pull));
    if (method === 'PATCH') {
      const parsed = await readJsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) return sendError(ctx, 400, 'Problems parsing JSON');
      const body = parsed.value;
      if (typeof body.title === 'string') (pull as { title: string }).title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        pull.state = body.state;
        pull.closedAt = body.state === 'closed' ? forge.now() : null;
      }
      pull.updatedAt = forge.now();
      return sendJson(ctx, 200, pullJson(forge, repo, pull));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (!pull) return sendError(ctx, 404, 'Not Found');
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = forge.pullChanges(repo, pull).map((change) => {
      const counts = forge.changeCounts(change);
      return {
        filename: change.path,
        status: change.status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        sha: change.newOid ?? change.oldOid ?? '',
      };
    });
    return sendJson(ctx, 200, files);
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const parsed = await readJsonBody(ctx);
    if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON');
    if (pull.merged) return sendError(ctx, 405, 'Pull Request is not mergeable: already merged');
    if (pull.state !== 'open') return sendError(ctx, 405, 'Pull Request is not mergeable: closed');
    const outcome = forge.squashMerge(repo, pull);
    if (!outcome.ok || !outcome.sha) {
      return sendError(ctx, 405, 'Pull Request is not mergeable: merge conflict');
    }
    return sendJson(ctx, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return sendError(ctx, 404, 'Not Found');
}
