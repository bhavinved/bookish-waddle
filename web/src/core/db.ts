import Dexie, { type EntityTable } from 'dexie';
import type { Locator } from './locator';

export type BookFormat = 'epub' | 'pdf' | 'txt' | 'md' | 'audio';

export interface Chapter {
  title: string;
  /** Start time in seconds (audio chapters). */
  start: number;
}

export interface SourceRef {
  kind: 'local' | 'debrid' | 'addon';
  id: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  coverBlob?: Blob;
  sourceRef: SourceRef;
  addedAt: number;
  lastOpenedAt: number;
  /** Audio only: total duration in seconds and chapter list (M4B), when known. */
  durationSec?: number;
  chapters?: Chapter[];
}

export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

export interface ProgressRecord {
  bookId: string;
  locator: Locator;
  updatedAt: number;
}

export class BookishDB extends Dexie {
  books!: EntityTable<Book, 'id'>;
  files!: EntityTable<StoredFile, 'id'>;
  progress!: EntityTable<ProgressRecord, 'bookId'>;

  constructor(name = 'bookish-waddle') {
    super(name);
    this.version(1).stores({
      books: 'id, addedAt, lastOpenedAt, format',
      files: 'id',
      progress: 'bookId, updatedAt',
    });
  }
}

export const db = new BookishDB();

export function newId(): string {
  return crypto.randomUUID();
}

export async function saveProgress(bookId: string, locator: Locator): Promise<void> {
  await db.progress.put({ bookId, locator, updatedAt: Date.now() });
}

export async function getProgress(bookId: string): Promise<Locator | undefined> {
  return (await db.progress.get(bookId))?.locator;
}

export async function touchBook(bookId: string): Promise<void> {
  await db.books.update(bookId, { lastOpenedAt: Date.now() });
}

export type NewLocalBook = Omit<Book, 'id' | 'sourceRef' | 'addedAt' | 'lastOpenedAt'> & {
  fileName: string;
  mimeType: string;
};

/** Stores a local file and its Book row in one transaction. */
export async function addLocalBook(file: Blob, meta: NewLocalBook): Promise<Book> {
  const { fileName, mimeType, ...bookFields } = meta;
  const fileId = newId();
  const now = Date.now();
  const book: Book = {
    ...bookFields,
    id: newId(),
    sourceRef: { kind: 'local', id: fileId },
    addedAt: now,
    lastOpenedAt: now,
  };
  await db.transaction('rw', db.books, db.files, async () => {
    await db.files.add({ id: fileId, name: fileName, mimeType, size: file.size, blob: file });
    await db.books.add(book);
  });
  return book;
}

export async function deleteBook(bookId: string): Promise<void> {
  await db.transaction('rw', db.books, db.files, db.progress, async () => {
    const book = await db.books.get(bookId);
    if (!book) return;
    if (book.sourceRef.kind === 'local') await db.files.delete(book.sourceRef.id);
    await db.progress.delete(bookId);
    await db.books.delete(bookId);
  });
}
