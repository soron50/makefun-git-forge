// graphql.ts — a small but real GraphQL implementation for /api/graphql: a tokenizer and
// parser for the query language (operations, variables, aliases, fragments, inline
// fragments, arguments with lists and input objects), an executor over the forge's store,
// the GitHub-shaped schema the suite introspects, and the mutations that must round-trip
// with the REST surface (createIssue, closeIssue, createPullRequest, mergePullRequest,
// addComment).

import { VIEWER, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { isRecord, readBody, sendJson, type Ctx } from './web.ts';

// ---------------------------------------------------------------------------------------------
// global ids: opaque, stable, and never the plain database id

export function encodeId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const segments = text.split(':');
    if (segments.length < 2) return null;
    return { kind: segments[0]!, parts: segments.slice(1) };
  } catch {
    return null;
  }
}

export const repoGlobalId = (repo: Repo): string => encodeId('repo', repo.id);
export const issueGlobalId = (repo: Repo, issue: Issue): string => encodeId('issue', repo.id, issue.number);
export const pullGlobalId = (repo: Repo, pull: Pull): string => encodeId('pr', repo.id, pull.number);
export const commentGlobalId = (commentId: number): string => encodeId('comment', commentId);

// ---------------------------------------------------------------------------------------------
// tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if ('{}()[]:@=$!'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '.') {
      if (source.startsWith('...', index)) {
        tokens.push({ kind: 'punct', value: '...' });
        index += 3;
        continue;
      }
      throw new Error(`unexpected '.' at ${index}`);
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let cursor = index + 1;
      let value = '';
      while (cursor < source.length && source[cursor] !== '"') {
        const current = source[cursor]!;
        if (current === '\\') {
          const escaped = source[cursor + 1];
          if (escaped === 'u') {
            value += String.fromCharCode(parseInt(source.slice(cursor + 2, cursor + 6), 16));
            cursor += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
            value += map[escaped ?? ''] ?? escaped ?? '';
            cursor += 2;
          }
        } else {
          value += current;
          cursor += 1;
        }
      }
      if (cursor >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      index = cursor + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let cursor = index;
      while (cursor < source.length && isNameChar(source[cursor]!)) cursor += 1;
      tokens.push({ kind: 'name', value: source.slice(index, cursor) });
      index = cursor;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
      if (!match) throw new Error(`invalid number at ${index}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text)
        ? { kind: 'float', value: Number(text) }
        : { kind: 'int', value: Number(text) });
      index += text.length;
      continue;
    }
    throw new Error(`unexpected character '${ch}' at ${index}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Map<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private next(): Token {
    return this.tokens[this.position++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().kind === 'punct') this.skipParens();
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error("expected 'on' in fragment");
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition '${token.value}'`);
    }
    return { operations, fragments };
  }

  /** Skip a balanced (...) group (variable definitions). */
  private skipParens(): void {
    if (!this.skipPunct('(')) return;
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated parentheses');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipParens();
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------------------------------------
// schema description for introspection

const TYPE_FIELDS: Readonly<Record<string, string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  RepositoryOwner: ['login', 'id', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt',
    'mergedAt', 'mergeCommit', 'repository',
  ],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  Commit: ['oid', 'message', 'committedDate'],
};

const ENUM_VALUES: Readonly<Record<string, string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------------------------------------
// execution

interface GqlError {
  message: string;
}

type Source =
  | { __type: 'Query' | 'Mutation' }
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Ref'; name: string }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Comment'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: number } }
  | { __type: 'Label'; label: { name: string; color: string } }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'IssueConnection'; repo: Repo; items: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; repo: Repo; items: Pull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestChangedFileConnection'; files: { path: string; additions: number; deletions: number; changeType: string }[] }
  | { __type: 'ChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'CommentEdge'; node: Source }
  | { __type: 'IssueEdge'; repo: Repo; issue: Issue }
  | { __type: 'PullRequestEdge'; repo: Repo; pull: Pull }
  | { __type: 'CreateIssuePayload' | 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload' | 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; edge: Source }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: '__Schema' };

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: GqlError[];
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = evalValue(value, ctx.variables);
  return out;
}

const issueCursor = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function collectFields(
  ctx: ExecCtx,
  typeName: string,
  selections: SelectionNode[],
  out: Map<string, FieldNode[]>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      const existing = out.get(key);
      if (existing) existing.push(selection);
      else out.set(key, [selection]);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        collectFields(ctx, typeName, selection.selectionSet, out);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        collectFields(ctx, typeName, fragment.selectionSet, out);
      }
    }
  }
}

function executeSelectionSet(ctx: ExecCtx, typeName: string, source: Source, selections: SelectionNode[]): Record<string, unknown> {
  const grouped = new Map<string, FieldNode[]>();
  collectFields(ctx, typeName, selections, grouped);
  const out: Record<string, unknown> = {};
  for (const [key, fields] of grouped) {
    const field = fields[0]!;
    const mergedSelections = fields.flatMap((entry) => entry.selectionSet ?? []);
    out[key] = executeField(ctx, typeName, source, field, mergedSelections);
  }
  return out;
}

function complete(ctx: ExecCtx, value: unknown, selections: SelectionNode[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => complete(ctx, entry, selections));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const source = value as Source;
    return executeSelectionSet(ctx, source.__type, source, selections);
  }
  return value;
}

function executeField(ctx: ExecCtx, typeName: string, source: Source, field: FieldNode, selections: SelectionNode[]): unknown {
  const name = field.name;
  if (name === '__typename') return typeName;
  if (name === '__type' && typeName === 'Query') {
    const args = argsOf(field, ctx);
    const typeNameArg = typeof args.name === 'string' ? args.name : '';
    const known = TYPE_FIELDS[typeNameArg] !== undefined || ENUM_VALUES[typeNameArg] !== undefined;
    const typeSource: Source = { __type: '__Type', name: typeNameArg };
    return known ? complete(ctx, typeSource, selections) : null;
  }
  if (name === '__schema' && typeName === 'Query') {
    return complete(ctx, { __type: '__Schema' } as Source, selections);
  }
  const knownFields = TYPE_FIELDS[typeName];
  if (knownFields && !knownFields.includes(name)) {
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  const value = resolveField(ctx, typeName, source, field);
  return complete(ctx, value, selections);
}

function resolveField(ctx: ExecCtx, typeName: string, source: Source, field: FieldNode): unknown {
  const { forge } = ctx;
  const args = argsOf(field, ctx);
  const name = field.name;
  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return { __type: 'User', login: VIEWER.login } as Source;
      if (name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repoName = typeof args.name === 'string' ? args.name : '';
        const repo = forge.repo(owner, repoName);
        return repo ? ({ __type: 'Repository', repo } as Source) : null;
      }
      if (name === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        return nodeById(ctx, id);
      }
      return null;
    }
    case 'Mutation': return resolveMutation(ctx, field);
    case 'User': {
      const user = source as Extract<Source, { __type: 'User' }>;
      if (name === 'login') return user.login;
      if (name === 'id') return encodeId('user', user.login);
      if (name === 'name') return user.login === VIEWER.login ? VIEWER.name : user.login;
      if (name === 'email') return user.login === VIEWER.login ? VIEWER.email : null;
      if (name === 'url') return `https://github.example/${user.login}`;
      return null;
    }
    case 'Repository': {
      const { repo } = source as Extract<Source, { __type: 'Repository' }>;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', login: repo.owner } as Source;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'url': return `https://github.example/${repo.owner}/${repo.name}`;
        case 'defaultBranchRef': {
          const tip = forge.defaultTip(repo);
          return tip ? ({ __type: 'Ref', name: repo.defaultBranch } as Source) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': case 'updatedAt': return forge.iso(repo.createdAt);
        case 'issue': {
          const number = Number(args.number);
          const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
          return issue ? ({ __type: 'Issue', repo, issue } as Source) : null;
        }
        case 'issues': return issuesConnection(ctx, repo, args);
        case 'pullRequest': {
          const number = Number(args.number);
          const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
          return pull ? ({ __type: 'PullRequest', repo, pull } as Source) : null;
        }
        case 'pullRequests': return pullsConnection(ctx, repo, args);
        default: return null;
      }
    }
    case 'Ref': {
      const ref = source as Extract<Source, { __type: 'Ref' }>;
      if (name === 'name') return ref.name;
      if (name === 'prefix') return 'refs/heads/';
      return null;
    }
    case 'Issue': {
      const { repo, issue } = source as Extract<Source, { __type: 'Issue' }>;
      switch (name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'author': return { __type: 'User', login: repo.owner } as Source;
        case 'repository': return { __type: 'Repository', repo } as Source;
        case 'labels': return issue.labels.map((label) => ({ __type: 'Label', label }) as Source);
        case 'comments': return issue.comments.map((comment) => ({ __type: 'Comment', repo, issue, comment }) as Source);
        case 'createdAt': return forge.iso(issue.createdAt);
        case 'updatedAt': return forge.iso(issue.updatedAt);
        case 'closedAt': return issue.closedAt === null ? null : forge.iso(issue.closedAt);
        case 'url': return `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source as Extract<Source, { __type: 'PullRequest' }>;
      switch (name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pull.state === 'open' ? forge.pullMergeable(repo, pull) : pull.merged ? 'MERGEABLE' : 'UNKNOWN';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return forge.refTip(repo, pull.headRef) || forge.refTip(repo, `refs/heads/${pull.headRef}`)
          ? ({ __type: 'Ref', name: pull.headRef } as Source) : null;
        case 'baseRef': return forge.refTip(repo, pull.baseRef) || forge.refTip(repo, `refs/heads/${pull.baseRef}`)
          ? ({ __type: 'Ref', name: pull.baseRef } as Source) : null;
        case 'files': return pullFilesConnection(ctx, repo, pull, args);
        case 'author': return { __type: 'User', login: repo.owner } as Source;
        case 'repository': return { __type: 'Repository', repo } as Source;
        case 'createdAt': return forge.iso(pull.createdAt);
        case 'updatedAt': return forge.iso(pull.updatedAt);
        case 'mergedAt': return pull.mergedAt === null ? null : forge.iso(pull.mergedAt);
        case 'mergeCommit': return pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null;
        default: return null;
      }
    }
    case 'Comment': {
      const { comment } = source as Extract<Source, { __type: 'Comment' }>;
      if (name === 'id') return commentGlobalId(comment.id);
      if (name === 'body') return comment.body;
      if (name === 'author') return { __type: 'User', login: VIEWER.login } as Source;
      if (name === 'createdAt' || name === 'updatedAt') return forge.iso(comment.createdAt);
      return null;
    }
    case 'Label': {
      const { label } = source as Extract<Source, { __type: 'Label' }>;
      if (name === 'id') return encodeId('label', label.name);
      if (name === 'name') return label.name;
      if (name === 'color') return label.color;
      return null;
    }
    case 'PageInfo': {
      const info = source as Extract<Source, { __type: 'PageInfo' }>;
      if (name === 'hasNextPage') return info.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return info.endCursor;
      if (name === 'startCursor') return info.endCursor;
      return null;
    }
    case 'IssueConnection': {
      const connection = source as Extract<Source, { __type: 'IssueConnection' }>;
      if (name === 'nodes') return connection.items.map((issue) => ({ __type: 'Issue', repo: connection.repo, issue }) as Source);
      if (name === 'edges') return connection.items.map((issue) => ({ __type: 'IssueEdge', repo: connection.repo, issue }) as Source);
      if (name === 'pageInfo') return { __type: 'PageInfo', ...connection.pageInfo } as Source;
      if (name === 'totalCount') return connection.items.length;
      return null;
    }
    case 'IssueEdge': {
      const edge = source as Extract<Source, { __type: 'IssueEdge' }>;
      if (name === 'node') return { __type: 'Issue', repo: edge.repo, issue: edge.issue } as Source;
      if (name === 'cursor') return issueCursor(edge.issue.number);
      return null;
    }
    case 'PullRequestConnection': {
      const connection = source as Extract<Source, { __type: 'PullRequestConnection' }>;
      if (name === 'nodes') return connection.items.map((pull) => ({ __type: 'PullRequest', repo: connection.repo, pull }) as Source);
      if (name === 'edges') return connection.items.map((pull) => ({ __type: 'PullRequestEdge', repo: connection.repo, pull }) as Source);
      if (name === 'pageInfo') return { __type: 'PageInfo', ...connection.pageInfo } as Source;
      if (name === 'totalCount') return connection.items.length;
      return null;
    }
    case 'PullRequestEdge': {
      const edge = source as Extract<Source, { __type: 'PullRequestEdge' }>;
      if (name === 'node') return { __type: 'PullRequest', repo: edge.repo, pull: edge.pull } as Source;
      if (name === 'cursor') return issueCursor(edge.pull.number);
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const connection = source as Extract<Source, { __type: 'PullRequestChangedFileConnection' }>;
      if (name === 'nodes') return connection.files.map((file) => ({ __type: 'ChangedFile', ...file }) as Source);
      if (name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as Source;
      if (name === 'totalCount') return connection.files.length;
      return null;
    }
    case 'ChangedFile': {
      const file = source as Extract<Source, { __type: 'ChangedFile' }>;
      if (name === 'path') return file.path;
      if (name === 'additions') return file.additions;
      if (name === 'deletions') return file.deletions;
      if (name === 'changeType') return file.changeType;
      return null;
    }
    case 'CommentEdge': {
      const edge = source as Extract<Source, { __type: 'CommentEdge' }>;
      if (name === 'node') return edge.node;
      if (name === 'cursor') return 'cursor:comment';
      return null;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      const payload = source as Extract<Source, { __type: 'CreateIssuePayload' }>;
      if (name === 'issue') return { __type: 'Issue', repo: payload.repo, issue: payload.issue } as Source;
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      const payload = source as Extract<Source, { __type: 'CreatePullRequestPayload' }>;
      if (name === 'pullRequest') return { __type: 'PullRequest', repo: payload.repo, pull: payload.pull } as Source;
      if (name === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      const payload = source as Extract<Source, { __type: 'AddCommentPayload' }>;
      if (name === 'commentEdge') return payload.edge;
      if (name === 'clientMutationId') return null;
      if (name === 'subject') return null;
      return null;
    }
    case '__Type': {
      const type = source as Extract<Source, { __type: '__Type' }>;
      if (name === 'name') return type.name;
      if (name === 'kind') return ENUM_VALUES[type.name] ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        return (TYPE_FIELDS[type.name] ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName }) as Source);
      }
      if (name === 'enumValues') {
        return (ENUM_VALUES[type.name] ?? []).map((value) => ({ __type: '__EnumValue', name: value }) as Source);
      }
      return null;
    }
    case '__Field': {
      const typeField = source as Extract<Source, { __type: '__Field' }>;
      if (name === 'name') return typeField.name;
      return null;
    }
    case '__EnumValue': {
      const value = source as Extract<Source, { __type: '__EnumValue' }>;
      if (name === 'name') return value.name;
      return null;
    }
    case '__Schema': {
      if (name === 'queryType') return { __type: '__Type', name: 'Query' } as Source;
      if (name === 'mutationType') return { __type: '__Type', name: 'Mutation' } as Source;
      if (name === 'types') {
        return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((typeName) => ({ __type: '__Type', name: typeName }) as Source);
      }
      return null;
    }
    default:
      return null;
  }
}

function nodeById(ctx: ExecCtx, id: string): Source | null {
  const decoded = decodeId(id);
  if (!decoded) return null;
  if (decoded.kind === 'repo') {
    const repo = ctx.forge.repoById(Number(decoded.parts[0]));
    return repo ? ({ __type: 'Repository', repo } as Source) : null;
  }
  if (decoded.kind === 'issue' || decoded.kind === 'pr') {
    const repo = ctx.forge.repoById(Number(decoded.parts[0]));
    if (!repo) return null;
    const number = Number(decoded.parts[1]);
    if (decoded.kind === 'issue') {
      const issue = repo.issues.get(number);
      return issue ? ({ __type: 'Issue', repo, issue } as Source) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? ({ __type: 'PullRequest', repo, pull } as Source) : null;
  }
  return null;
}

function issuesConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): Source {
  let items = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states.map(String) : null;
  if (states) items = items.filter((issue) => states.includes(issue.state.toUpperCase()));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const field = orderBy && typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  items.sort((a, b) => {
    const primary = field === 'CREATED_AT' || field === 'UPDATED_AT'
      ? (a.createdAt - b.createdAt) || (a.number - b.number)
      : a.number - b.number;
    return direction === 'ASC' ? primary : -primary;
  });
  let startIndex = 0;
  if (typeof args.after === 'string') {
    const afterNumber = decodeCursor(args.after);
    if (afterNumber !== null) {
      const found = items.findIndex((issue) => issue.number === afterNumber);
      if (found >= 0) startIndex = found + 1;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  const page = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < items.length;
  const endCursor = page.length ? issueCursor(page[page.length - 1]!.number) : null;
  return { __type: 'IssueConnection', repo, items: page, pageInfo: { hasNextPage, endCursor } } as Source;
}

function pullsConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): Source {
  let items = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? args.states.map(String) : ['OPEN'];
  items = items.filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
    return states.includes(state);
  });
  items.sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  const page = items.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    repo,
    items: page,
    pageInfo: { hasNextPage: page.length < items.length, endCursor: page.length ? issueCursor(page[page.length - 1]!.number) : null },
  } as Source;
}

function pullFilesConnection(ctx: ExecCtx, repo: Repo, pull: Pull, args: Record<string, unknown>): Source {
  const changes = ctx.forge.pullChanges(repo, pull);
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : changes.length;
  const files = changes.slice(0, first).map((change) => {
    const counts = ctx.forge.changeCounts(change);
    return {
      path: change.path,
      additions: counts.additions,
      deletions: counts.deletions,
      changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
    };
  });
  return { __type: 'PullRequestChangedFileConnection', files } as Source;
}

function resolveMutation(ctx: ExecCtx, field: FieldNode): unknown {
  const { forge } = ctx;
  const args = argsOf(field, ctx);
  const input = isRecord(args.input) ? args.input : args;
  const name = field.name;
  if (name === 'createIssue') {
    const repoId = decodeId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
    const repo = repoId?.kind === 'repo' ? forge.repoById(Number(repoId.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const created = forge.createIssue(
      repo,
      typeof input.title === 'string' ? input.title : '',
      typeof input.body === 'string' ? input.body : '',
      [],
    );
    if ('error' in created) {
      ctx.errors.push({ message: 'createIssue: unknown label' });
      return null;
    }
    return { __type: 'CreateIssuePayload', repo, issue: created } as Source;
  }
  if (name === 'closeIssue') {
    const decoded = decodeId(typeof input.issueId === 'string' ? input.issueId : '');
    const repo = decoded?.kind === 'issue' ? forge.repoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    issue.state = 'closed';
    issue.closedAt = forge.now();
    issue.updatedAt = forge.now();
    return { __type: 'CloseIssuePayload', repo, issue } as Source;
  }
  if (name === 'createPullRequest') {
    const repoId = decodeId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
    const repo = repoId?.kind === 'repo' ? forge.repoById(Number(repoId.parts[0])) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const pull = forge.createPull(
      repo,
      typeof input.headRefName === 'string' ? input.headRefName : '',
      typeof input.baseRefName === 'string' ? input.baseRefName : '',
      typeof input.title === 'string' ? input.title : '',
      typeof input.body === 'string' ? input.body : '',
    );
    return { __type: 'CreatePullRequestPayload', repo, pull } as Source;
  }
  if (name === 'mergePullRequest') {
    const decoded = decodeId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
    const repo = decoded?.kind === 'pr' ? forge.repoById(Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.get(Number(decoded?.parts[1]));
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    if (!pull.merged) {
      const outcome = forge.squashMerge(repo, pull);
      if (!outcome.ok) {
        ctx.errors.push({ message: 'mergePullRequest: pull request is not mergeable' });
        return null;
      }
    }
    return { __type: 'MergePullRequestPayload', repo, pull } as Source;
  }
  if (name === 'addComment') {
    const decoded = decodeId(typeof input.subjectId === 'string' ? input.subjectId : '');
    const repo = decoded?.kind === 'issue' ? forge.repoById(Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const comment = forge.addComment(issue, typeof input.body === 'string' ? input.body : '');
    const node: Source = { __type: 'Comment', repo, issue, comment };
    const edge: Source = { __type: 'CommentEdge', node };
    return { __type: 'AddCommentPayload', edge } as Source;
  }
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP entry

export function executeGraphql(forge: Forge, payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.query !== 'string') {
    return { data: null, errors: [{ message: 'a GraphQL query string is required' }] };
  }
  const variables = isRecord(payload.variables) ? payload.variables : {};
  let document: DocumentNode;
  try {
    document = new Parser(payload.query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : null;
  const operation = document.operations.find((candidate) => operationName === null || candidate.name === operationName)
    ?? document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, { __type: rootType } as Source, operation.selectionSet);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

export async function handleGraphql(ctx: Ctx): Promise<void> {
  const raw = await readBody(ctx);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  if (Array.isArray(payload)) {
    return sendJson(ctx, 200, payload.map((entry) => executeGraphql(ctx.forge, entry)));
  }
  return sendJson(ctx, 200, executeGraphql(ctx.forge, payload));
}
