import { useEffect, useState, type FormEvent } from 'react';
import { useLive } from '../../app/hooks';
import {
  bookFromStream,
  fetchManifest,
  getStreams,
  normalizeBaseUrl,
  searchCatalog,
  type Meta,
  type Stream,
} from '../../core/addon';
import { addRemoteBook, db } from '../../core/db';
import styles from '../library/library.module.css';
import { useAddons, type AddonEntry } from './useAddons';

interface Group {
  addon: AddonEntry;
  metas: Meta[];
  error?: string;
}

function ResultCard({ meta, onPick }: { meta: Meta; onPick: () => void }) {
  return (
    <li className={styles.card}>
      <button className={styles.pick} onClick={onPick}>
        <div className={styles.cover}>
          {meta.poster ? <img src={meta.poster} alt="" loading="lazy" /> : <span className={styles.noCover}>{meta.type}</span>}
        </div>
        <div className={styles.title}>{meta.name}</div>
        <div className={styles.author}>{meta.author || ' '}</div>
      </button>
    </li>
  );
}

function StreamPicker({ addon, meta, onClose }: { addon: AddonEntry; meta: Meta; onClose: () => void }) {
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [error, setError] = useState('');
  const added = useLive(async () => {
    const prefix = `${addon.manifest?.id}/${meta.id}`;
    return (await db.books.toArray()).some((b) => b.sourceRef.kind === 'addon' && b.sourceRef.id === prefix);
  }, [meta.id]);

  useEffect(() => {
    getStreams(addon.baseUrl, meta)
      .then(setStreams)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [addon.baseUrl, meta]);

  async function add(stream: Stream) {
    const { sourceRef, fields } = bookFromStream(addon.manifest!.id, meta, stream);
    await addRemoteBook(sourceRef, fields);
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
        {streams?.map((s, i) => (
          <li key={i} className={styles.row}>
            <span className={styles.rowName}>{s.name}</span>
            <span className={styles.author}>
              {s.format.toUpperCase()}
              {s.tracks ? ` · ${s.tracks.length} tracks` : ''}
            </span>
            <button className="btn" disabled={added} onClick={() => void add(s)}>
              {added ? 'Added' : 'Add'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddonsPanel({ addons }: { addons: AddonEntry[] }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function install(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const baseUrl = normalizeBaseUrl(url);
      const manifest = await fetchManifest(baseUrl);
      if (addons.some((a) => a.manifest?.id === manifest.id || a.baseUrl === baseUrl)) {
        throw new Error('An add-on with this id is already installed');
      }
      await db.addons.put({ baseUrl, manifest });
      setUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={styles.addons}>
      <summary>Add-ons ({addons.length})</summary>
      <ul className={styles.rows}>
        {addons.map((a) => (
          <li key={a.baseUrl} className={styles.row}>
            <span className={styles.rowName}>
              {a.manifest?.name ?? a.baseUrl} {a.manifest && <span className={styles.author}>v{a.manifest.version}</span>}
              {a.error && <span className={styles.author}> {a.error}</span>}
            </span>
            {a.builtin ? (
              <span className={styles.author}>built-in</span>
            ) : (
              <button className="btn" onClick={() => void db.addons.delete(a.baseUrl)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <form className={styles.toolbar} onSubmit={(e) => void install(e)}>
        <input
          className={styles.search}
          type="url"
          required
          placeholder="https://example.com/my-addon"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Add-on URL"
        />
        <button className="btn" disabled={busy}>
          {busy ? 'Installing…' : 'Install add-on'}
        </button>
      </form>
      {error && <p className={styles.message}>{error}</p>}
    </details>
  );
}

export function DiscoverView() {
  const addons = useAddons();
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<{ addon: AddonEntry; meta: Meta } | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setPicked(null);
    const result = await Promise.all(
      addons.map(async (addon): Promise<Group> => {
        if (!addon.manifest) return { addon, metas: [], error: addon.error };
        const catalogs = addon.manifest.catalogs.filter((c) => c.search);
        const settled = await Promise.allSettled(catalogs.map((c) => searchCatalog(addon.baseUrl, c, q)));
        const seen = new Set<string>();
        const metas = settled
          .flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
          .filter((m) => !seen.has(m.id) && seen.add(m.id));
        const failed = settled.find((s) => s.status === 'rejected');
        return { addon, metas, error: failed && metas.length === 0 ? String((failed as PromiseRejectedResult).reason?.message ?? 'Search failed') : undefined };
      }),
    );
    setGroups(result);
    setSearching(false);
  }

  return (
    <>
      <form className={styles.toolbar} onSubmit={(e) => void search(e)}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search books and audiobooks…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search add-ons"
        />
        <button className="btn btn-primary" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {picked && <StreamPicker key={picked.meta.id} {...picked} onClose={() => setPicked(null)} />}
      {groups?.map((g) => (
        <section key={g.addon.baseUrl}>
          <h2 className={styles.groupTitle}>{g.addon.manifest?.name ?? g.addon.baseUrl}</h2>
          {g.error && <p className={styles.message}>{g.error}</p>}
          {!g.error && g.metas.length === 0 && <p className={styles.empty}>No results.</p>}
          <ul className={styles.grid}>
            {g.metas.map((m) => (
              <ResultCard key={m.id} meta={m} onPick={() => setPicked({ addon: g.addon, meta: m })} />
            ))}
          </ul>
        </section>
      ))}
      <AddonsPanel addons={addons} />
    </>
  );
}
