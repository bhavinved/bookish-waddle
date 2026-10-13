import { useEffect, useRef, useState, type DependencyList } from 'react';
import { liveQuery } from 'dexie';

/** Subscribes to a Dexie query; re-renders whenever the underlying tables change. */
export function useLive<T>(query: () => Promise<T> | T, deps: DependencyList): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (e) => console.error('liveQuery failed', e),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller
  }, deps);
  return value;
}

/** Creates an object URL for a Blob and revokes it when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** Debounced saver: call `save(value)` often; the latest value is written after `delay` ms and on unmount. */
export function useDebouncedSaver<T>(write: (value: T) => void | Promise<void>, delay = 600): (value: T) => void {
  const writeRef = useRef(write);
  writeRef.current = write;
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const flush = () => {
      window.clearTimeout(timer.current);
      if (pending.current) {
        const { value } = pending.current;
        pending.current = null;
        void writeRef.current(value);
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  return (value: T) => {
    pending.current = { value };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (pending.current) {
        const v = pending.current.value;
        pending.current = null;
        void writeRef.current(v);
      }
    }, delay);
  };
}
