import type { Stream } from './addon';
import { db, type Book } from './db';
import { mimeFor } from './formats';

/**
 * Where a book's bytes come from. Readers and the player consume ONLY this interface; they never touch
 * files, IndexedDB or the network directly (see CLAUDE.md). M2 adds `debrid` sources, M3 `addon` sources.
 */
export interface BookSource {
  kind: 'local' | 'debrid' | 'addon';
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  getBlob(): Promise<Blob>;
  /**
   * Returns a URL usable in `<audio src>` or fetch(). For local sources this is an object URL.
   * Lifecycle convention (we chose `release()` over returned cleanup callbacks): URLs handed out by
   * `getUrl()` stay valid until the source's `release()` is called. Whoever opened the source calls
   * `release()` when done with it. Repeated getUrl() calls return the same URL while it is still valid.
   * Multi-track sources (add-on audiobooks) take a track index; other sources ignore it.
   */
  getUrl(track?: number): Promise<string>;
  /** Frees resources (revokes object URLs). Safe to call multiple times. */
  release(): void;
}

export class LocalFileSource implements BookSource {
  readonly kind = 'local' as const;
  private url: string | null = null;
  private blobPromise: Promise<Blob> | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly mimeType: string,
    readonly size?: number,
  ) {}

  /** Looks up the stored file record for `id`; throws if missing. */
  static async open(id: string): Promise<LocalFileSource> {
    const rec = await db.files.get(id);
    if (!rec) throw new Error(`File ${id} not found in local storage`);
    return new LocalFileSource(rec.id, rec.name, rec.mimeType, rec.size);
  }

  getBlob(): Promise<Blob> {
    this.blobPromise ??= db.files.get(this.id).then((rec) => {
      if (!rec) throw new Error(`File ${this.id} not found in local storage`);
      return rec.blob;
    });
    return this.blobPromise;
  }

  async getUrl(): Promise<string> {
    if (this.url) return this.url;
    const blob = await this.getBlob();
    this.url ??= URL.createObjectURL(blob);
    return this.url;
  }

  release(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.blobPromise = null;
  }
}

/**
 * A file inside the user's debrid account, streamed through our server (`/api/debrid/file/...`), which keeps the
 * API key server-side and forwards Range requests. `id` is `kind/itemId/fileId`.
 */
export class DebridSource implements BookSource {
  readonly kind = 'debrid' as const;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly mimeType: string,
    readonly size?: number,
  ) {}

  /** Same-origin URL; the browser streams it with Range requests, so audio can seek without a full download. */
  async getUrl(): Promise<string> {
    return `/api/debrid/file/${this.id}`;
  }

  async getBlob(): Promise<Blob> {
    let res: Response;
    try {
      res = await fetch(await this.getUrl());
    } catch {
      throw new Error('Could not reach the server. Is it running?');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`Could not load file from TorBox (${body?.error ?? res.status}). The link may have expired.`);
    }
    return res.blob();
  }

  release(): void {}
}

/** A stream chosen from an add-on. The URL (or per-track URLs) point straight at the add-on's host. */
export class AddonSource implements BookSource {
  readonly kind = 'addon' as const;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly mimeType: string,
    private readonly stream: Stream,
  ) {}

  async getUrl(track?: number): Promise<string> {
    const url = this.stream.tracks ? this.stream.tracks[track ?? 0]?.url : this.stream.url;
    if (!url) throw new Error('This add-on stream has no URL');
    return url;
  }

  async getBlob(): Promise<Blob> {
    const url = await this.getUrl();
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      // shortcut: ebooks from external add-ons are fetched by the browser, so the host must send CORS headers;
      // upgrade path is an allow-listed server proxy (deliberately not built: no arbitrary-URL proxy).
      throw new Error('Could not download this file. The add-on host may not allow cross-origin downloads.');
    }
    if (!res.ok) throw new Error(`The add-on host answered ${res.status}`);
    return res.blob();
  }

  release(): void {}
}

/** Resolves a stored book to a BookSource. */
export async function openSource(book: Book): Promise<BookSource> {
  const ref = book.sourceRef;
  switch (ref.kind) {
    case 'local':
      return LocalFileSource.open(ref.id);
    case 'debrid':
      return new DebridSource(ref.id, book.title, mimeFor(book.title, book.format, ''));
    case 'addon':
      if (!ref.stream) throw new Error('Add-on book is missing its stream');
      return new AddonSource(ref.id, book.title, mimeFor(book.title, book.format, ''), ref.stream);
  }
}
