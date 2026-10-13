import ePub from 'epubjs';
import type { BookFormat, Chapter } from './db';

const EXT_FORMAT: Record<string, BookFormat> = {
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

const MIME_FORMAT: Record<string, BookFormat> = {
  'application/epub+zip': 'epub',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
};

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** Detects the book format from file name and/or MIME type. The extension wins over generic MIME types. */
export function detectFormat(name: string, mimeType = ''): BookFormat | null {
  const byExt = EXT_FORMAT[extensionOf(name)];
  if (byExt) return byExt;
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (MIME_FORMAT[mime]) return MIME_FORMAT[mime];
  if (mime.startsWith('audio/') || mime === 'application/ogg') return 'audio';
  return null;
}

/** MIME type to store for a file, falling back to a sensible default per format. */
export function mimeFor(name: string, format: BookFormat, reported: string): string {
  if (reported) return reported;
  const ext = extensionOf(name);
  switch (format) {
    case 'epub':
      return 'application/epub+zip';
    case 'pdf':
      return 'application/pdf';
    case 'md':
      return 'text/markdown';
    case 'txt':
      return 'text/plain';
    case 'audio':
      return ext === 'm4b' || ext === 'm4a' ? 'audio/mp4' : ext === 'mp3' ? 'audio/mpeg' : 'audio/*';
  }
}

export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

export interface BookMetadata {
  title: string;
  author: string;
  coverBlob?: Blob;
  durationSec?: number;
  chapters?: Chapter[];
}

// ---------- EPUB ----------

async function epubMetadata(file: Blob, fallbackTitle: string): Promise<BookMetadata> {
  const book = ePub(await file.arrayBuffer());
  try {
    const md = await book.loaded.metadata;
    let coverBlob: Blob | undefined;
    const coverUrl = await book.coverUrl();
    if (coverUrl) coverBlob = await (await fetch(coverUrl)).blob();
    return { title: md.title?.trim() || fallbackTitle, author: md.creator?.trim() || '', coverBlob };
  } finally {
    book.destroy();
  }
}

// ---------- PDF ----------

async function pdfMetadata(file: Blob, fallbackTitle: string): Promise<BookMetadata> {
  const { loadPdf } = await import('./pdfjs');
  const pdf = await loadPdf(file);
  try {
    const { info } = await pdf.getMetadata();
    const rec = info as { Title?: unknown; Author?: unknown };
    const title = typeof rec.Title === 'string' && rec.Title.trim() ? rec.Title.trim() : fallbackTitle;
    const author = typeof rec.Author === 'string' ? rec.Author.trim() : '';

    let coverBlob: Blob | undefined;
    try {
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 360 / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      coverBlob = await new Promise<Blob | undefined>((res) =>
        canvas.toBlob((b) => res(b ?? undefined), 'image/jpeg', 0.8),
      );
    } catch {
      // cover is best-effort
    }
    return { title, author, coverBlob };
  } finally {
    void pdf.loadingTask.destroy();
  }
}

// ---------- Audio ----------

/** Converts music-metadata chapters to seconds. QuickTime chapters carry start/timeScale; fall back to ms. */
export function normalizeChapters(
  raw: { title: string; start: number; timeScale?: number }[] | undefined,
): Chapter[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw
    .map((c, i) => ({
      title: c.title?.trim() || `Chapter ${i + 1}`,
      start: c.start / (c.timeScale || 1000),
    }))
    .sort((a, b) => a.start - b.start);
}

async function audioMetadata(file: Blob, fallbackTitle: string): Promise<BookMetadata> {
  const { parseBlob, selectCover } = await import('music-metadata');
  const meta = await parseBlob(file, { duration: true, includeChapters: true });
  const pic = selectCover(meta.common.picture);
  return {
    title: meta.common.album?.trim() || meta.common.title?.trim() || fallbackTitle,
    author: meta.common.artist?.trim() || meta.common.albumartist?.trim() || '',
    coverBlob: pic ? new Blob([pic.data as BlobPart], { type: pic.format }) : undefined,
    durationSec: meta.format.duration,
    chapters: normalizeChapters(meta.format.chapters),
  };
}

/** Extracts title/author/cover (and duration/chapters for audio). Never throws: falls back to the filename. */
export async function extractMetadata(file: Blob, name: string, format: BookFormat): Promise<BookMetadata> {
  const fallbackTitle = titleFromFilename(name);
  try {
    switch (format) {
      case 'epub':
        return await epubMetadata(file, fallbackTitle);
      case 'pdf':
        return await pdfMetadata(file, fallbackTitle);
      case 'audio':
        return await audioMetadata(file, fallbackTitle);
      default:
        return { title: fallbackTitle, author: '' };
    }
  } catch (err) {
    console.warn(`Metadata extraction failed for ${name}`, err);
    return { title: fallbackTitle, author: '' };
  }
}
