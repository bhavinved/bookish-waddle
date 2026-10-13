import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAddonHandler } from './addons.ts';
import { json, pipeResponse } from './http.ts';
import { KINDS, type DebridKind, type DebridProvider } from './torbox.ts';

const FILE_ROUTE = /^\/api\/debrid\/file\/([a-z]+)\/(\d{1,12})\/(\d{1,12})$/;
// Headers copied from the upstream response so <audio> seeking works.
const PASS_THROUGH = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

const INFO_HASH = /^[a-fA-F0-9]{40}$/;

/** POST /api/debrid/resolve { infoHash, fileIdx?, send? }. JSON-only: a cross-origin page cannot send this without a CORS preflight, which we never answer. */
async function resolveRoute(req: IncomingMessage, res: ServerResponse, provider: DebridProvider | null) {
  if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'json_required' });
  if (!provider) return json(res, 503, { error: 'not_configured' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2048) return json(res, 413, { error: 'too_large' });
  }
  let body: { infoHash?: unknown; fileIdx?: unknown; send?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: 'bad_json' });
  }
  const { infoHash, fileIdx, send } = body ?? {};
  if (typeof infoHash !== 'string' || !INFO_HASH.test(infoHash)) return json(res, 400, { error: 'bad_params' });
  if (fileIdx !== undefined && !(Number.isInteger(fileIdx) && (fileIdx as number) >= 0 && (fileIdx as number) < 100000)) {
    return json(res, 400, { error: 'bad_params' });
  }
  if (send !== undefined && typeof send !== 'boolean') return json(res, 400, { error: 'bad_params' });
  json(res, 200, await provider.resolveInfoHash(infoHash, fileIdx as number | undefined, send as boolean | undefined));
}

/** `provider` is null when no API key is configured. */
export function createHandler(provider: DebridProvider | null, fetchFn: typeof fetch = fetch) {
  const addons = createAddonHandler(fetchFn);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // DNS-rebinding guard: only answer requests addressed to localhost (port ignored).
      const host = new URL(`http://${req.headers.host ?? ''}`).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') return json(res, 403, { error: 'forbidden_host' });
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'POST' && path === '/api/debrid/resolve') return await resolveRoute(req, res, provider);
      if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

      if (await addons(req, res, new URL(req.url ?? '/', 'http://localhost'))) return;

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
        return pipeResponse(up, res, PASS_THROUGH);
      }
      json(res, 404, { error: 'not_found' });
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      // Error messages come from our own code and never contain the API key.
      json(res, 502, { error: e instanceof Error ? e.message : 'upstream_error' });
    }
  };
}
