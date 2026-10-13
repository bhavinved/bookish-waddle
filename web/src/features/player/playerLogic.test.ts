import { describe, expect, it } from 'vitest';
import { chapterIndexAt, clampRate, nextTrack, resumePoint, trackedProgress } from './playerLogic';

const tracks = [
  { title: 'a', start: 0, duration: 100 },
  { title: 'b', start: 100, duration: 100 },
  { title: 'c', start: 200, duration: 200 },
];

describe('multi-track logic', () => {
  it('advances to the next track and stops at the end', () => {
    expect(nextTrack(3, 0)).toBe(1);
    expect(nextTrack(3, 1)).toBe(2);
    expect(nextTrack(3, 2)).toBeNull();
  });

  it('computes whole-book progress from durations, or track count as fallback', () => {
    expect(trackedProgress(tracks, 1, 50)).toBeCloseTo(150 / 400);
    expect(trackedProgress(tracks, 2, 200)).toBe(1);
    expect(trackedProgress([{ title: 'a', start: 0 }, { title: 'b', start: 0 }], 1, 10)).toBe(0.5);
  });

  it('resumes at the saved track and seconds, clamping a stale track index', () => {
    const saved = { type: 'audio', seconds: 42, chapter: 1, progress: 0.2 } as const;
    expect(resumePoint(saved, true, 3)).toEqual({ track: 1, seconds: 42 });
    expect(resumePoint({ ...saved, chapter: 9 }, true, 3)).toEqual({ track: 2, seconds: 42 });
    expect(resumePoint(undefined, true, 3)).toEqual({ track: 0, seconds: 0 });
    expect(resumePoint({ type: 'pdf', page: 2, progress: 0.1 }, true, 3)).toEqual({ track: 0, seconds: 0 });
  });

  it('single-file books ignore the chapter and resume at absolute seconds', () => {
    expect(resumePoint({ type: 'audio', seconds: 900, chapter: 4, progress: 0.5 }, false, 10)).toEqual({ track: 0, seconds: 900 });
  });
});

describe('single-file chapters (M4B)', () => {
  it('finds the chapter containing a time', () => {
    expect(chapterIndexAt(tracks, 0)).toBe(0);
    expect(chapterIndexAt(tracks, 150)).toBe(1);
    expect(chapterIndexAt(tracks, 999)).toBe(2);
  });
  it('clamps speed to 0.75-3x', () => {
    expect(clampRate(0.1)).toBe(0.75);
    expect(clampRate(9)).toBe(3);
    expect(clampRate(1.5)).toBe(1.5);
  });
});
