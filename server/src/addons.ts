/**
 * Built-in add-ons (Gutenberg, LibriVox, Internet Archive, Open Library), served with the same protocol as third-party add-ons (docs/addons.md)
 * under /api/addons/<id>/. Upstream shapes: Gutenberg OPDS (https://www.gutenberg.org/ebooks/search.opds/), https://librivox.org/api/info, https://archive.org/advancedsearch.php and /metadata/<id>, https://openlibrary.org/search.json
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, pipeResponse } from './http.ts';

interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string;
  types: ('ebook' | 'audiobook')[];
  catalogs: { type: 'ebook' | 'audiobook'; id: string; name: string; search: boolean }[];
}
interface Meta {
  id: string;
  type: 'ebook' | 'audiobook';
  name: string;
  author?: string;
  poster?: string;
  description?: string;
}
interface Stream {
  name: string;
  format?: 'epub' | 'pdf' | 'txt' | 'audio';
  url?: string;
  tracks?: { title: string; url: string; duration?: number }[];
  /** Not downloadable here (e.g. borrow-only): the UI shows a link instead of an Add button. */
  externalUrl?: string;
}

const LIBRIVOX_PAGE_SIZE = 20;
// Gutendex is unusable from Node (Cloudflare rejects its TLS fingerprint), so search uses Gutenberg's own OPDS feed.
const UA = { 'user-agent': 'bookish-waddle/0.1' };
// Upstreams can hang; fail with a 502 instead of leaving the UI waiting forever.
const upstream = () => ({ headers: UA, signal: AbortSignal.timeout(15_000) });

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec, hex, name) =>
    name ? XML_ENTITIES[name.toLowerCase()]! : String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16)),
  );

/**
 * Maps a Gutenberg OPDS (Atom) search page to metas.
 * shortcut: regex parsing, fine for this fixed-host feed whose entries are flat; use an XML parser if it grows.
 */
export function mapOpds(xml: string): Meta[] {
  const metas: Meta[] = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    // Book entries have ids like https://www.gutenberg.org/ebooks/1661.opds; "Authors"/"Subjects" rows do not.
    const id = /<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/.exec(entry)?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(entry)?.[1];
    if (!id || !title) continue;
    const author = /<content[^>]*>([^<]*)<\/content>/.exec(entry)?.[1];
    metas.push({
      id,
      type: 'ebook',
      name: decodeXml(title),
      author: author ? decodeXml(author) : undefined,
      // The feed's own thumbnail is an inline placeholder image, so use the real cover URL.
      poster: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
    });
  }
  return metas;
}

