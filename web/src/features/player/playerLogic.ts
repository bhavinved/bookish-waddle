import type { Chapter } from '../../core/db';

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
