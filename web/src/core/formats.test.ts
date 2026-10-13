import { describe, expect, it } from 'vitest';
import { detectFormat, normalizeChapters, titleFromFilename } from './formats';

describe('detectFormat', () => {
  it.each([
    ['book.epub', '', 'epub'],
    ['Book.PDF', '', 'pdf'],
    ['notes.txt', 'text/plain', 'txt'],
    ['readme.md', '', 'md'],
    ['readme.markdown', '', 'md'],
    ['a.mp3', '', 'audio'],
    ['a.m4b', 'audio/mp4', 'audio'],
    ['noext', 'application/epub+zip', 'epub'],
    ['noext', 'audio/ogg', 'audio'],
    ['file.md', 'text/plain', 'md'],
  ])('%s (%s) -> %s', (name, mime, expected) => {
    expect(detectFormat(name, mime)).toBe(expected);
  });

  it('returns null for unsupported files', () => {
    expect(detectFormat('photo.jpg', 'image/jpeg')).toBeNull();
    expect(detectFormat('x', '')).toBeNull();
  });
});

describe('helpers', () => {
  it('titleFromFilename strips extension and underscores', () => {
    expect(titleFromFilename('My_Great_Book.epub')).toBe('My Great Book');
  });

  it('normalizeChapters converts to seconds and sorts', () => {
    expect(normalizeChapters([{ title: 'B', start: 60000 }, { title: '', start: 0, timeScale: 1000 }])).toEqual([
      { title: 'Chapter 2', start: 0 },
      { title: 'B', start: 60 },
    ]);
    expect(normalizeChapters([])).toBeUndefined();
  });
});
