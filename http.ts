// http.ts — small shared HTTP helpers for the forge's handlers (used by app.ts, git.ts,
// graphql.ts and mcp.ts so no handler imports another handler's module).

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}-${Date.now().toString(36)}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; null when empty; throws a 400 marker on bad JSON. */
export function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString('utf8').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('MALFORMED_JSON');
  }
}

export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

export function authed(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const header = req.headers.authorization ?? '';
  if (expected === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${expected}`;
}
