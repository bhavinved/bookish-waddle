import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useObjectUrl } from '../../app/hooks';
import { formatTime } from '../../core/locator';
import { usePlayer } from './PlayerProvider';
import { RATES } from './playerLogic';
import styles from './player.module.css';

export function PlayerPage() {
  const { id = '' } = useParams();
  const p = usePlayer();
  const { load } = p;
  useEffect(() => {
    void load(id);
  }, [id, load]);
  const cover = useObjectUrl(p.book?.coverBlob);

  if (p.error) {
    return (
      <p style={{ padding: '1rem' }}>
        {p.error}. <Link to="/">Back to library</Link>
      </p>
    );
  }
  if (!p.book || p.book.id !== id) return <p style={{ padding: '1rem' }}>Loading…</p>;

  return (
    <div className={styles.page}>
      <Link to="/">← Library</Link>
      <div className={styles.cover}>{cover ? <img src={cover} alt="" /> : <span>AUDIO</span>}</div>
      <h1 className={styles.title}>{p.book.title}</h1>
      <div className={styles.author}>{p.book.author}</div>

      <input
        className={styles.scrubber}
        type="range"
        min={0}
        max={p.duration || 0}
        step={1}
        value={Math.min(p.position, p.duration || 0)}
        onChange={(e) => p.seek(Number(e.target.value))}
        aria-label="Seek"
      />
      <div className={styles.times}>
        <span>{formatTime(p.position)}</span>
        <span>-{formatTime(Math.max(0, p.duration - p.position))}</span>
      </div>

      <div className={styles.controls}>
        <button className="btn" onClick={() => p.skip(-15)} aria-label="Back 15 seconds">
          −15s
        </button>
        <button className={`btn btn-primary ${styles.playBtn}`} onClick={p.toggle}>
          {p.playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn" onClick={() => p.skip(15)} aria-label="Forward 15 seconds">
          +15s
        </button>
      </div>

      <label className={styles.rate}>
        Speed{' '}
        <select value={p.rate} onChange={(e) => p.setRate(Number(e.target.value))}>
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r}x
            </option>
          ))}
        </select>
      </label>

      {p.chapters.length > 1 && (
        <ol className={styles.chapters}>
          {p.chapters.map((c, i) => (
            <li key={i}>
              <button
                className={i === p.chapterIndex ? styles.activeChapter : ''}
                onClick={() => {
                  p.goChapter(i);
                  p.play();
                }}
              >
                <span>{c.title}</span>
                <span className={styles.muted}>{formatTime(c.start)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
