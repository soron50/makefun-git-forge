// app.ts — the forge's HTTP server: one process serving the git smart HTTP transport,
// the REST v3 API, GraphQL and MCP, all behind the trial's bearer-token auth. The entry
// point (main.ts) owns the register/done lifecycle; this module owns the wire.

import { createServer, type Server } from 'node:http';
import { Forge } from './forge.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { sendError, type Ctx } from './web.ts';

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((req, res) => {
    requestCounter += 1;
    const ctx: Ctx = {
      req,
      res,
      method: (req.method ?? 'GET').toUpperCase(),
      url: new URL(req.url ?? '/', 'http://localhost'),
      forge,
      token,
      requestId: `req-${requestCounter.toString(16).padStart(8, '0')}`,
      bodyPromise: null,
    };
    route(ctx).catch(() => {
      // A malformed request must never take the server down: answer 500 and keep serving.
      if (!res.headersSent) {
        try {
          sendError(ctx, 500, 'Internal Server Error');
        } catch {
          /* socket already gone */
        }
      } else {
        try {
          res.end();
        } catch {
          /* socket already gone */
        }
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

function authorized(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (ctx.token) return presented === ctx.token;
  return presented.length > 0;
}

async function route(ctx: Ctx): Promise<void> {
  const { pathname } = ctx.url;

  // The env's boot check calls this twice and expects 200 {"ok":true}; it takes no auth.
  if (ctx.method === 'GET' && pathname === '/healthz') {
    const payload = Buffer.from('{"ok":true}', 'utf8');
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'X-GitHub-Request-Id': ctx.requestId,
    });
    ctx.res.end(payload);
    return;
  }

  if (!authorized(ctx)) {
    return sendError(ctx, 401, 'Bad credentials');
  }

  const segments = pathname.split('/').filter((segment) => segment.length > 0);

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const owner = decodeURIComponent(segments[0]!);
    const name = decodeURIComponent(segments[1]!.slice(0, -'.git'.length));
    const repo = ctx.forge.repo(owner, name);
    const tail = segments.slice(2).join('/');
    if (!repo) return sendError(ctx, 404, 'Not Found');
    if (tail === 'info/refs' && ctx.method === 'GET') {
      return handleInfoRefs(ctx, repo, ctx.url.searchParams.get('service'));
    }
    if (tail === 'git-upload-pack' && ctx.method === 'POST') return handleUploadPack(ctx, repo);
    if (tail === 'git-receive-pack' && ctx.method === 'POST') return handleReceivePack(ctx, repo);
    return sendError(ctx, 404, 'Not Found');
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    return handleRest(ctx, segments.slice(2));
  }
  if (pathname === '/api/graphql') {
    if (ctx.method !== 'POST') return sendError(ctx, 404, 'Not Found');
    return handleGraphql(ctx);
  }
  if (pathname === '/mcp' || pathname === '/mcp/') {
    if (ctx.method !== 'POST') return sendError(ctx, 405, 'Method Not Allowed');
    return handleMcp(ctx);
  }
  return sendError(ctx, 404, 'Not Found');
}
