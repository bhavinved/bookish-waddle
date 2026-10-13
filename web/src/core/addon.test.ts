import { describe, expect, it } from 'vitest';
import { bookFromStream, normalizeBaseUrl, parseManifest, parseMetas, parseStreams } from './addon';

describe('parseManifest', () => {
  it('accepts a valid manifest and drops malformed catalogs', () => {
    const m = parseManifest({
      id: 'x',
      name: 'X',
      version: '1.2.3',
      types: ['ebook', 'bogus'],
      catalogs: [
        { type: 'ebook', id: 'search', name: 'Search', search: true },
        { type: 'ebook', id: 'bad' },
        'junk',
      ],
    });
    expect(m).toMatchObject({ id: 'x', version: '1.2.3', types: ['ebook'], description: '' });
    expect(m.catalogs).toEqual([{ type: 'ebook', id: 'search', name: 'Search', search: true }]);
  });

  it.each([null, 'str', [], {}, { id: 'x' }, { id: '', name: 'n' }])('rejects %j', (bad) => {
    expect(() => parseManifest(bad)).toThrow();
  });
});

describe('parseMetas / parseStreams', () => {
  it('skips bad entries and non-https posters', () => {
    const metas = parseMetas({
      metas: [
        { id: '1', type: 'ebook', name: 'Good', poster: 'https://x/p.jpg' },
        { id: '2', type: 'ebook', name: 'HttpPoster', poster: 'http://x/p.jpg' },
        { id: '3', type: 'movie', name: 'WrongType' },
        { type: 'ebook', name: 'NoId' },
        42,
      ],
    });
    expect(metas.map((m) => [m.id, m.poster])).toEqual([
      ['1', 'https://x/p.jpg'],
      ['2', undefined],
    ]);
    expect(parseMetas({ nope: 1 })).toEqual([]);
  });

  it('validates streams: https only, tracks filtered, relative paths only for built-ins', () => {
    const body = {
      streams: [
        { name: 'ok', format: 'epub', url: 'https://x/b.epub' },
        { name: 'http', format: 'epub', url: 'http://x/b.epub' },
        { name: 'rel', format: 'epub', url: '/api/addons/gutenberg/file/1' },
        { name: 'evil', format: 'epub', url: 'javascript:alert(1)' },
        { name: 'exe', format: 'exe', url: 'https://x/a' },
        { name: 'audio', format: 'audio', tracks: [{ title: 'a', url: 'https://x/1.mp3', duration: 5 }, { title: 'b', url: 'ftp://x' }] },
      ],
    };
    expect(parseStreams(body).map((s) => s.name)).toEqual(['ok', 'audio']);
    expect(parseStreams(body)[1]?.tracks).toEqual([{ title: 'a', url: 'https://x/1.mp3', duration: 5 }]);
    expect(parseStreams(body, true).map((s) => s.name)).toEqual(['ok', 'rel', 'audio']);
  });
});

describe('parseStreams: externalUrl and infoHash', () => {
  const HASH = 'a'.repeat(40);

  it('accepts external links (https only) without a format', () => {
    const streams = parseStreams({
      streams: [
        { name: 'Borrow', externalUrl: 'https://openlibrary.org/works/OL1W' },
        { name: 'bad', externalUrl: 'javascript:alert(1)' },
        { name: 'http', externalUrl: 'http://x.example' },
      ],
    });
    expect(streams).toEqual([{ name: 'Borrow', externalUrl: 'https://openlibrary.org/works/OL1W' }]);
  });

  it('accepts torrent streams by 40-hex infoHash with an optional non-negative fileIdx', () => {
    const streams = parseStreams({
      streams: [
        { name: 'ok', format: 'epub', infoHash: HASH, fileIdx: 2 },
        { name: 'upper', infoHash: HASH.toUpperCase() },
        { name: 'short', infoHash: 'abc' },
        { name: 'nonhex', infoHash: 'z'.repeat(40) },
        { name: 'neg', infoHash: HASH, fileIdx: -1 },
      ],
    });
    expect(streams.map((s) => [s.name, s.infoHash && 'h', s.fileIdx])).toEqual([
      ['ok', 'h', 2],
      ['upper', 'h', undefined],
      ['neg', 'h', undefined],
    ]);
  });

  it('refuses to add a stream without a format directly', () => {
    expect(() => bookFromStream('x', { id: '1', type: 'ebook', name: 'B' }, { name: 'ext', externalUrl: 'https://x.example' })).toThrow();
  });
});

describe('normalizeBaseUrl', () => {
  it('strips manifest.json, trailing slash, query', () => {
    expect(normalizeBaseUrl(' https://a.com/addon/manifest.json?x=1 ')).toBe('https://a.com/addon');
    expect(normalizeBaseUrl('https://a.com/')).toBe('https://a.com');
  });
  it('requires https', () => {
    expect(() => normalizeBaseUrl('http://a.com')).toThrow();
    expect(() => normalizeBaseUrl('not a url')).toThrow();
  });
});

describe('bookFromStream', () => {
  it('turns tracks into chapters with cumulative offsets', () => {
    const { sourceRef, fields } = bookFromStream(
      'lv',
      { id: '253', type: 'audiobook', name: 'P&P', author: 'Austen', poster: 'https://x/c.jpg' },
      { name: 'MP3', format: 'audio', tracks: [{ title: 'one', url: 'https://x/1', duration: 100 }, { title: 'two', url: 'https://x/2', duration: 50 }] },
    );
    expect(sourceRef.id).toBe('lv/253');
    expect(fields).toMatchObject({ format: 'audio', multiTrack: true, durationSec: 150, coverUrl: 'https://x/c.jpg' });
    expect(fields.chapters).toEqual([
      { title: 'one', start: 0, duration: 100 },
      { title: 'two', start: 100, duration: 50 },
    ]);
  });

  it('single-file streams keep their format', () => {
    const { fields } = bookFromStream('g', { id: '1', type: 'ebook', name: 'B' }, { name: 'e', format: 'epub', url: 'https://x/b' });
    expect(fields.format).toBe('epub');
    expect(fields.multiTrack).toBeUndefined();
  });
});
