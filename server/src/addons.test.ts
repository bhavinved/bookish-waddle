import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapLibrivoxSearch, mapLibrivoxStreams, mapOpds } from './addons.ts';
import { createHandler } from './app.ts';

// Fixtures are trimmed recordings of real gutenberg.org (OPDS) / librivox.org responses.
const raw = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const fx = (n: string) => JSON.parse(raw(`${n}.json`));

describe('mappers', () => {
  it('maps OPDS book entries to ebook metas and skips Authors/Subjects rows', () => {
    const metas = mapOpds(raw('gutenberg-opds.xml'));
    expect(metas).toEqual([
      {
        id: '1661',
        type: 'ebook',
        name: 'The Adventures of Sherlock Holmes',
        author: 'Arthur Conan Doyle',
        poster: 'https://www.gutenberg.org/cache/epub/1661/pg1661.cover.medium.jpg',
      },
      expect.objectContaining({ id: '244', name: 'A Study in Scarlet' }),
    ]);
  });

  it('decodes XML entities in titles', () => {
    const xml = '<entry><id>https://www.gutenberg.org/ebooks/9.opds</id><title>Tom &amp; Jerry&#39;s</title><content type="text">A &lt;B&gt;</content></entry>';
    expect(mapOpds(xml)[0]).toMatchObject({ name: "Tom & Jerry's", author: 'A <B>' });
  });

  it('maps LibriVox search to audiobook metas with plain-text descriptions', () => {
    const metas = mapLibrivoxSearch(fx('librivox-search'));
    expect(metas[0]).toMatchObject({ id: '253', type: 'audiobook', name: 'Pride and Prejudice', author: 'Jane Austen' });
    expect(metas[0]?.poster).toMatch(/^https:\/\/archive\.org\//);
    expect(metas[0]?.description).not.toMatch(/<|>/);
  });

  it('maps LibriVox sections to tracks', () => {
    const [stream] = mapLibrivoxStreams(fx('librivox-detail'));
    expect(stream?.format).toBe('audio');
    expect(stream?.tracks).toHaveLength(3);
    expect(stream?.tracks?.[0]).toEqual({
      title: 'Chapters 1-3',
      url: 'https://www.archive.org/download/pride_and_prejudice_librivox/prideandprejudice_01-03_austen_64kb.mp3',
      duration: 1132,
    });
    expect(mapLibrivoxStreams({ books: [] })).toEqual([]);
  });
});

describe('add-on routes', () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  async function start(upstream: typeof fetch) {
    server = createServer(createHandler(null, upstream));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/addons`;
  }

  it('serves manifests with CORS', async () => {
    const res = await fetch(`${await start(vi.fn() as never)}/librivox/manifest.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect((await res.json()).catalogs[0]).toMatchObject({ type: 'audiobook', search: true });
  });

  it('gutenberg catalog queries the OPDS feed', async () => {
    const f = vi.fn(async () => new Response(raw('gutenberg-opds.xml')));
    const base = await start(f as never);
    const body = await (await fetch(`${base}/gutenberg/catalog/ebook/search.json?search=sherlock`)).json();
    expect(body.metas[0].id).toBe('1661');
    expect((f.mock.calls as unknown as [string][])[0]![0]).toBe(
      'https://www.gutenberg.org/ebooks/search.opds/?query=sherlock&start_index=1',
    );
  });

  it('librivox catalog treats 404 as empty', async () => {
    const f = vi.fn(async () => new Response('{"error":"Audiobooks could not be found"}', { status: 404 }));
    const base = await start(f as never);
    expect(await (await fetch(`${base}/librivox/catalog/audiobook/search.json?search=zzz`)).json()).toEqual({ metas: [] });
  });

  it('librivox searches title and author, strips a leading article, and dedupes', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('author=')
        ? new Response(JSON.stringify(fx('librivox-search'))) // contains id 253 and 254
        : url.includes('title=%5EHound')
          ? new Response(JSON.stringify({ books: fx('librivox-search').books.slice(0, 1) })) // id 253 again
          : new Response('{}', { status: 404 }),
    );
    const base = await start(f as never);
    const body = await (await fetch(`${base}/librivox/catalog/audiobook/search.json?search=The%20Hound`)).json();
    expect(body.metas.map((m: { id: string }) => m.id)).toEqual(['253', '254']);
    const urls = (f.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(urls.some((u) => u.includes('title=%5EHound'))).toBe(true);
    expect(urls.some((u) => u.includes('author=%5EHound'))).toBe(true);
  });

  it('gutenberg file route only accepts digit ids and fetches a fixed host', async () => {
    const f = vi.fn(async () => new Response('epub-bytes', { headers: { 'content-type': 'application/epub+zip' } }));
    const base = await start(f as never);
    expect((await fetch(`${base}/gutenberg/file/..%2Fevil`)).status).toBe(400);
    expect((await fetch(`${base}/gutenberg/file/12abc`)).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
    const res = await fetch(`${base}/gutenberg/file/1342`);
    expect(await res.text()).toBe('epub-bytes');
    expect((f.mock.calls as unknown as [string][])[0]![0]).toBe('https://www.gutenberg.org/ebooks/1342.epub.images');
  });
});
