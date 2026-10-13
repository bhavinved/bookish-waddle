import type { Book } from '../core/db';
import type { Locator } from '../core/locator';
import type { BookSource } from '../core/source';

/** Props every reader receives. Readers read bytes only through `source` and report positions as Locators. */
export interface ReaderProps {
  book: Book;
  source: BookSource;
  initial?: Locator;
}
