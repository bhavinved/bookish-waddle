import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db, getProgress, touchBook, type Book } from '../core/db';
import type { Locator } from '../core/locator';
import { openSource, type BookSource } from '../core/source';
import { EpubReader } from '../features/reader-epub/EpubReader';
import { PdfReader } from '../features/reader-pdf/PdfReader';
import { TextReader } from '../features/reader-text/TextReader';

interface Loaded {
  book: Book;
  source: BookSource;
  initial?: Locator;
}

export function ReaderRoute() {
  const { id = '' } = useParams();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let source: BookSource | null = null;
    setLoaded(null);
    setError(null);
    (async () => {
      const book = await db.books.get(id);
      if (!book) throw new Error('Book not found');
      source = await openSource(book.sourceRef);
      const initial = await getProgress(id);
      if (cancelled) return source.release();
      void touchBook(id);
      setLoaded({ book, source, initial });
    })().catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      source?.release();
    };
  }, [id]);

  if (error)
    return (
      <p style={{ padding: '1rem' }}>
        {error}. <Link to="/">Back to library</Link>
      </p>
    );
  if (!loaded) return <p style={{ padding: '1rem' }}>Loading…</p>;
  const { book, source, initial } = loaded;
  switch (book.format) {
    case 'epub':
      return <EpubReader key={id} book={book} source={source} initial={initial} />;
    case 'pdf':
      return <PdfReader key={id} book={book} source={source} initial={initial} />;
    case 'txt':
    case 'md':
      return <TextReader key={id} book={book} source={source} initial={initial} />;
    default:
      return <p style={{ padding: '1rem' }}>This book is an audiobook. <Link to={`/listen/${id}`}>Listen</Link></p>;
  }
}
