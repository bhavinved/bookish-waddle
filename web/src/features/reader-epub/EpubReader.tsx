import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ePub, { type NavItem, type Rendition } from 'epubjs';
import { useTheme } from '../../app/theme';
import { useDebouncedSaver } from '../../app/hooks';
import { saveProgress } from '../../core/db';
import { epubLocator } from '../../core/locator';
import type { ReaderProps } from '../readerProps';
import styles from '../readers.module.css';

const PALETTE = {
  light: { background: '#ffffff', color: '#1c1b19' },
  dark: { background: '#121212', color: '#d9d7d2' },
};
const MIN_FONT = 70;
const MAX_FONT = 220;

export function EpubReader({ book, source, initial }: ReaderProps) {
  const { resolved } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition | null>(null);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('bw-epub-font')) || 100);
  const [percent, setPercent] = useState(initial?.progress ?? 0);
  const [error, setError] = useState<string | null>(null);
  const save = useDebouncedSaver((l: ReturnType<typeof epubLocator>) => saveProgress(book.id, l));
  const saveRef = useRef(save);
  saveRef.current = save;
  const themeRef = useRef(resolved);
  themeRef.current = resolved;
  const fontRef = useRef(fontSize);
  fontRef.current = fontSize;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const epub = ePub();
    // epub.js reports open/render failures through events and promises we do not await; surface all of them.
    const fail = (e: unknown) => {
      if (!disposed) setError(`This EPUB couldn't be opened: ${e instanceof Error ? e.message : String(e)}`);
    };
    epub.on('openFailed', fail);
    (async () => {
      const blob = await source.getBlob();
      const buf = await blob.arrayBuffer();
      if (disposed) return;
      epub.open(buf, 'binary').catch(fail);
      // Some EPUBs make epub.js throw while loading a section, inside promise chains whose result nothing awaits (the
      // reader just stays blank, `displayerror` never fires). Every section/resource load goes through book.load.
      const load = epub.load.bind(epub);
      epub.load = (path: string) => {
        try {
          const loading = load(path);
          loading.catch(fail);
          return loading;
        } catch (e) {
          fail(e);
          throw e;
        }
      };
      const r = epub.renderTo(el, { width: '100%', height: '100%', flow: 'paginated', spread: 'auto' });
      rendition.current = r;
      r.on('displayerror', fail);
      r.themes.register('light', { body: PALETTE.light });
      r.themes.register('dark', { body: PALETTE.dark });
      r.themes.select(themeRef.current);
      r.themes.fontSize(`${fontRef.current}%`);

      let locationsReady = false;
      r.on('relocated', (loc: { start: { cfi: string; index: number; displayed: { page: number; total: number } } }) => {
        // epubjs Spine has a runtime length missing from its typings
        const spineLen = (epub.spine as unknown as { length: number }).length || 1;
        const p = locationsReady
          ? epub.locations.percentageFromCfi(loc.start.cfi)
          : (loc.start.index + loc.start.displayed.page / Math.max(1, loc.start.displayed.total)) / spineLen;
        setPercent(p);
        saveRef.current(epubLocator(loc.start.cfi, p));
      });
      r.on('keyup', (e: KeyboardEvent) => {
        if (e.key === 'ArrowRight') void r.next();
        if (e.key === 'ArrowLeft') void r.prev();
      });
      // Tap/click zones: left 30% = previous, right 30% = next.
      r.on('click', (e: MouseEvent) => {
        const w = e.view?.innerWidth || el.clientWidth;
        if (e.clientX < w * 0.3) void r.prev();
        else if (e.clientX > w * 0.7) void r.next();
      });

      await r.display(initial?.type === 'epub' ? initial.cfi : undefined);
      if (disposed) return;
      const nav = await epub.loaded.navigation;
      if (disposed) return;
      setToc(nav.toc);
      // shortcut: locations are generated in memory each open (slow on huge books); cache in db when it matters.
      await epub.locations.generate(1600);
      if (disposed) return;
      locationsReady = true;
    })().catch(fail);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') void rendition.current?.next();
      if (e.key === 'ArrowLeft') void rendition.current?.prev();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      rendition.current = null;
      epub.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per mounted book (route keys on book id)
  }, []);

  useEffect(() => {
    rendition.current?.themes.select(resolved);
  }, [resolved]);

  function changeFont(delta: number) {
    const next = Math.min(MAX_FONT, Math.max(MIN_FONT, fontSize + delta));
    setFontSize(next);
    rendition.current?.themes.fontSize(`${next}%`);
    localStorage.setItem('bw-epub-font', String(next));
  }

  const bg = PALETTE[resolved].background;
  return (
    <div className={styles.reader}>
      <div className={styles.bar}>
        <Link to="/" className="btn-icon" aria-label="Library">←</Link>
        <button className="btn-icon" onClick={() => setShowToc((s) => !s)} aria-label="Table of contents">☰</button>
        <span className={styles.title}>{book.title}</span>
        <button className="btn-icon" onClick={() => changeFont(-10)} aria-label="Smaller text">A−</button>
        <button className="btn-icon" onClick={() => changeFont(10)} aria-label="Larger text">A+</button>
        <span className={styles.status}>{Math.round(percent * 100)}%</span>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.body} style={{ background: bg }}>
        {showToc && (
          <nav className={styles.drawer}>
            <TocList items={toc} onPick={(href) => { void rendition.current?.display(href); setShowToc(false); }} />
          </nav>
        )}
        <button className="btn-icon" style={{ alignSelf: 'center' }} onClick={() => void rendition.current?.prev()} aria-label="Previous page">‹</button>
        <div ref={host} style={{ flex: 1, minWidth: 0 }} />
        <button className="btn-icon" style={{ alignSelf: 'center' }} onClick={() => void rendition.current?.next()} aria-label="Next page">›</button>
      </div>
    </div>
  );
}

function TocList({ items, onPick, depth = 0 }: { items: NavItem[]; onPick: (href: string) => void; depth?: number }) {
  return (
    <>
      {items.map((it) => (
        <div key={it.id}>
          <button style={{ paddingLeft: `${0.5 + depth}rem` }} onClick={() => onPick(it.href)}>
            {it.label.trim()}
          </button>
          {it.subitems && <TocList items={it.subitems} onPick={onPick} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}
