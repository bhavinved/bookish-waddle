import type { BookFormat } from '../../core/db';

export interface ResolvedFile {
  kind: 'torrent' | 'webdl' | 'usenet';
  itemId: number;
  fileId: number;
  name: string;
  format: BookFormat;
}
export type ResolveOutcome = ResolvedFile | { status: 'not_cached' | 'queued' };

export async function torBoxConfigured(): Promise<boolean> {
  try {
    const res = await fetch('/api/debrid/status');
    return res.ok && ((await res.json()) as { configured?: boolean }).configured === true;
  } catch {
    return false;
  }
}

/** Asks our server to resolve a torrent infoHash through TorBox (see POST /api/debrid/resolve). */
export async function resolveViaTorBox(infoHash: string, fileIdx: number | undefined, send: boolean): Promise<ResolveOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/debrid/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ infoHash, fileIdx, send: send || undefined }),
    });
  } catch {
    throw new Error('Could not reach the server. Is it running?');
  }
  const body = (await res.json().catch(() => null)) as (ResolveOutcome & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(`TorBox request failed (${body?.error ?? res.status})`);
  return body;
}
