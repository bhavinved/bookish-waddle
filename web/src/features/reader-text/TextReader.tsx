import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDebouncedSaver } from '../../app/hooks';
import { saveProgress } from '../../core/db';
import { textLocator } from '../../core/locator';
import type { ReaderProps } from '../readerProps';
import styles from '../readers.module.css';
import text from './text.module.css';
import { blockIndexForOffset, toBlocks } from './blocks';

export function TextReader({ book, source, initial }: ReaderProps) {
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const [percent, setPercent] = useState(initial?.progress ?? 0);
  const save = useDebouncedSaver((l: ReturnType<typeof textLocator>) => saveProgress(book.id, l));

  useEffect(() => {
    let cancelled = false;
    source
      .getBlob()
      .then((b) => b.text())
      .then((t) => !cancelled && setRaw(t))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [source]);

  const blocks = useMemo(
    () => (raw === null ? [] : toBlocks(raw, book.format === 'md' ? 'md' : 'txt')),
    [raw, book.format],
  );

  useEffect(() => {
    const el = scroller.current;
    if (!el || raw === null || restored.current) return;
    restored.current = true;
    if (initial?.type === 'text') {
      const idx = blockIndexForOffset(blocks, initial.offset);
      (el.children[idx] as HTMLElement | undefined)?.scrollIntoView();
    }
  }, [raw, blocks, initial]);

  function onScroll() {
    const el = scroller.current;
    if (!el || raw === null || !restored.current) return;
    const top = el.getBoundingClientRect().top;
    const kids = Array.from(el.children) as HTMLElement[];
    let idx = kids.findIndex((k) => k.getBoundingClientRect().bottom > top + 1);
    if (idx < 0) idx = kids.length - 1;
    const loc = textLocator(blocks[idx]?.offset ?? 0, raw.length);
    setPercent(loc.progress);
    save(loc);
  }

  return (
    <div className={styles.reader}>
      <div className={styles.bar}>
        <Link to="/" className="btn-icon" aria-label="Library">
          ←
        </Link>
        <span className={styles.title}>{book.title}</span>
        <span className={styles.status}>{Math.round(percent * 100)}%</span>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div className={text.scroll} ref={scroller} onScroll={onScroll} tabIndex={0}>
        {blocks.map((b) => (
          <div key={b.offset} className={text.block} dangerouslySetInnerHTML={{ __html: b.html }} />
        ))}
      </div>
    </div>
  );
}
