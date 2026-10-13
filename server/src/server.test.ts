import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from './app.ts';
import { createTorBox, mapItems, type DebridProvider } from './torbox.ts';

// Shape follows the official TorBox client (torbox-app/torbox-media-center): { data: [{ id, cached, files: [...] }] }
const MYLIST = {
  success: true,
  data: [
    {
      id: 11,
      cached: true,
      files: [
        { id: 0, name: 'Book/Dune.epub', short_name: 'Dune.epub', size: 100, mimetype: 'application/epub+zip' },
        { id: 1, name: 'Book/cover.jpg', short_name: 'cover.jpg', size: 5, mimetype: 'image/jpeg' },
        { id: 2, name: 'Book/ch1.MP3', short_name: 'ch1.MP3', size: 900, mimetype: 'audio/mpeg' },
      ],
    },
    { id: 12, cached: false, download_finished: false, files: [{ id: 0, short_name: 'x.pdf', size: 1 }] },
  ],
};

describe('mapItems', () => {
  it('keeps supported files of ready items only', () => {
    expect(mapItems('torrent', MYLIST.data)).toEqual([
      { kind: 'torrent', itemId: 11, fileId: 0, name: 'Dune.epub', size: 100, format: 'epub' },
      { kind: 'torrent', itemId: 11, fileId: 2, name: 'ch1.MP3', size: 900, format: 'audio' },
    ]);
  });
});

describe('createTorBox', () => {
  it('lists all three kinds with Bearer auth', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(MYLIST)));
    const files = await createTorBox('KEY', f as unknown as typeof fetch).listFiles();
    expect(files.map((x) => x.kind)).toEqual(['torrent', 'torrent', 'webdl', 'webdl', 'usenet', 'usenet']);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((c) => c[0])).toEqual([
      expect.stringContaining('/torrents/mylist'),
      expect.stringContaining('/webdl/mylist'),
      expect.stringContaining('/usenet/mylist'),
    ]);
    expect(calls[0]![1].headers).toEqual({ Authorization: 'Bearer KEY' });
  });

  it('resolves a link from the redirect and uses the right id param', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/f.mp3' } }));
    const link = await createTorBox('KEY', f as unknown as typeof fetch).resolveLink('webdl', 5, 7);
    expect(link).toBe('https://cdn.example/f.mp3');
    const url = (f.mock.calls as unknown as [string][])[0]![0];
    expect(url).toContain('/webdl/requestdl');
    expect(url).toContain('web_id=5&file_id=7');
  });

  it('rejects non-https links and API errors', async () => {
    const http = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://evil/x' } }));
    await expect(createTorBox('K', http as unknown as typeof fetch).resolveLink('torrent', 1, 1)).rejects.toThrow();
    const bad = vi.fn(async () => new Response(JSON.stringify({ success: false, detail: 'nope' }), { status: 401 }));
    await expect(createTorBox('K', bad as unknown as typeof fetch).listFiles()).rejects.toThrow(/nope/);
  });
});

describe('http routes', () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  async function start(provider: DebridProvider | null, upstream?: typeof fetch) {
    server = createServer(createHandler(provider, upstream));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const provider: DebridProvider = {
    listFiles: async () => [],
    resolveLink: vi.fn(async () => 'https://cdn.example/a.mp3'),
  };

  it('reports status', async () => {
    expect(await (await fetch(`${await start(null)}/api/debrid/status`)).json()).toEqual({ configured: false });
  });

  it('rejects non-localhost Host headers (DNS rebinding)', async () => {
    const base = new URL(await start(null));
    const status = (host: string) =>
      new Promise<number>((resolve) => {
        const r = httpRequest({ host: '127.0.0.1', port: base.port, path: '/api/debrid/status', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.end();
      });
    expect(await status('evil.example.com')).toBe(403);
    expect(await status('localhost:5173')).toBe(200);
    expect(await status('127.0.0.1:8787')).toBe(200);
  });

  it('503s when not configured', async () => {
    expect((await fetch(`${await start(null)}/api/debrid/items`)).status).toBe(503);
  });

  it('rejects bad params without calling the provider', async () => {
    const base = await start(provider);
    for (const p of ['bogus/1/1', 'torrent/abc/1', 'torrent/1/-1', 'torrent/1', 'torrent/1/1/extra', 'torrent/1/1e3']) {
      expect((await fetch(`${base}/api/debrid/file/${p}`)).status).toBe(400);
    }
    expect(provider.resolveLink).not.toHaveBeenCalled();
  });

  it('forwards Range and passes headers back', async () => {
    const upstream = vi.fn(
      async () =>
        new Response('abc', {
          status: 206,
          headers: { 'content-range': 'bytes 0-2/10', 'accept-ranges': 'bytes', 'content-type': 'audio/mpeg' },
        }),
    );
    const base = await start(provider, upstream as unknown as typeof fetch);
    const res = await fetch(`${base}/api/debrid/file/torrent/1/2`, { headers: { range: 'bytes=0-2' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-2/10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('abc');
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cdn.example/a.mp3');
    expect(init.headers).toEqual({ range: 'bytes=0-2' });
    expect(provider.resolveLink).toHaveBeenCalledWith('torrent', 1, 2);
  });
});
