import Dexie, { type EntityTable } from 'dexie';
import type { Manifest, Stream } from './addon';
import type { Locator } from './locator';

export type BookFormat = 'epub' | 'pdf' | 'txt' | 'md' | 'audio';

export interface Chapter {
  title: string;
  /** Start time in seconds (audio chapters). For multi-track books: offset of the track in the whole book. */
  start: number;
  /** Multi-track books only: length of this track in seconds, when the add-on said. */
  duration?: number;
}

export interface SourceRef {
  kind: 'local' | 'debrid' | 'addon';
  id: string;
  /** Add-on books: the stream the user picked, stored as-is so nothing has to be re-resolved. */
  stream?: Stream;
}

export interface InstalledAddon {
  baseUrl: string;
  manifest: Manifest;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  coverBlob?: Blob;
  /** Remote cover (add-on poster); used when there is no coverBlob. */
  coverUrl?: string;
  sourceRef: SourceRef;
  addedAt: number;
  lastOpenedAt: number;
  /** Audio only: total duration in seconds and chapter list (M4B), when known. */
  durationSec?: number;
  chapters?: Chapter[];
  /**
   * Audio only: each chapter is its own file (add-on `tracks`). The audio Locator is then
   * { chapter: track index, seconds: position inside that track }; for single-file books `seconds` is file-absolute.
   */
  multiTrack?: boolean;
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
  addons!: EntityTable<InstalledAddon, 'baseUrl'>;

  constructor(name = 'bookish-waddle') {
    super(name);
    this.version(1).stores({
      books: 'id, addedAt, lastOpenedAt, format',
      files: 'id',
      progress: 'bookId, updatedAt',
    });
    // v2: user-installed add-ons (built-ins are not stored).
    this.version(2).stores({ addons: 'baseUrl' });
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

/** Adds a book whose bytes stay remote (debrid); nothing is copied into IndexedDB. */
export async function addRemoteBook(
  sourceRef: SourceRef,
  meta: Omit<Book, 'id' | 'sourceRef' | 'addedAt' | 'lastOpenedAt'>,
): Promise<Book> {
  const now = Date.now();
  const book: Book = { ...meta, id: newId(), sourceRef, addedAt: now, lastOpenedAt: now };
  await db.books.add(book);
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
