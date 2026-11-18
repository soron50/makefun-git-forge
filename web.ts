// web.ts — tiny HTTP plumbing shared by the REST, GraphQL, MCP and git transports:
// request context, body reading, JSON responses with the GitHub request-id header.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly forge: import('./forge.ts').Forge;
  readonly token: string;
  readonly requestId: string;
  bodyPromise: Promise<Buffer> | null;
}

export function readBody(ctx: Ctx): Promise<Buffer> {
  if (!ctx.bodyPromise) {
    ctx.bodyPromise = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of ctx.req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    })();
  }
  return ctx.bodyPromise;
}

export async function readJsonBody(ctx: Ctx): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readBody(ctx);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sendJson(ctx: Ctx, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'X-GitHub-Request-Id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(payload);
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': 0,
    'X-GitHub-Request-Id': ctx.requestId,
  });
  ctx.res.end();
}

/** The origin this server is reachable on, taken from the request (the Link-header base). */
export function originOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? 'localhost';
  return `http://${host}`;
}

/** GitHub-style pagination: a Link header with rel="next" while more pages remain. */
export function pageParams(ctx: Ctx): { page: number; perPage: number } {
  const pageRaw = Number(ctx.url.searchParams.get('page') ?? '1');
  const perRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const perPage = Number.isFinite(perRaw) && perRaw >= 1 ? Math.min(Math.floor(perRaw), 100) : 30;
  return { page, perPage };
}

export function paginate<T>(ctx: Ctx, items: readonly T[]): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(ctx.url);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers['Link'] = `<${originOf(ctx)}${next.pathname}${next.search}>; rel="next"`;
  }
  return { slice, headers };
}
