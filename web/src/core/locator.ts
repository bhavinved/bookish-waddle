/**
 * A Locator is a position inside a book. Progress and (later) text<->audio sync all use it.
 * Every variant carries `progress` (0..1) so the library can show a progress bar without knowing the format.
 */
export type Locator =
  | { type: 'epub'; cfi: string; progress: number }
  | { type: 'pdf'; page: number; progress: number } // page is 1-based
  | { type: 'text'; offset: number; progress: number } // character offset into the decoded text
  | { type: 'audio'; seconds: number; chapter?: number; progress: number };

export type LocatorType = Locator['type'];

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function epubLocator(cfi: string, progress: number): Locator {
  return { type: 'epub', cfi, progress: clamp01(progress) };
}

/** `page` is 1-based; progress is page/numPages. */
export function pdfLocator(page: number, numPages: number): Locator {
  const p = Math.max(1, Math.floor(page));
  return { type: 'pdf', page: p, progress: numPages > 0 ? clamp01(p / numPages) : 0 };
}

export function textLocator(offset: number, totalLength: number): Locator {
  const o = Math.max(0, Math.floor(offset));
  return { type: 'text', offset: o, progress: totalLength > 0 ? clamp01(o / totalLength) : 0 };
}

export function audioLocator(seconds: number, duration: number, chapter?: number): Locator {
  const s = Math.max(0, seconds);
  const base = { type: 'audio' as const, seconds: s, progress: duration > 0 ? clamp01(s / duration) : 0 };
  return chapter === undefined ? base : { ...base, chapter };
}

export function isLocator(value: unknown): value is Locator {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.progress !== 'number' || v.progress < 0 || v.progress > 1) return false;
  switch (v.type) {
    case 'epub':
      return typeof v.cfi === 'string';
    case 'pdf':
      return typeof v.page === 'number' && v.page >= 1;
    case 'text':
      return typeof v.offset === 'number' && v.offset >= 0;
    case 'audio':
      return (
        typeof v.seconds === 'number' && v.seconds >= 0 && (v.chapter === undefined || typeof v.chapter === 'number')
      );
    default:
      return false;
  }
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
