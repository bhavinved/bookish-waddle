/**
 * All TorBox-specific code. Routes only see the `DebridProvider` shape, so another provider can implement it.
 * API: https://api.torbox.app/v1/api (OpenAPI: https://api.torbox.app/openapi.json), Bearer auth.
 */

export type DebridKind = 'torrent' | 'webdl' | 'usenet';
export const KINDS: readonly DebridKind[] = ['torrent', 'webdl', 'usenet'];

export interface DebridFile {
  kind: DebridKind;
  itemId: number;
  fileId: number;
  name: string;
  size: number;
  format: 'epub' | 'pdf' | 'txt' | 'md' | 'audio';
}

export type ResolveResult = DebridFile | { status: 'not_cached' | 'queued' };

export interface DebridProvider {
  listFiles(): Promise<DebridFile[]>;
  /**
   * Stremio-style streams carry a torrent infoHash. If the provider has it cached, adds it and returns the file;
   * otherwise `not_cached`. With `send`, skips the cache check and just queues the download.
   */
  resolveInfoHash(infoHash: string, fileIdx?: number, send?: boolean): Promise<ResolveResult>;
  /** Returns a short-lived direct download URL for one file. */
  resolveLink(kind: DebridKind, itemId: number, fileId: number): Promise<string>;
}

const MIN_TEXT_BYTES = 20 * 1024;

const BASE = 'https://api.torbox.app/v1/api';

// Path segment and the id query-param name per kind (see openapi.json).
const KIND_API: Record<DebridKind, { path: string; idParam: string }> = {
  torrent: { path: 'torrents', idParam: 'torrent_id' },
  webdl: { path: 'webdl', idParam: 'web_id' },
  usenet: { path: 'usenet', idParam: 'usenet_id' },
};

// shortcut: duplicated from web/src/core/formats.ts; share a package if a third consumer appears.
const EXT_FORMAT: Record<string, DebridFile['format']> = {
  epub: 'epub',
  pdf: 'pdf',
  txt: 'txt',
  text: 'txt',
  md: 'md',
  markdown: 'md',
  mp3: 'audio',
  m4b: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  flac: 'audio',
  wav: 'audio',
};

interface RawFile {
  id: number;
  name?: string;
  short_name?: string;
  size?: number;
}
interface RawItem {
  id: number;
  cached?: boolean;
  download_finished?: boolean;
  files?: RawFile[];
}

