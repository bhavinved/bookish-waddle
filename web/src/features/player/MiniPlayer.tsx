import { Link, useLocation } from 'react-router-dom';
import { formatTime } from '../../core/locator';
import { usePlayer } from './PlayerProvider';
import styles from './player.module.css';

/** Persistent bar: audio lives in PlayerProvider, so playback continues while browsing. */
export function MiniPlayer() {
  const p = usePlayer();
  const { pathname } = useLocation();
  if (!p.book || pathname.startsWith('/listen/')) return null;
  return (
    <div className={styles.mini}>
      <Link to={`/listen/${p.book.id}`} className={styles.miniInfo}>
        <strong>{p.book.title}</strong>
        <span className={styles.muted}>
          {formatTime(p.position)} / {formatTime(p.duration)}
        </span>
      </Link>
      <button className="btn-icon" onClick={() => p.skip(-15)} aria-label="Back 15 seconds">
        −15
      </button>
      <button className="btn btn-primary" onClick={p.toggle}>
        {p.playing ? 'Pause' : 'Play'}
      </button>
      <button className="btn-icon" onClick={() => p.skip(15)} aria-label="Forward 15 seconds">
        +15
      </button>
      <button className="btn-icon" onClick={p.close} aria-label="Close player">
        ✕
      </button>
    </div>
  );
}
