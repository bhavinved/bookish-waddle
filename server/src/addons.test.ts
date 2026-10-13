import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveAudioStream,
  archiveEbookStreams,
  mapArchiveSearch,
  mapLibrivoxSearch,
  mapLibrivoxStreams,
  mapOpds,
  mapOpenLibrary,
} from './addons.ts';
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

describe('Internet Archive mappers', () => {
  it('maps advancedsearch docs with an img-service poster', () => {
    const metas = mapArchiveSearch(fx('archive-search'), 'ebook');
    expect(metas.length).toBeGreaterThan(0);
    expect(metas[0]).toMatchObject({ type: 'ebook', poster: `https://archive.org/services/img/${metas[0]!.id}` });
  });

  it('offers an original EPUB through the file route, and the PDF too when there is one', () => {
    expect(archiveEbookStreams('theadventuresofs01661gut', fx('archive-metadata-ebook'))).toMatchObject([
      { format: 'epub', url: '/api/addons/archive/file/theadventuresofs01661gut/pg1661.epub' },
    ]);
    const both = { files: [{ name: 'a.epub', format: 'EPUB', source: 'original' }, { name: 'a.pdf', format: 'Text PDF', source: 'derivative' }] };
    expect(archiveEbookStreams('a', both).map((s) => s.format)).toEqual(['epub', 'pdf']);
  });

  it('skips archive-generated (derivative) EPUBs from scans and offers the PDF', () => {
    // fixture: adventuresofsher00doyl has a derivative EPUB (page images) and a text PDF
    expect(archiveEbookStreams('adventuresofsher00doyl', fx('archive-metadata-pdf')).map((s) => s.format)).toEqual(['pdf']);
  });

  it('offers nothing for lending-only items', () => {
    expect(archiveEbookStreams('bwb_Y0-DRV-807', fx('archive-metadata-lending'))).toEqual([]);
    expect(archiveAudioStream('bwb_Y0-DRV-807', fx('archive-metadata-lending'))).toBeNull();
  });

  it('builds audio tracks from original MP3s only, in track order, with durations', () => {
    const stream = archiveAudioStream('pride_and_prejudice_librivox', fx('archive-metadata-audio'));
    expect(stream?.tracks?.map((t) => t.title)).toEqual(['Chapters 1-3', 'Chapters 4-5', 'Chapter 6']);
    expect(stream?.tracks?.[0]).toEqual({
      title: 'Chapters 1-3',
      url: 'https://archive.org/download/pride_and_prejudice_librivox/prideandprejudice_01-03_austen.mp3',
      duration: 1133,
    });
    expect(stream?.tracks?.some((t) => t.url.includes('64kb'))).toBe(false);
  });
});

describe('Open Library mapper', () => {
  it('keeps public/borrowable/printdisabled works, drops no_ebook, builds cover URLs', () => {
    const metas = mapOpenLibrary(fx('openlibrary-search'));
    expect(metas.map((m) => m.description)).toEqual(['Free to read', 'Borrow only', 'Borrow only']);
    expect(metas[0]).toMatchObject({ id: 'OL262421W', poster: 'https://covers.openlibrary.org/b/id/6717853-M.jpg' });
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

  it('archive search strips query punctuation and filters lending items out', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(fx('archive-search'))));
    const base = await start(f as never);
    const res = await fetch(`${base}/archive/catalog/ebook/search.json?search=${encodeURIComponent('sherlock") OR (x')}`);
    expect((await res.json()).metas.length).toBeGreaterThan(0);
    const q = new URL((f.mock.calls as unknown as [string][])[0]![0]).searchParams.get('q')!;
    expect(q).toContain('NOT collection:(inlibrary OR printdisabled OR lendinglibrary)');
    // the user's quote and parentheses were stripped, so they cannot close our group early
    expect(q.startsWith('(title:(sherlock OR x) OR creator:(sherlock OR x)) AND mediatype:texts')).toBe(true);
  });

  it('archive file route only serves files listed in the item metadata, from archive.org', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('/metadata/')
        ? new Response(JSON.stringify(url.includes('bwb_') ? fx('archive-metadata-lending') : fx('archive-metadata-ebook')))
        : new Response('epub-bytes', { status: 206, headers: { 'content-type': 'application/epub+zip', 'content-range': 'bytes 0-9/99' } }),
    );
    const base = await start(f as never);
    const get = (p: string, init?: RequestInit) => fetch(`${base}/archive/file/${p}`, init);
    expect((await get('theadventuresofs01661gut/not-listed.epub')).status).toBe(404);
    expect((await get('bwb_Y0-DRV-807/bwb_Y0-DRV-807.epub')).status).toBe(404); // lending-only
    expect((await get('bad%20id/x.epub')).status).toBe(400);
    expect((await get('theadventuresofs01661gut/%E0%A4%A')).status).toBe(400);
    const ok = await get('theadventuresofs01661gut/pg1661.epub', { headers: { range: 'bytes=0-9' } });
    expect(ok.status).toBe(206);
    expect(ok.headers.get('content-range')).toBe('bytes 0-9/99');
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    const dl = calls.find((c) => c[0].includes('/download/'))!;
    expect(dl[0]).toBe('https://archive.org/download/theadventuresofs01661gut/pg1661.epub');
    expect(dl[1].headers).toMatchObject({ range: 'bytes=0-9' });
  });

  it('archive stream route validates identifiers before any upstream call', async () => {
    const f = vi.fn();
    const base = await start(f as never);
    for (const id of ['a%20b', '..', 'x'.repeat(101)]) {
      expect((await fetch(`${base}/archive/stream/ebook/${id}.json`)).status, id).toBe(400);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('openlibrary: borrowable works get an external link, public ones reuse the archive streams', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('openlibrary.org/search.json')) {
        const borrow = url.includes('OL19549765W');
        return new Response(
          JSON.stringify({ docs: [{ key: '/works/X', ebook_access: borrow ? 'borrowable' : 'public', ia: borrow ? [] : ['theadventuresofs01661gut', 'x_librivox'] }] }),
        );
      }
      return new Response(JSON.stringify(fx('archive-metadata-ebook')));
    });
    const base = await start(f as never);
    const borrow = await (await fetch(`${base}/openlibrary/stream/ebook/OL19549765W.json`)).json();
    expect(borrow.streams).toEqual([{ name: 'Borrow on Open Library', externalUrl: 'https://openlibrary.org/works/OL19549765W' }]);
    const pub = await (await fetch(`${base}/openlibrary/stream/ebook/OL262421W.json`)).json();
    expect(pub.streams).toHaveLength(1);
    expect(pub.streams[0]).toMatchObject({ format: 'epub', url: '/api/addons/archive/file/theadventuresofs01661gut/pg1661.epub' });
    expect((await fetch(`${base}/openlibrary/stream/ebook/notakey.json`)).status).toBe(400);
  });
});