interface LibrivoxBook {
  id: string;
  title: string;
  description?: string;
  authors?: { first_name?: string; last_name?: string }[];
  coverart_thumbnail?: string;
  coverart_jpg?: string;
  sections?: { title: string; listen_url: string; playtime?: string }[];
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export function mapLibrivoxSearch(body: { books?: LibrivoxBook[] }): Meta[] {
  return (body.books ?? []).map((b) => ({
    id: b.id,
    type: 'audiobook' as const,
    name: b.title,
    author: b.authors?.map((a) => `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim()).join(', ') || undefined,
    poster: b.coverart_thumbnail || b.coverart_jpg,
    description: b.description ? stripTags(b.description) : undefined,
  }));
}

export function mapLibrivoxStreams(body: { books?: LibrivoxBook[] }): Stream[] {
  const tracks = (body.books?.[0]?.sections ?? []).map((s) => ({
    title: s.title,
    url: s.listen_url.replace(/^http:/, 'https:'),
    duration: Number(s.playtime) || undefined,
  }));
  return tracks.length ? [{ name: 'LibriVox MP3', format: 'audio', tracks }] : [];
}

// ---------- Internet Archive ----------

// The lookahead rejects "." and "..", which URL normalisation would turn into other archive.org paths.
const ARCHIVE_ID = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
const OL_ID = /^OL\d{1,12}W$/;
const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

interface IaFile {
  name: string;
  format?: string;
  source?: string;
  track?: string;
  length?: string;
  title?: string;
}
export interface IaMetadata {
  metadata?: { collection?: string | string[]; 'access-restricted-item'?: string };
  files?: IaFile[];
  is_dark?: boolean;
}

/** Lending-only items list files that cannot actually be downloaded (the download answers 500/403). */
export function isLendingOnly(m: IaMetadata): boolean {
  const collections = asArray(m.metadata?.collection);
  return (
    m.is_dark === true ||
    m.metadata?.['access-restricted-item'] === 'true' ||
    collections.some((c) => ['inlibrary', 'printdisabled', 'lendinglibrary'].includes(c))
  );
}

const iaPath = (id: string, name: string) => `${id}/${name.split('/').map(encodeURIComponent).join('/')}`;

export function mapArchiveSearch(body: { response?: { docs?: { identifier: string; title?: string; creator?: string | string[] }[] } }, type: Meta['type']): Meta[] {
  return (body.response?.docs ?? []).flatMap((d) =>
    d.identifier && d.title
      ? [
          {
            id: d.identifier,
            type,
            name: d.title,
            author: asArray(d.creator).join('; ') || undefined,
            poster: `https://archive.org/services/img/${d.identifier}`,
          },
        ]
      : [],
  );
}

/**
 * The item's EPUB and/or text PDF, served through our file route (archive.org downloads send no CORS).
 * An EPUB is offered only when it is an uploaded original: the ones archive.org derives from scans are page-image
 * EPUBs that epub.js cannot open, so those items get their PDF only.
 */
export function archiveEbookStreams(id: string, m: IaMetadata): Stream[] {
  if (isLendingOnly(m)) return [];
  const files = m.files ?? [];
  const pick = (format: string, label: string, fmt: 'epub' | 'pdf'): Stream[] => {
    const f = files.find((x) => x.format === format && (fmt === 'pdf' || x.source === 'original'));
    return f ? [{ name: `Internet Archive ${label} (${id})`, format: fmt, url: `/api/addons/archive/file/${iaPath(id, f.name)}` }] : [];
  };
  return [...pick('EPUB', 'EPUB', 'epub'), ...pick('Text PDF', 'PDF', 'pdf')];
}

function seconds(len?: string): number | undefined {
  if (!len) return undefined;
  const n = len.includes(':') ? len.split(':').reduce((acc, p) => acc * 60 + Number(p), 0) : Number(len);
  return n > 0 ? Math.round(n) : undefined;
}

/** Original MP3s in track order (derivatives such as _64kb duplicates are skipped). Audio needs no CORS, so URLs are direct. */
export function archiveAudioStream(id: string, m: IaMetadata): Stream | null {
  if (isLendingOnly(m)) return null;
  const mp3 = (m.files ?? []).filter((f) => /mp3/i.test(f.format ?? ''));
  const originals = mp3.filter((f) => f.source === 'original');
  const chosen = (originals.length ? originals : mp3)
    .map((f) => ({ f, n: parseInt(f.track ?? '', 10) }))
    .sort((a, b) => (a.n || Infinity) - (b.n || Infinity) || a.f.name.localeCompare(b.f.name));
  if (!chosen.length) return null;
  return {
    name: 'Internet Archive MP3',
    format: 'audio',
    tracks: chosen.map(({ f }) => ({
      title: f.title || f.name.replace(/\.[^.]+$/, ''),
      url: `https://archive.org/download/${iaPath(id, f.name)}`,
      duration: seconds(f.length),
    })),
  };
}

/** Lucene special characters would let a query escape the filters we add around it. */
const luceneSafe = (q: string) => q.replace(/[^\p{L}\p{N}\s'.-]/gu, ' ').replace(/\s+/g, ' ').trim();

// ---------- Open Library ----------

interface OlDoc {
  key: string;
  title?: string;
  author_name?: string[];
  cover_i?: number;
  ebook_access?: string;
  ia?: string[];
}

export function mapOpenLibrary(body: { docs?: OlDoc[] }): Meta[] {
  return (body.docs ?? []).flatMap((d) => {
    const id = /^\/works\/(OL\d+W)$/.exec(d.key)?.[1];
    if (!id || !d.title || !['public', 'borrowable', 'printdisabled'].includes(d.ebook_access ?? '')) return [];
    return [
      {
        id,
        type: 'ebook' as const,
        name: d.title,
        author: d.author_name?.slice(0, 3).join('; ') || undefined,
        poster: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined,
        description: d.ebook_access === 'public' ? 'Free to read' : 'Borrow only',
      },
    ];
  });
}

// ---------- Routing ----------

const SEARCH_ONLY = [{ id: 'search', name: 'Search', search: true }];
const catalogs = (...types: Meta['type'][]) => types.flatMap((type) => SEARCH_ONLY.map((c) => ({ ...c, type })));

export const MANIFESTS: Record<string, Manifest> = {
  gutenberg: {
    id: 'gutenberg',
    name: 'Project Gutenberg',
    version: '1.0.0',
    description: 'Public-domain ebooks',
    types: ['ebook'],
    catalogs: catalogs('ebook'),
  },
  librivox: {
    id: 'librivox',
    name: 'LibriVox',
    version: '1.0.0',
    description: 'Free public-domain audiobooks read by volunteers',
    types: ['audiobook'],
    catalogs: catalogs('audiobook'),
  },
  archive: {
    id: 'archive',
    name: 'Internet Archive',
    version: '1.0.0',
    description: 'Freely downloadable books and audiobooks (full-text search)',
    types: ['ebook', 'audiobook'],
    catalogs: catalogs('ebook', 'audiobook'),
  },
  openlibrary: {
    id: 'openlibrary',
    name: 'Open Library',
    version: '1.0.0',
    description: 'Free-to-read ebooks, plus links to borrow the rest',
    types: ['ebook'],
    catalogs: catalogs('ebook'),
  },
};

interface AddonImpl {
  idPattern: RegExp;
  search(type: Meta['type'], q: string, skip: number): Promise<Meta[]>;
  streams(type: Meta['type'], id: string): Promise<Stream[]>;
  /** Optional file route: `rest` is the path after /file/. Returns false when it sent no response. */
  file?(rest: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

const DIGITS = /^\d{1,9}$/;
const FILE_PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

export function createAddonHandler(fetchFn: typeof fetch = fetch) {
  const getJson = async (url: string): Promise<unknown> => {
    const up = await fetchFn(url, upstream());
    if (up.status === 404) return null; // LibriVox answers 404 for "no results"
    if (!up.ok) throw new Error(`${new URL(url).hostname} ${up.status}`);
    return up.json();
  };

  const iaMetadata = async (id: string): Promise<IaMetadata | null> => {
    const m = (await getJson(`https://archive.org/metadata/${id}`).catch(() => null)) as IaMetadata | null;
    return m && Array.isArray(m.files) ? m : null;
  };
  const archiveEbooks = async (id: string) => {
    const m = await iaMetadata(id);
    return m ? archiveEbookStreams(id, m) : [];
  };

  const addons: Record<string, AddonImpl> = {
    gutenberg: {
      idPattern: DIGITS,
      async search(_type, q, skip) {
        const up = await fetchFn(
          `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(q)}&start_index=${skip + 1}`,
          upstream(),
        );
        if (!up.ok) throw new Error(`gutenberg ${up.status}`);
        return mapOpds(await up.text());
      },
      async streams(_type, id) {
        return [{ name: 'Project Gutenberg EPUB', format: 'epub', url: `/api/addons/gutenberg/file/${id}` }];
      },
      // gutenberg.org sends no CORS headers, so the EPUB is fetched here. Host is fixed; only the digits-only id varies.
      async file(rest, _req, res) {
        if (!DIGITS.test(rest)) return json(res, 400, { error: 'bad_params' }), true;
        // shortcut: follows gutenberg.org's redirects without re-checking each hop; pin the final URL if that matters.
        const up = await fetchFn(`https://www.gutenberg.org/ebooks/${rest}.epub.images`, { headers: UA });
        if (!up.ok) return json(res, 502, { error: `gutenberg ${up.status}` }), true;
        // content-length is not forwarded: fetch() may have decoded a compressed body.
        pipeResponse(up, res, ['content-type']);
        return true;
      },
    },

    librivox: {
      idPattern: DIGITS,
      async search(_type, q, skip) {
        // Title search is prefix-only and titles omit a leading article; author search matches the last name.
        const term = q.replace(/^(the|an|a)\s+/i, '');
        const api = `https://librivox.org/api/feed/audiobooks?format=json&coverart=1&limit=${LIBRIVOX_PAGE_SIZE}&offset=${skip}`;
        const run = async (field: 'title' | 'author', value: string) =>
          mapLibrivoxSearch(((await getJson(`${api}&${field}=${encodeURIComponent('^' + value)}`)) ?? {}) as never);
        const found = (await Promise.all([run('title', term), run('author', term.split(/\s+/).pop() ?? term)])).flat();
        const seen = new Set<string>();
        return found.filter((m) => !seen.has(m.id) && seen.add(m.id));
      },
      async streams(_type, id) {
        const body = await getJson(`https://librivox.org/api/feed/audiobooks?format=json&extended=1&id=${id}`);
        return body ? mapLibrivoxStreams(body as never) : [];
      },
    },

    archive: {
      idPattern: ARCHIVE_ID,
      async search(type, q, skip) {
        const text = luceneSafe(q);
        if (!text) return [];
        const filter =
          type === 'ebook'
            ? 'mediatype:texts AND NOT collection:(inlibrary OR printdisabled OR lendinglibrary) AND (format:EPUB OR format:"Text PDF")'
            : 'mediatype:audio AND collection:(librivoxaudio OR audio_bookspoetry)';
        const params = new URLSearchParams({ q: `(title:(${text}) OR creator:(${text})) AND ${filter}`, rows: '20', page: String(Math.floor(skip / 20) + 1), output: 'json' });
        for (const f of ['identifier', 'title', 'creator']) params.append('fl[]', f);
        params.append('sort[]', 'downloads desc');
        return mapArchiveSearch((await getJson(`https://archive.org/advancedsearch.php?${params}`)) as never, type);
      },
      async streams(type, id) {
        const m = await iaMetadata(id);
        if (!m) return [];
        if (type === 'ebook') return archiveEbookStreams(id, m);
        const audio = archiveAudioStream(id, m);
        return audio ? [audio] : [];
      },
      // archive.org downloads send no CORS headers. Host is fixed; the file must be listed in the item's own metadata.
      async file(rest, req, res) {
        const m = /^([^/]+)\/(.+)$/.exec(rest);
        let name: string;
        try {
          name = decodeURIComponent(m?.[2] ?? '');
        } catch {
          name = '';
        }
        if (!m || !ARCHIVE_ID.test(m[1]!) || !name) return json(res, 400, { error: 'bad_params' }), true;
        const meta = await iaMetadata(m[1]!);
        if (!meta || isLendingOnly(meta) || !meta.files?.some((f) => f.name === name)) {
          return json(res, 404, { error: 'not_found' }), true;
        }
        const range = req.headers.range;
        const up = await fetchFn(`https://archive.org/download/${iaPath(m[1]!, name)}`, { headers: range ? { ...UA, range } : UA });
        pipeResponse(up, res, FILE_PASS);
        return true;
      },
    },

    openlibrary: {
      idPattern: OL_ID,
      async search(_type, q, skip) {
        const params = new URLSearchParams({ q, fields: 'key,title,author_name,cover_i,ebook_access', limit: '20', offset: String(skip) });
        return mapOpenLibrary((await getJson(`https://openlibrary.org/search.json?${params}`)) as never);
      },
      async streams(_type, id) {
        const params = new URLSearchParams({ q: `key:/works/${id}`, fields: 'key,ebook_access,ia', limit: '1' });
        const doc = ((await getJson(`https://openlibrary.org/search.json?${params}`)) as { docs?: OlDoc[] } | null)?.docs?.[0];
        if (!doc) return [];
        const page = `https://openlibrary.org/works/${id}`;
        if (doc.ebook_access !== 'public') return [{ name: 'Borrow on Open Library', externalUrl: page }];
        // A work lists many archive.org scans; keep the first few that really are downloadable (same code as the archive add-on).
        const candidates = (doc.ia ?? []).filter((i) => ARCHIVE_ID.test(i) && !i.endsWith('_librivox')).slice(0, 6);
        const found = (await Promise.all(candidates.map(archiveEbooks))).flat().slice(0, 4);
        return found.length ? found : [{ name: 'Open on Open Library', externalUrl: page }];
      },
    },
  };

  /** Returns true if the path belonged to the add-on routes. */
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const m = /^\/api\/addons\/([a-z]+)\/(.+)$/.exec(url.pathname);
    if (!m) return false;
    const [, addon, rest] = m as unknown as [string, string, string];
    // Same CORS contract as third-party add-ons (docs/addons.md).
    res.setHeader('access-control-allow-origin', '*');
    const reply = (status: number, body: unknown) => (json(res, status, body), true);
    const manifest = MANIFESTS[addon];
    const impl = addons[addon];
    if (!manifest || !impl) return reply(404, { error: 'unknown_addon' });

    if (rest === 'manifest.json') return reply(200, manifest);

    const catalog = /^catalog\/([a-z]+)\/([a-z]+)\.json$/.exec(rest);
    if (catalog) {
      const c = manifest.catalogs.find((x) => x.type === catalog[1] && x.id === catalog[2]);
      if (!c) return reply(404, { error: 'unknown_catalog' });
      const q = (url.searchParams.get('search') ?? '').trim().slice(0, 100);
      const skip = Math.max(0, Math.floor(Number(url.searchParams.get('skip'))) || 0);
      return reply(200, { metas: await impl.search(c.type, q, skip) });
    }

    const stream = /^stream\/(ebook|audiobook)\/([^/]+)\.json$/.exec(rest);
    if (stream) {
      if (!manifest.types.includes(stream[1] as Meta['type']) || !impl.idPattern.test(stream[2]!)) {
        return reply(400, { error: 'bad_params' });
      }
      return reply(200, { streams: await impl.streams(stream[1] as Meta['type'], stream[2]!) });
    }

    const file = /^file\/(.+)$/.exec(rest);
    if (file && impl.file) return impl.file(file[1]!, req, res);
    return reply(404, { error: 'not_found' });
  };
}
