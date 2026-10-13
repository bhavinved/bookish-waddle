import { useEffect, useState } from 'react';
import { useLive } from '../../app/hooks';
import { addRemoteBook, db } from '../../core/db';
import { extractMetadata, mimeFor, titleFromFilename, type BookMetadata } from '../../core/formats';
import { DebridSource } from '../../core/source';
import styles from './library.module.css';

interface DebridItem {
  kind: 'torrent' | 'webdl' | 'usenet';
  itemId: number;
  fileId: number;
  name: string;
  size: number;
  format: 'epub' | 'pdf' | 'txt' | 'md' | 'audio';
}

type State = { s: 'loading' } | { s: 'unconfigured' } | { s: 'error'; msg: string } | { s: 'ok'; items: DebridItem[] };

const refId = (i: DebridItem) => `${i.kind}/${i.itemId}/${i.fileId}`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function load(): Promise<State> {
  try {
    const status = await fetch('/api/debrid/status');
    if (!status.ok) throw new Error(`server returned ${status.status}`);
    if (!((await status.json()) as { configured: boolean }).configured) return { s: 'unconfigured' };
    const res = await fetch('/api/debrid/items');
    const body = (await res.json()) as DebridItem[] | { error?: string };
    if (!res.ok || !Array.isArray(body)) {
      return { s: 'error', msg: `TorBox request failed (${(!Array.isArray(body) && body.error) || res.status})` };
    }
    return { s: 'ok', items: body };
  } catch {
    return { s: 'error', msg: 'Could not reach the server. Is it running? (npm run dev starts both)' };
  }
}

export function TorBoxView() {
  const [state, setState] = useState<State>({ s: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const addedIds = useLive(
    async () =>
      new Set((await db.books.toArray()).filter((b) => b.sourceRef.kind === 'debrid').map((b) => b.sourceRef.id)),
    [],
  );

  useEffect(() => {
    void load().then(setState);
  }, []);

  async function add(item: DebridItem) {
    const id = refId(item);
    setBusy(id);
    setMessage('');
    try {
      let meta: BookMetadata = { title: titleFromFilename(item.name), author: '' };
      // shortcut: audio and txt/md use the filename as title; reading tags would need a ranged fetch of the file head.
      if (item.format === 'epub' || item.format === 'pdf') {
        const blob = await new DebridSource(id, item.name, mimeFor(item.name, item.format, ''), item.size).getBlob();
        meta = await extractMetadata(blob, item.name, item.format);
      }
      await addRemoteBook({ kind: 'debrid', id }, { ...meta, format: item.format });
    } catch (e) {
      setMessage(`Could not add ${item.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  if (state.s === 'loading') return <p className={styles.message}>Loading TorBox…</p>;
  if (state.s === 'unconfigured') {
    return <p className={styles.message}>TorBox is not configured. Add TORBOX_API_KEY to server/.env and restart.</p>;
  }
  if (state.s === 'error') return <p className={styles.message}>{state.msg}</p>;
  if (state.items.length === 0) {
    return <p className={styles.empty}>No supported book or audio files found in your TorBox account.</p>;
  }
  return (
    <>
      {message && <p className={styles.message}>{message}</p>}
      <ul className={styles.rows}>
        {state.items.map((it) => {
          const id = refId(it);
          const isAdded = addedIds?.has(id);
          return (
            <li key={id} className={styles.row}>
              <span className={styles.rowName}>{it.name}</span>
              <span className={styles.author}>
                {it.format.toUpperCase()} · {mb(it.size)}
              </span>
              <button className="btn" disabled={isAdded || busy !== null} onClick={() => void add(it)}>
                {isAdded ? 'Added' : busy === id ? 'Adding…' : 'Add'}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
