import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { KINDS, type DebridKind, type DebridProvider } from './torbox.ts';

const FILE_ROUTE = /^\/api\/debrid\/file\/([a-z]+)\/(\d{1,12})\/(\d{1,12})$/;
// Headers copied from the upstream response so <audio> seeking works.
const PASS_THROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** `provider` is null when no API key is configured. */
export function createHandler(provider: DebridProvider | null, fetchFn: typeof fetch = fetch) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // DNS-rebinding guard: only answer requests addressed to localhost (port ignored).
      const host = new URL(`http://${req.headers.host ?? ''}`).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') return json(res, 403, { error: 'forbidden_host' });
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

      if (path === '/api/debrid/status') return json(res, 200, { configured: provider !== null });

      const isFile = FILE_ROUTE.exec(path);
      if (path === '/api/debrid/items' || path.startsWith('/api/debrid/file/')) {
        if (!provider) return json(res, 503, { error: 'not_configured' });
        if (path === '/api/debrid/items') return json(res, 200, await provider.listFiles());
        if (!isFile || !KINDS.includes(isFile[1] as DebridKind)) return json(res, 400, { error: 'bad_params' });

        const link = await provider.resolveLink(isFile[1] as DebridKind, Number(isFile[2]), Number(isFile[3]));
        // The link came from TorBox, never from the client. No Authorization header is sent to the CDN.
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        const range = req.headers.range;
        const up = await fetchFn(link, { headers: range ? { range } : {}, signal: abort.signal });
        const headers: Record<string, string> = {};
        for (const h of PASS_THROUGH) {
          const v = up.headers.get(h);
          if (v) headers[h] = v;
        }
        res.writeHead(up.status, headers);
        if (!up.body) return void res.end();
        Readable.fromWeb(up.body as never).on('error', () => res.destroy()).pipe(res);
        return;
      }
      json(res, 404, { error: 'not_found' });
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      // Error messages come from our own code and never contain the API key.
      json(res, 502, { error: e instanceof Error ? e.message : 'upstream_error' });
    }
  };
}
