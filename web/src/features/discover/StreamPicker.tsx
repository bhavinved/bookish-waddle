import { useEffect, useState } from 'react';
import { useLive } from '../../app/hooks';
import { bookFromStream, getStreams, type Meta, type Stream } from '../../core/addon';
import { addRemoteBook, db } from '../../core/db';
import styles from '../library/library.module.css';
import { resolveViaTorBox, torBoxConfigured } from './torbox';
import type { AddonEntry } from './useAddons';

type RowState = { busy?: boolean; msg?: string; notCached?: boolean; done?: boolean };

export function StreamPicker({ addon, meta, onClose }: { addon: AddonEntry; meta: Meta; onClose: () => void }) {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [torbox, setTorbox] = useState(false);
  const addedIds = useLive(
    async () => new Set((await db.books.toArray()).map((b) => `${b.sourceRef.kind}:${b.sourceRef.id}`)),
    [],
  );

  useEffect(() => {
    getStreams(addon.baseUrl, meta)
      .then(setStreams)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [addon.baseUrl, meta]);

  const hasHash = streams?.some((s) => s.infoHash) ?? false;
  useEffect(() => {
    if (hasHash) void torBoxConfigured().then(setTorbox);
  }, [hasHash]);

  const setRow = (i: number, r: RowState) => setRows((prev) => ({ ...prev, [i]: r }));

  async function add(i: number, stream: Stream) {
    try {
      const { sourceRef, fields } = bookFromStream(addon.manifest!.id, meta, stream);
      await addRemoteBook(sourceRef, fields);
    } catch (e) {
      setRow(i, { msg: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Torrent streams: TorBox resolves a cached torrent to a file, which is added as a normal debrid book. */
  async function addViaTorBox(i: number, stream: Stream, send = false) {
    setRow(i, { busy: true });
    try {
      const r = await resolveViaTorBox(stream.infoHash!, stream.fileIdx, send);
      if ('status' in r) {
        setRow(
          i,
          r.status === 'queued'
            ? { msg: 'Sent to TorBox. It will appear in the TorBox tab when it finishes.', done: true }
            : { notCached: true, msg: 'Not cached on TorBox.' },
        );
        return;
      }
      await addRemoteBook(
        { kind: 'debrid', id: `${r.kind}/${r.itemId}/${r.fileId}` },
        { title: meta.name, author: meta.author ?? '', coverUrl: meta.poster, format: r.format },
      );
      setRow(i, { done: true });
    } catch (e) {
      setRow(i, { msg: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <strong>{meta.name}</strong>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      {meta.description && <p className={styles.author}>{meta.description.slice(0, 400)}</p>}
      {error && <p className={styles.message}>{error}</p>}
      {streams === null && !error && <p className={styles.message}>Loading streams…</p>}
      {streams?.length === 0 && <p className={styles.message}>This add-on has no playable stream for this title.</p>}
      <ul className={styles.rows}>
        {streams?.map((s, i) => {
          const row = rows[i] ?? {};
          const added = row.done || addedIds?.has(`addon:${addon.manifest?.id}/${meta.id}`);
          return (
            <li key={i} className={styles.row}>
              <span className={styles.rowName}>
                {s.name}
                {row.msg && <span className={styles.author}> {row.msg}</span>}
              </span>
              {!s.externalUrl && (
                <span className={styles.author}>
                  {s.infoHash ? 'TORRENT' : s.format?.toUpperCase()}
                  {s.tracks ? ` · ${s.tracks.length} tracks` : ''}
                </span>
              )}
              {s.externalUrl ? (
                <a className="btn" href={s.externalUrl} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              ) : s.infoHash ? (
                row.notCached ? (
                  <button className="btn" disabled={row.busy} onClick={() => void addViaTorBox(i, s, true)}>
                    Send to TorBox
                  </button>
                ) : (
                  <button
                    className="btn"
                    disabled={!torbox || row.busy || row.done}
                    title={torbox ? undefined : 'Add TORBOX_API_KEY to server/.env to use TorBox'}
                    onClick={() => void addViaTorBox(i, s)}
                  >
                    {row.busy ? 'Checking…' : row.done ? 'Added' : 'Add via TorBox'}
                  </button>
                )
              ) : (
                <button className="btn" disabled={added} onClick={() => void add(i, s)}>
                  {added ? 'Added' : 'Add'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
