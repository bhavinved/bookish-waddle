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

export interface DebridProvider {
  listFiles(): Promise<DebridFile[]>;
  /** Returns a short-lived direct download URL for one file. */
  resolveLink(kind: DebridKind, itemId: number, fileId: number): Promise<string>;
}

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

/** Maps one mylist response `data` array to supported book/audio files. Pure; exported for tests. */
export function mapItems(kind: DebridKind, items: RawItem[]): DebridFile[] {
  const out: DebridFile[] = [];
  for (const item of items) {
    // Only items that are ready: the official TorBox client keys off `cached`; `download_finished` covers own downloads.
    if (!item.cached && !item.download_finished) continue;
    for (const f of item.files ?? []) {
      const name = f.short_name || f.name?.split('/').pop() || '';
      const format = EXT_FORMAT[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
      if (!format || !Number.isInteger(f.id) || !Number.isInteger(item.id)) continue;
      out.push({ kind, itemId: item.id, fileId: f.id, name, size: f.size ?? 0, format });
    }
  }
  return out;
}

export class DebridError extends Error {}

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