/** Supported files of one item, ready or not. */
function mapFiles(kind: DebridKind, item: RawItem): DebridFile[] {
  const out: DebridFile[] = [];
  for (const f of item.files ?? []) {
    const name = f.short_name || f.name?.split('/').pop() || '';
    const format = EXT_FORMAT[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
    if (!format || !Number.isInteger(f.id) || !Number.isInteger(item.id)) continue;
    out.push({ kind, itemId: item.id, fileId: f.id, name, size: f.size ?? 0, format });
  }
  return out;
}

/** Maps one mylist response `data` array to supported book/audio files. Pure; exported for tests. */
export function mapItems(kind: DebridKind, items: RawItem[]): DebridFile[] {
  // Only items that are ready: the official TorBox client keys off `cached`; `download_finished` covers own downloads.
  return (
    items
      .filter((i) => i.cached || i.download_finished)
      .flatMap((i) => mapFiles(kind, i))
      // shortcut: size heuristic for tracker promo/readme files; real text books are larger. Revisit if it hides short books.
      .filter((f) => !((f.format === 'txt' || f.format === 'md') && f.size < MIN_TEXT_BYTES))
  );
}

export class DebridError extends Error {}

interface Envelope {
  success?: boolean;
  detail?: string;
  data?: unknown;
}

export function createTorBox(apiKey: string, fetchFn: typeof fetch = fetch): DebridProvider {
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function listKind(kind: DebridKind): Promise<DebridFile[]> {
    // shortcut: first 1000 items only (no paging); add offset loop for huge accounts.
    const res = await fetchFn(`${BASE}/${KIND_API[kind].path}/mylist?limit=1000&bypass_cache=true`, { headers });
    const body = (await res.json().catch(() => null)) as { success?: boolean; detail?: string; data?: RawItem[] } | null;
    if (!res.ok || !body || body.success === false || !Array.isArray(body.data)) {
      throw new DebridError(`TorBox ${kind} list failed: ${body?.detail ?? res.status}`);
    }
    return mapItems(kind, body.data);
  }

  return {
    async listFiles() {
      return (await Promise.all(KINDS.map(listKind))).flat();
    },

    async resolveInfoHash(infoHash, fileIdx, send = false) {
      const hash = infoHash.toLowerCase();
      if (!send) {
        // GET torrents/checkcached?hash=<h>&format=list lists the cached hashes among those asked about.
        const res = await fetchFn(`${BASE}/torrents/checkcached?hash=${hash}&format=list`, { headers });
        const body = (await res.json().catch(() => null)) as Envelope | null;
        if (!res.ok || !body || body.success === false) throw new DebridError(`TorBox cache check failed: ${body?.detail ?? res.status}`);
        const d = body.data;
        // shortcut: response shape for "cached" is handled loosely (array of entries/hashes or object keyed by hash).
        const cached = Array.isArray(d)
          ? d.some((x) => (typeof x === 'string' ? x : (x as { hash?: string })?.hash)?.toLowerCase() === hash)
          : !!d && typeof d === 'object' && hash in d;
        if (!cached) return { status: 'not_cached' };
      }

      // POST torrents/createtorrent (multipart): magnet link; add_only_if_cached guards against queueing by accident.
      const form = new FormData();
      form.set('magnet', `magnet:?xt=urn:btih:${hash}`);
      if (!send) form.set('add_only_if_cached', 'true');
      const created = await fetchFn(`${BASE}/torrents/createtorrent`, { method: 'POST', headers, body: form });
      const cb = (await created.json().catch(() => null)) as (Envelope & { data?: { torrent_id?: number } }) | null;
      if (!created.ok || !cb || cb.success === false) throw new DebridError(`TorBox could not add the torrent: ${cb?.detail ?? created.status}`);
      if (send) return { status: 'queued' };
      const id = cb.data?.torrent_id;
      if (!Number.isInteger(id)) throw new DebridError('TorBox did not return a torrent id');

      const list = await fetchFn(`${BASE}/torrents/mylist?id=${id}&bypass_cache=true`, { headers });
      const lb = (await list.json().catch(() => null)) as Envelope | null;
      const item = (Array.isArray(lb?.data) ? lb.data[0] : lb?.data) as RawItem | undefined;
      if (!list.ok || !item) throw new DebridError(`TorBox could not list the torrent: ${lb?.detail ?? list.status}`);
      const files = mapFiles('torrent', item);
      // shortcut: assumes Stremio's fileIdx equals TorBox's file id (both 0-based file order).
      const file = fileIdx === undefined ? files[0] : files.find((f) => f.fileId === fileIdx);
      if (!file) throw new DebridError('No supported book or audio file in that torrent');
      return file;
    },

    async resolveLink(kind, itemId, fileId) {
      const { path, idParam } = KIND_API[kind];
      // requestdl takes the token as a query param. redirect=true makes TorBox answer 302 with the direct URL.
      const url = `${BASE}/${path}/requestdl?token=${encodeURIComponent(apiKey)}&${idParam}=${itemId}&file_id=${fileId}&redirect=true`;
      const res = await fetchFn(url, { headers, redirect: 'manual' });
      let link = res.headers.get('location');
      if (!link && res.ok) {
        // Fallback for the JSON form: { success, data: "<url>" }
        const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
        if (typeof body?.data === 'string') link = body.data;
      }
      if (!link) throw new DebridError(`TorBox could not provide a download link (${res.status})`);
      if (new URL(link).protocol !== 'https:') throw new DebridError('TorBox returned a non-https link');
      return link;
    },
  };
}
