import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Copies the listed headers from an upstream fetch Response, then streams its body to the client. */
export function pipeResponse(up: Response, res: ServerResponse, passHeaders: string[]) {
  const headers: Record<string, string> = {};
  for (const h of passHeaders) {
    const v = up.headers.get(h);
    if (v) headers[h] = v;
  }
  res.writeHead(up.status, headers);
  if (!up.body) return void res.end();
  Readable.fromWeb(up.body as never)
    .on('error', () => res.destroy())
    .pipe(res);
}
