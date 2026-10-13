// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { addLocalBook, db, deleteBook, getProgress, saveProgress } from './db';
import { audioLocator, isLocator, pdfLocator, textLocator } from './locator';
import { LocalFileSource } from './source';

beforeEach(async () => {
  await Promise.all([db.books.clear(), db.files.clear(), db.progress.clear()]);
});

describe('db round-trip', () => {
  it('stores a book with its file and reads it back through LocalFileSource', async () => {
    const file = new Blob(['hello'], { type: 'text/plain' });
    const book = await addLocalBook(file, {
      title: 'Hello',
      author: 'Me',
      format: 'txt',
      fileName: 'hello.txt',
      mimeType: 'text/plain',
    });
    expect((await db.books.get(book.id))?.title).toBe('Hello');
    const source = await LocalFileSource.open(book.sourceRef.id);
    expect(source.kind).toBe('local');
    expect(source.size).toBe(5);
    expect(await (await source.getBlob()).text()).toBe('hello');
  });

  it('saves and restores progress locators', async () => {
    await saveProgress('b1', audioLocator(30, 120, 2));
    expect(await getProgress('b1')).toEqual({ type: 'audio', seconds: 30, chapter: 2, progress: 0.25 });
    await saveProgress('b1', pdfLocator(5, 10));
    expect((await getProgress('b1'))?.progress).toBe(0.5);
  });

  it('deleteBook removes file and progress', async () => {
    const book = await addLocalBook(new Blob(['x']), { title: 'X', author: '', format: 'txt', fileName: 'x.txt', mimeType: 'text/plain' });
    await saveProgress(book.id, textLocator(1, 2));
    await deleteBook(book.id);
    expect(await db.books.count()).toBe(0);
    expect(await db.files.count()).toBe(0);
    expect(await getProgress(book.id)).toBeUndefined();
  });
});

describe('locator', () => {
  it('validates shapes', () => {
    expect(isLocator(pdfLocator(2, 4))).toBe(true);
    expect(isLocator({ type: 'epub', cfi: 'x', progress: 2 })).toBe(false);
    expect(isLocator({ type: 'nope', progress: 0 })).toBe(false);
  });
});
