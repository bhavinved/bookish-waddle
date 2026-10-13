import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useDebouncedSaver } from '../../app/hooks';
import { saveProgress } from '../../core/db';
import { pdfLocator } from '../../core/locator';
import type { ReaderProps } from '../readerProps';
import styles from '../readers.module.css';

type Zoom = 'fit' | number;

// shortcut: canvas only (no selectable text layer); add pdf.js TextLayer when copy/search is needed.
export function PdfReader({ book, source, initial }: ReaderProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initial?.type === 'pdf' ? initial.page : 1);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [wrapWidth, setWrapWidth] = useState(0);
  const save = useDebouncedSaver((l: ReturnType<typeof pdfLocator>) => saveProgress(book.id, l));
  const numPages = pdf?.numPages ?? 0;

  useEffect(() => {
    let doc: PDFDocumentProxy | null = null;
    let cancelled = false;
    (async () => {
      const { loadPdf } = await import('../../core/pdfjs');
      const loaded = await loadPdf(await source.getBlob());
      doc = loaded;
      if (cancelled) return void loaded.loadingTask.destroy();
      setPdf(loaded);
      setPage((p) => Math.min(Math.max(1, p), loaded.numPages));
    })().catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      void doc?.loadingTask.destroy();
    };
  }, [source]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !canvas.current || wrapWidth === 0) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    const c = canvas.current;
    (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const scale = zoom === 'fit' ? (wrapWidth - 16) / base.width : zoom;
      const dpr = window.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: scale * dpr });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      c.style.width = `${Math.floor(viewport.width / dpr)}px`;
      c.style.height = `${Math.floor(viewport.height / dpr)}px`;
      task = p.render({ canvas: c, viewport });
      await task.promise;
    })().catch((e: unknown) => {
      if ((e as { name?: string }).name !== 'RenderingCancelledException' && !cancelled) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, zoom, wrapWidth]);

  useEffect(() => {
    if (numPages > 0) save(pdfLocator(page, numPages));
    wrap.current?.scrollTo({ top: 0 });
  }, [page, numPages, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') setPage((p) => Math.min(p + 1, numPages || 1));
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') setPage((p) => Math.max(p - 1, 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [numPages]);

  const go = (p: number) => setPage(Math.min(Math.max(1, p), Math.max(1, numPages)));
  const curScale = typeof zoom === 'number' ? zoom : 1;

  return (
    <div className={styles.reader}>
      <div className={styles.bar}>
        <Link to="/" className="btn-icon" aria-label="Library">
          ←
        </Link>
        <span className={styles.title}>{book.title}</span>
        <button className="btn-icon" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page">
          ‹
        </button>
        <input
          type="number"
          min={1}
          max={numPages || 1}
          value={page}
          onChange={(e) => go(Number(e.target.value) || 1)}
          style={{ width: '4.5rem' }}
          aria-label="Page number"
        />
        <span className={styles.status}>/ {numPages || '…'}</span>
        <button className="btn-icon" onClick={() => go(page + 1)} disabled={page >= numPages} aria-label="Next page">
          ›
        </button>
        <button className="btn-icon" onClick={() => setZoom(Math.max(0.25, curScale - 0.25))} aria-label="Zoom out">
          −
        </button>
        <button className="btn-icon" onClick={() => setZoom(Math.min(5, curScale + 0.25))} aria-label="Zoom in">
          +
        </button>
        <button className="btn" onClick={() => setZoom('fit')}>
          Fit width
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      <div
        ref={wrap}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--surface-2)', textAlign: 'center' }}
      >
        <canvas ref={canvas} style={{ margin: '8px auto', boxShadow: 'var(--shadow)', background: '#fff' }} />
      </div>
    </div>
  );
}
