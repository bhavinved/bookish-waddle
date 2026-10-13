import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { db, getProgress, saveProgress, touchBook, type Book, type Chapter } from '../../core/db';
import { audioLocator } from '../../core/locator';
import { openSource, type BookSource } from '../../core/source';
import { chapterIndexAt, clampRate, nextTrack, resumePoint, singleChapter, trackedProgress } from './playerLogic';

export interface PlayerApi {
  book: Book | null;
  chapters: Chapter[];
  chapterIndex: number;
  playing: boolean;
  loading: boolean;
  error: string | null;
  position: number;
  duration: number;
  rate: number;
  load(bookId: string): Promise<void>;
  toggle(): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  skip(delta: number): void;
  setRate(rate: number): void;
  goChapter(index: number): void;
  close(): void;
}

const Ctx = createContext<PlayerApi | null>(null);

const SAVE_EVERY_MS = 5000;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current === null && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'metadata';
  }
  const sourceRef = useRef<BookSource | null>(null);
  const lastSaveRef = useRef(0);
  const loadTokenRef = useRef(0);

  const [book, setBook] = useState<Book | null>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRateState] = useState(1);
  // Multi-track books: index of the file being played. Single-file books derive the chapter from the position.
  const [track, setTrack] = useState(0);
  const trackRef = useRef(0);
  trackRef.current = track;

  const bookRef = useRef<Book | null>(null);
  bookRef.current = book;

  const chapters = useMemo<Chapter[]>(
    () => (book ? (book.chapters && book.chapters.length > 0 ? book.chapters : singleChapter(book.title)) : []),
    [book],
  );
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const chapterIndex = book?.multiTrack ? track : chapterIndexAt(chapters, position);

  const persist = useCallback(() => {
    const audio = audioRef.current;
    const b = bookRef.current;
    if (!audio || !b) return;
    const dur = Number.isFinite(audio.duration) ? audio.duration : (b.durationSec ?? 0);
    const idx = b.multiTrack ? trackRef.current : chapterIndexAt(chaptersRef.current, audio.currentTime);
    const loc = audioLocator(audio.currentTime, dur, idx);
    void saveProgress(
      b.id,
      b.multiTrack ? { ...loc, progress: trackedProgress(chaptersRef.current, idx, audio.currentTime) } : loc,
    );
    lastSaveRef.current = Date.now();
  }, []);

  const pause = useCallback(() => audioRef.current?.pause(), []);
  const play = useCallback(() => {
    void audioRef.current?.play().catch(() => setPlaying(false));
  }, []);
  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) play();
    else a.pause();
  }, [play]);

  const seek = useCallback((seconds: number) => {
    const a = audioRef.current;
    if (!a) return;
    const max = Number.isFinite(a.duration) ? a.duration : Infinity;
    a.currentTime = Math.min(max, Math.max(0, seconds));
    setPosition(a.currentTime);
  }, []);

  const skip = useCallback((delta: number) => seek((audioRef.current?.currentTime ?? 0) + delta), [seek]);

  const setRate = useCallback((r: number) => {
    const v = clampRate(r);
    setRateState(v);
    if (audioRef.current) {
      // defaultPlaybackRate survives src changes (track switches); playbackRate alone is reset by them.
      audioRef.current.defaultPlaybackRate = v;
      audioRef.current.playbackRate = v;
    }
  }, []);

  /** Multi-track books: load track `i` into the audio element and optionally start it. */
  const switchTrack = useCallback(async (i: number, startAt = 0, autoplay = true) => {
    const audio = audioRef.current;
    const source = sourceRef.current;
    if (!audio || !source || !chaptersRef.current[i]) return;
    const token = loadTokenRef.current;
    const url = await source.getUrl(i);
    if (token !== loadTokenRef.current) return;
    audio.src = url;
    trackRef.current = i;
    setTrack(i);
    setPosition(startAt);
    setDuration(chaptersRef.current[i]?.duration ?? 0);
    if (startAt > 0) {
      audio.addEventListener('loadedmetadata', () => (audio.currentTime = startAt), { once: true });
    }
    if (autoplay) void audio.play().catch(() => setPlaying(false));
  }, []);

  const goChapter = useCallback(
    (i: number) => {
      const c = chaptersRef.current[i];
      if (!c) return;
      if (bookRef.current?.multiTrack) void switchTrack(i);
      else seek(c.start);
    },
    [seek, switchTrack],
  );

  const close = useCallback(() => {
    loadTokenRef.current++;
    const audio = audioRef.current;
    if (audio && bookRef.current) {
      persist();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    sourceRef.current?.release();
    sourceRef.current = null;
    setBook(null);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setTrack(0);
  }, [persist]);

  const load = useCallback(
    async (bookId: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (bookRef.current?.id === bookId) return;
      const token = ++loadTokenRef.current;
      setLoading(true);
      setError(null);
      try {
        if (bookRef.current) persist();
        const b = await db.books.get(bookId);
        if (!b || b.format !== 'audio') throw new Error('Audiobook not found');
        const source = await openSource(b);
        const saved = await getProgress(bookId);
        const resume = resumePoint(saved, !!b.multiTrack, b.chapters?.length ?? 0);
        const url = await source.getUrl(b.multiTrack ? resume.track : undefined);
        if (token !== loadTokenRef.current) {
          source.release();
          return;
        }
        audio.pause();
        sourceRef.current?.release();
        sourceRef.current = source;
        audio.src = url;
        audio.defaultPlaybackRate = rate;
        audio.playbackRate = rate;
        const resumeAt = resume.seconds;
        trackRef.current = resume.track;
        setTrack(resume.track);
        setBook(b);
        setPosition(resumeAt);
        setDuration(b.multiTrack ? (b.chapters?.[resume.track]?.duration ?? 0) : (b.durationSec ?? 0));
        setPlaying(false);
        const applyResume = () => {
          if (resumeAt > 0) audio.currentTime = resumeAt;
        };
        if (audio.readyState >= 1) applyResume();
        else audio.addEventListener('loadedmetadata', applyResume, { once: true });
        void touchBook(bookId);
      } catch (e) {
        if (token === loadTokenRef.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (token === loadTokenRef.current) setLoading(false);
      }
    },
    [persist, rate],
  );

  // Audio element events
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setPosition(audio.currentTime);
      if (Date.now() - lastSaveRef.current > SAVE_EVERY_MS && !audio.paused) persist();
    };
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      persist();
    };
    const onEnded = () => {
      const next = bookRef.current?.multiTrack ? nextTrack(chaptersRef.current.length, trackRef.current) : null;
      if (next !== null) {
        void switchTrack(next);
        return;
      }
      setPlaying(false);
      persist();
    };
    const onErr = () => setError('Could not play this file (is the server running, or has the link expired?)');
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onErr);
    window.addEventListener('pagehide', persist);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onErr);
      window.removeEventListener('pagehide', persist);
    };
  }, [persist, switchTrack]);

  // MediaSession (lock screen / media keys)
  const coverBlob = book?.coverBlob;
  useEffect(() => {
    if (!book || !('mediaSession' in navigator)) return;
    let artUrl: string | undefined;
    if (coverBlob) artUrl = URL.createObjectURL(coverBlob);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: book.author,
      artwork: artUrl ? [{ src: artUrl, sizes: '512x512', type: coverBlob?.type || 'image/jpeg' }] : [],
    });
    return () => {
      if (artUrl) URL.revokeObjectURL(artUrl);
    };
  }, [book, coverBlob]);

  useEffect(() => {
    if (!book || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => play()],
      ['pause', () => pause()],
      ['seekbackward', (d) => skip(-(d.seekOffset ?? 15))],
      ['seekforward', (d) => skip(d.seekOffset ?? 15)],
      ['seekto', (d) => d.seekTime !== undefined && seek(d.seekTime)],
      ['previoustrack', () => skip(-15)],
      ['nexttrack', () => skip(15)],
    ];
    for (const [a, h] of handlers) {
      try {
        ms.setActionHandler(a, h);
      } catch {
        // action unsupported in this browser
      }
    }
    return () => {
      for (const [a] of handlers) {
        try {
          ms.setActionHandler(a, null);
        } catch {
          // ignore
        }
      }
    };
  }, [book, play, pause, skip, seek]);

  useEffect(() => {
    if (!book || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [book, playing]);

  useEffect(() => {
    if (!book || !('mediaSession' in navigator) || !(duration > 0)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(position, duration),
      });
    } catch {
      // invalid state during seeks; ignore
    }
  }, [book, duration, rate, position]);

  const value: PlayerApi = {
    book,
    chapters,
    chapterIndex,
    playing,
    loading,
    error,
    position,
    duration,
    rate,
    load,
    toggle,
    play,
    pause,
    seek,
    skip,
    setRate,
    goChapter,
    close,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer outside PlayerProvider');
  return v;
}
