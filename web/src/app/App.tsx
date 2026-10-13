import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { ThemeProvider, useTheme } from './theme';
import { PlayerProvider } from '../features/player/PlayerProvider';
import { MiniPlayer } from '../features/player/MiniPlayer';
import { PlayerPage } from '../features/player/PlayerPage';
import { Library } from '../features/library/Library';
import { ReaderRoute } from './ReaderRoute';
import styles from './app.module.css';

function ThemeToggle() {
  const { pref, cycle } = useTheme();
  return (
    <button className="btn" onClick={cycle} title="Toggle theme">
      Theme: {pref}
    </button>
  );
}

function Shell() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          Bookish Waddle
        </Link>
        <ThemeToggle />
      </header>
      <main className={styles.main}>
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/read/:id" element={<ReaderRoute />} />
          <Route path="/listen/:id" element={<PlayerPage />} />
          <Route path="*" element={<p className={styles.pad}>Not found. <Link to="/">Back to library</Link></p>} />
        </Routes>
      </main>
      <MiniPlayer />
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <PlayerProvider>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </PlayerProvider>
    </ThemeProvider>
  );
}
