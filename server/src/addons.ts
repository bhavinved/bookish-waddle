/**
 * Built-in add-ons (Gutenberg, LibriVox), served with the same protocol as third-party add-ons (docs/addons.md)
 * under /api/addons/<id>/. Upstream shapes: Gutenberg OPDS (https://www.gutenberg.org/ebooks/search.opds/) and https://librivox.org/api/info
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
  format: 'epub' | 'pdf' | 'txt' | 'audio';
  url?: string;
  tracks?: { title: string; url: string; duration?: number }[];
}

export const MANIFESTS: Record<string, Manifest> = {
  gutenberg: {
    id: 'gutenberg',
    name: 'Project Gutenberg',
    version: '1.0.0',
    description: 'Public-domain ebooks',
    types: ['ebook'],
    catalogs: [{ type: 'ebook', id: 'search', name: 'Search', search: true }],
  },
  librivox: {
    id: 'librivox',
    name: 'LibriVox',
    version: '1.0.0',
    description: 'Free public-domain audiobooks read by volunteers',
    types: ['audiobook'],
    catalogs: [{ type: 'audiobook', id: 'search', name: 'Search', search: true }],
  },
};

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

const DIGITS = /^\d{1,9}$/;

export function createAddonHandler(fetchFn: typeof fetch = fetch) {
  /** Returns true if the path belonged to the add-on routes. */
  return async (_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const m = /^\/api\/addons\/([a-z]+)\/(.+)$/.exec(url.pathname);
    if (!m) return false;
    const [, addon, rest] = m as unknown as [string, string, string];
    // Same CORS contract as third-party add-ons (docs/addons.md).
    res.setHeader('access-control-allow-origin', '*');
    const reply = (status: number, body: unknown) => (json(res, status, body), true);
    const manifest = MANIFESTS[addon];
    if (!manifest) return reply(404, { error: 'unknown_addon' });

    if (rest === 'manifest.json') return reply(200, manifest);

    const catalog = /^catalog\/([a-z]+)\/([a-z]+)\.json$/.exec(rest);
    if (catalog) {
      if (!manifest.catalogs.some((c) => c.type === catalog[1] && c.id === catalog[2])) return reply(404, { error: 'unknown_catalog' });
      const q = (url.searchParams.get('search') ?? '').trim().slice(0, 100);
      const skip = Math.max(0, Math.floor(Number(url.searchParams.get('skip'))) || 0);
      if (addon === 'gutenberg') {
        const up = await fetchFn(
          `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(q)}&start_index=${skip + 1}`,
          upstream(),
        );
        if (!up.ok) return reply(502, { error: `gutenberg ${up.status}` });
        return reply(200, { metas: mapOpds(await up.text()) });
      }
      // LibriVox title search is prefix-only and its titles omit a leading article, so search titles and authors.
      const term = q.replace(/^(the|an|a)\s+/i, '');
      const api = `https://librivox.org/api/feed/audiobooks?format=json&coverart=1&limit=${LIBRIVOX_PAGE_SIZE}&offset=${skip}`;
      // LibriVox author search matches the last name, so use the query's last word for it.
      const search = async (field: 'title' | 'author'): Promise<Meta[]> => {
        const value = field === 'author' ? (term.split(/\s+/).pop() ?? term) : term;
        const up = await fetchFn(`${api}&${field}=${encodeURIComponent('^' + value)}`, upstream());
        if (up.status === 404) return []; // "Audiobooks could not be found"
        if (!up.ok) throw new Error(`librivox ${up.status}`);
        return mapLibrivoxSearch((await up.json()) as never);
      };
      const found = (await Promise.all([search('title'), search('author')])).flat();
      const seen = new Set<string>();
      return reply(200, { metas: found.filter((m) => !seen.has(m.id) && seen.add(m.id)) });
    }

    const stream = /^stream\/([a-z]+)\/(\d{1,9})\.json$/.exec(rest);
    if (stream) {
      const id = stream[2]!;
      if (addon === 'gutenberg') {
        return reply(200, {
          streams: [{ name: 'Project Gutenberg EPUB', format: 'epub', url: `/api/addons/gutenberg/file/${id}` }],
        });
      }
      const up = await fetchFn(`https://librivox.org/api/feed/audiobooks?format=json&extended=1&id=${id}`, upstream());
      if (up.status === 404) return reply(200, { streams: [] });
      if (!up.ok) return reply(502, { error: `librivox ${up.status}` });
      return reply(200, { streams: mapLibrivoxStreams((await up.json()) as never) });
    }

    // gutenberg.org sends no CORS headers, so the EPUB is fetched here. Host is fixed; only the digits-only id varies.
    const file = /^file\/(.+)$/.exec(rest);
    if (file && addon === 'gutenberg') {
      if (!DIGITS.test(file[1]!)) return reply(400, { error: 'bad_params' });
      // shortcut: follows gutenberg.org's redirects without re-checking each hop; pin the final URL if that matters.
      const up = await fetchFn(`https://www.gutenberg.org/ebooks/${file[1]}.epub.images`, { headers: UA });
      if (!up.ok) return reply(502, { error: `gutenberg ${up.status}` });
      // content-length is not forwarded: fetch() may have decoded a compressed body.
      pipeResponse(up, res, ['content-type']);
      return true;
    }
    return reply(404, { error: 'not_found' });
  };
}
