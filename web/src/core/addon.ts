/** Add-on protocol client (see docs/addons.md). Everything an add-on returns is untrusted and validated here. */
import type { Book, SourceRef } from './db';

export type AddonType = 'ebook' | 'audiobook';

export interface Catalog {
  type: AddonType;
  id: string;
  name: string;
  search: boolean;
}
export interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string;
  types: AddonType[];
  catalogs: Catalog[];
}
export interface Meta {
  id: string;
  type: AddonType;
  name: string;
  author?: string;
  poster?: string;
  description?: string;
}
export interface Track {
  title: string;
  url: string;
  duration?: number;
}
export interface Stream {
  name: string;
  format: 'epub' | 'pdf' | 'txt' | 'audio';
  url?: string;
  tracks?: Track[];
}

/** Built-in add-ons are served by our own server with the same protocol. */
export const BUILTIN_ADDONS = ['/api/addons/gutenberg', '/api/addons/librivox'];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isType = (x: unknown): x is AddonType => x === 'ebook' || x === 'audiobook';
const optStr = (x: unknown) => (typeof x === 'string' && x ? x : undefined);

/** Only https URLs from add-ons; built-ins may also use their own same-origin /api/addons/ paths. */
function safeUrl(x: unknown, builtin: boolean): string | undefined {
  if (!isStr(x)) return undefined;
  if (builtin && x.startsWith('/api/addons/')) return x;
  try {
    return new URL(x).protocol === 'https:' ? x : undefined;
  } catch {
    return undefined;
  }
}

/** Throws if the essentials are missing; silently drops malformed catalogs. */
export function parseManifest(x: unknown): Manifest {
  if (!isObj(x) || !isStr(x.id) || !isStr(x.name)) throw new Error('Not a valid add-on manifest (needs id and name)');
  const types = Array.isArray(x.types) ? x.types.filter(isType) : [];
  const catalogs = (Array.isArray(x.catalogs) ? x.catalogs : []).flatMap((c): Catalog[] =>
    isObj(c) && isType(c.type) && isStr(c.id) && isStr(c.name) && typeof c.search === 'boolean'
      ? [{ type: c.type, id: c.id, name: c.name, search: c.search }]
      : [],
  );
  return {
    id: x.id,
    name: x.name,
    version: optStr(x.version) ?? '0',
    description: optStr(x.description) ?? '',
    types,
    catalogs,
  };
}

export function parseMetas(x: unknown, builtin = false): Meta[] {
  if (!isObj(x) || !Array.isArray(x.metas)) return [];
  return x.metas.flatMap((m): Meta[] =>
    isObj(m) && isStr(m.id) && isType(m.type) && isStr(m.name)
      ? [
          {
            id: m.id,
            type: m.type,
            name: m.name,
            author: optStr(m.author),
            poster: safeUrl(m.poster, builtin),
            description: optStr(m.description),
          },
        ]
      : [],
  );
}

const FORMATS = ['epub', 'pdf', 'txt', 'audio'] as const;

export function parseStreams(x: unknown, builtin = false): Stream[] {
  if (!isObj(x) || !Array.isArray(x.streams)) return [];
  return x.streams.flatMap((s): Stream[] => {
    if (!isObj(s) || !FORMATS.includes(s.format as never)) return [];
    const format = s.format as Stream['format'];
    const name = optStr(s.name) ?? format;
    const tracks = Array.isArray(s.tracks)
      ? s.tracks.flatMap((t): Track[] => {
          const url = isObj(t) ? safeUrl(t.url, builtin) : undefined;
          return isObj(t) && url
            ? [{ title: optStr(t.title) ?? 'Track', url, duration: typeof t.duration === 'number' && t.duration > 0 ? t.duration : undefined }]
            : [];
        })
      : [];
    const url = safeUrl(s.url, builtin);
    if (format === 'audio' && tracks.length > 0) return [{ name, format, tracks }];
    return url ? [{ name, format, url }] : [];
  });
}

/** Accepts a pasted base or manifest URL; returns the https base without trailing slash, or throws. */
export function normalizeBaseUrl(input: string): string {
  const u = new URL(input.trim());
  if (u.protocol !== 'https:') throw new Error('Add-on URLs must start with https://');
  u.search = '';
  u.hash = '';
  return u.href.replace(/\/manifest\.json$/, '').replace(/\/+$/, '');
}

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // shortcut: a CORS rejection and a dead host look the same to fetch(); we cannot tell them apart.
    throw new Error('Could not reach the add-on (it may be offline or may not allow cross-origin requests)');
  }
  if (!res.ok) throw new Error(`Add-on answered ${res.status}`);
  return res.json();
}

export const isBuiltin = (baseUrl: string) => BUILTIN_ADDONS.includes(baseUrl);

export async function fetchManifest(baseUrl: string): Promise<Manifest> {
  return parseManifest(await getJson(`${baseUrl}/manifest.json`));
}

export async function searchCatalog(baseUrl: string, c: Catalog, query: string): Promise<Meta[]> {
  const url = `${baseUrl}/catalog/${c.type}/${encodeURIComponent(c.id)}.json?search=${encodeURIComponent(query)}`;
  return parseMetas(await getJson(url), isBuiltin(baseUrl));
}

export async function getStreams(baseUrl: string, meta: Meta): Promise<Stream[]> {
  const url = `${baseUrl}/stream/${meta.type}/${encodeURIComponent(meta.id)}.json`;
  return parseStreams(await getJson(url), isBuiltin(baseUrl));
}

/** Builds the Book fields + sourceRef for adding a picked stream to the library. */
export function bookFromStream(
  addonId: string,
  meta: Meta,
  stream: Stream,
): { sourceRef: SourceRef; fields: Omit<Book, 'id' | 'sourceRef' | 'addedAt' | 'lastOpenedAt'> } {
  const base = { title: meta.name, author: meta.author ?? '', coverUrl: meta.poster };
  const sourceRef: SourceRef = { kind: 'addon', id: `${addonId}/${meta.id}`, stream };
  if (stream.format !== 'audio' || !stream.tracks) return { sourceRef, fields: { ...base, format: stream.format } };
  let start = 0;
  const chapters = stream.tracks.map((t) => {
    const c = { title: t.title, start, duration: t.duration };
    start += t.duration ?? 0;
    return c;
  });
  return {
    sourceRef,
    fields: { ...base, format: 'audio', chapters, multiTrack: true, durationSec: start > 0 ? start : undefined },
  };
}
