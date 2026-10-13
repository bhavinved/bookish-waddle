import type { Chapter } from '../../core/db';
import type { Locator } from '../../core/locator';

export const MIN_RATE = 0.75;
export const MAX_RATE = 3;
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(rate * 100) / 100));
}

/** MP3 / chapterless files get a single synthetic chapter. */
export function singleChapter(title: string): Chapter[] {
  return [{ title, start: 0 }];
}

/** Index of the chapter containing `seconds` (chapters sorted by start). */
export function chapterIndexAt(chapters: Chapter[], seconds: number): number {
  let idx = 0;
  for (let i = 0; i < chapters.length; i++) {
    if ((chapters[i]?.start ?? 0) <= seconds + 0.001) idx = i;
    else break;
  }
  return idx;
}

/** Multi-track books: the track to auto-advance to after `index` ends, or null at the end of the book. */
export function nextTrack(count: number, index: number): number | null {
  return index + 1 < count ? index + 1 : null;
}

/** Whole-book progress (0..1) for a multi-track book; falls back to track count when durations are unknown. */
export function trackedProgress(chapters: Chapter[], index: number, seconds: number): number {
  const total = chapters.reduce((sum, c) => sum + (c.duration ?? 0), 0);
  if (total > 0) {
    const before = chapters.slice(0, index).reduce((sum, c) => sum + (c.duration ?? 0), 0);
    return Math.min(1, (before + seconds) / total);
  }
  return chapters.length > 0 ? Math.min(1, index / chapters.length) : 0;
}

/** Where to resume: for multi-track books `chapter` picks the track and `seconds` is inside it. */
export function resumePoint(
  saved: Locator | undefined,
  multiTrack: boolean,
  trackCount: number,
): { track: number; seconds: number } {
  if (saved?.type !== 'audio') return { track: 0, seconds: 0 };
  if (!multiTrack) return { track: 0, seconds: saved.seconds };
  const track = Math.min(Math.max(0, saved.chapter ?? 0), Math.max(0, trackCount - 1));
  return { track, seconds: saved.seconds };
}
