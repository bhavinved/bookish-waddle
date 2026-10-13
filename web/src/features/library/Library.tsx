import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useLive, useObjectUrl } from '../../app/hooks';
import { db, deleteBook, type Book } from '../../core/db';
import { importFiles } from './importFiles';
import { usePlayer } from '../player/PlayerProvider';
import { TorBoxView } from './TorBoxView';
import styles from './library.module.css';

function BookCard({ book, progress }: { book: Book; progress: number }) {
  const cover = useObjectUrl(book.coverBlob);
  const player = usePlayer();
  const href = book.format === 'audio' ? `/listen/${book.id}` : `/read/${book.id}`;

  async function remove() {
    if (!confirm(`Delete "${book.title}"?`)) return;
    if (player.book?.id === book.id) player.close();
    await deleteBook(book.id);
  }

  return (
    <li className={styles.card}>
      <Link to={href} className={styles.link}>
        <div className={styles.cover}>
          {cover ? <img src={cover} alt="" /> : <span className={styles.noCover}>{book.format.toUpperCase()}</span>}
        </div>
        <div className={styles.title}>{book.title}</div>
        <div className={styles.author}>{book.author || ' '}</div>
      </Link>
      <div className={styles.bar} role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${progress * 100}%` }} />
      </div>
      <button className={`btn-icon ${styles.del}`} onClick={remove} aria-label={`Delete ${book.title}`} title="Delete">
        ✕
      </button>
    </li>
  );
}

export function Library() {
  const items = useLive(async () => {
    const books = await db.books.orderBy('lastOpenedAt').reverse().toArray();
    const progress = await db.progress.toArray();
    const map = new Map(progress.map((p) => [p.bookId, p.locator.progress]));
    return books.map((book) => ({ book, progress: map.get(book.id) ?? 0 }));
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState<'mine' | 'torbox'>('mine');

  async function handle(files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    setMessage('');
    try {
      const r = await importFiles(files);
      setMessage(
        `Imported ${r.imported} file${r.imported === 1 ? '' : 's'}.` +
          (r.skipped.length ? ` Unsupported: ${r.skipped.join(', ')}` : ''),
      );
    } catch (e) {
      setMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void handle(Array.from(e.dataTransfer.files));
  }

  return (
    <div
      className={`${styles.page} ${dragging ? styles.dragging : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className={styles.toolbar}>
        <h1>Library</h1>
        <div className={styles.tabs}>
          <button className={`btn ${view === 'mine' ? 'btn-primary' : ''}`} onClick={() => setView('mine')}>
            My books
          </button>
          <button className={`btn ${view === 'torbox' ? 'btn-primary' : ''}`} onClick={() => setView('torbox')}>
            TorBox
          </button>
        </div>
        <button className="btn btn-primary" onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Importing…' : 'Add books'}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".epub,.pdf,.txt,.md,.markdown,.mp3,.m4b,.m4a,.aac,.ogg,.opus,.flac,.wav"
          onChange={(e) => {
            void handle(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {view === 'torbox' && <TorBoxView />}
      {view === 'mine' && message && <p className={styles.message}>{message}</p>}
      {view === 'mine' && items && items.length === 0 && (
        <p className={styles.empty}>Drop EPUB, PDF, TXT, MD, MP3 or M4B files here, or use “Add books”.</p>
      )}
      {view === 'mine' && (
        <ul className={styles.grid}>
          {items?.map(({ book, progress }) => (
            <BookCard key={book.id} book={book} progress={progress} />
          ))}
        </ul>
      )}
    </div>
  );
}
