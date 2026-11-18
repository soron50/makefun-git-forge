// mcp.ts — the Model Context Protocol endpoint at /mcp: Streamable HTTP JSON-RPC 2.0 with
// the modern server/discover handshake (and the legacy initialize fallback), exposing the
// forge's repository, issue and pull-request tools over the same store as REST and GraphQL.

import { VIEWER, type Forge } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { isRecord, readBody, sendJson, type Ctx } from './web.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const prop = (type: string, description: string): { type: string; description: string } => ({ type, description });

// Built once: tools/list must be byte-identical across calls.
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('string', 'The repository name.'),
        description: prop('string', 'A short description of the repository.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The issue title.'),
        body: prop('string', 'The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        state: prop('string', 'Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request proposing changes from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The pull request title.'),
        head: prop('string', 'The head branch to merge from.'),
        base: prop('string', 'The base branch to merge into.'),
        body: prop('string', 'The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        pull_number: prop('number', 'The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function toolResult(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };
  if (isRecord(value)) result.structuredContent = value;
  return result;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function callTool(forge: Forge, name: string, rawArgs: unknown): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new RpcError(-32602, `unknown tool: ${name}`);
  const args = isRecord(rawArgs) ? rawArgs : {};
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name')!;
      if (forge.repo(VIEWER.login, repoName)) return toolError(`repository ${repoName} already exists`);
      const repo = forge.createRepo(
        VIEWER.login,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : null,
      );
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = forge.repo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      if (!repo) return toolError('repository not found');
      return toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = forge.repo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      if (!repo) return toolError('repository not found');
      const created = forge.createIssue(repo, stringArg(args, 'title')!, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolError('unknown label');
      return toolResult(issueJson(forge, repo, created));
    }
    case 'list_issues': {
      const repo = forge.repo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJson(forge, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = forge.repo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      if (!repo) return toolError('repository not found');
      const head = stringArg(args, 'head')!;
      const base = stringArg(args, 'base')!;
      if (!forge.resolveRef(repo, head) || !forge.resolveRef(repo, base)) {
        return toolError('head or base ref does not exist');
      }
      const pull = forge.createPull(repo, head, base, stringArg(args, 'title')!, typeof args.body === 'string' ? args.body : '');
      return toolResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.repo(stringArg(args, 'owner')!, stringArg(args, 'repo')!);
      if (!repo) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return toolError('pull request not found');
      if (pull.merged) return toolError('pull request already merged');
      const outcome = forge.squashMerge(repo, pull);
      if (!outcome.ok) return toolError('pull request is not mergeable: merge conflict');
      return toolResult(pullJson(forge, repo, pull));
    }
    default:
      throw new RpcError(-32602, `unknown tool: ${name}`);
  }
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: PROTOCOL_VERSIONS,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function handleRpc(forge: Forge, message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) throw new RpcError(-32600, 'invalid request');
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const isNotification = id === undefined || id === null;
  try {
    let result: unknown;
    switch (method) {
      case 'server/discover':
        result = discoverResult();
        break;
      case 'initialize': {
        const params = isRecord(message.params) ? message.params : {};
        result = {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const params = isRecord(message.params) ? message.params : {};
        const toolName = typeof params.name === 'string' ? params.name : '';
        result = callTool(forge, toolName, params.arguments);
        break;
      }
      case 'resources/list':
        result = { resources: [] };
        break;
      case 'prompts/list':
        result = { prompts: [] };
        break;
      default:
        if (isNotification) return null;
        throw new RpcError(-32601, `method not found: ${method}`);
    }
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (isNotification) return null;
    if (error instanceof RpcError) {
      return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : 'internal error' } };
  }
}

export async function handleMcp(ctx: Ctx): Promise<void> {
  const raw = await readBody(ctx);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(payload)) {
    const responses: Record<string, unknown>[] = [];
    for (const entry of payload) {
      try {
        const response = handleRpc(ctx.forge, entry);
        if (response) responses.push(response);
      } catch (error) {
        if (error instanceof RpcError) {
          responses.push({ jsonrpc: '2.0', id: null, error: { code: error.code, message: error.message } });
        }
      }
    }
    if (responses.length === 0) {
      ctx.res.writeHead(202, { 'X-GitHub-Request-Id': ctx.requestId });
      return ctx.res.end();
    }
    return sendJson(ctx, 200, responses);
  }
  try {
    const response = handleRpc(ctx.forge, payload);
    if (!response) {
      ctx.res.writeHead(202, { 'X-GitHub-Request-Id': ctx.requestId });
      return ctx.res.end();
    }
    return sendJson(ctx, 200, response);
  } catch (error) {
    if (error instanceof RpcError) {
      return sendJson(ctx, 200, { jsonrpc: '2.0', id: null, error: { code: error.code, message: error.message } });
    }
    throw error;
  }
}
