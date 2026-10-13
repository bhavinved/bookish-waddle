# bookish-waddle roadmap

A web app for reading ebooks and listening to audiobooks — "Stremio for books": your library is assembled from
local files, your debrid account, and pluggable source add-ons. Immersive reading (text highlighted in sync with
audio) is a later milestone, so positions in text and in audio are first-class from day one.

## Architecture

- `web/` — React + TypeScript + Vite SPA. Readers, player, library UI. Library + progress in IndexedDB.
- `server/` — small Node + TypeScript server (added in M2). Holds the debrid token, proxies debrid API and file
  bytes (debrid CDNs don't send CORS headers), hosts/aggregates source add-ons.
- npm workspaces at the root.

Core abstractions (see CLAUDE.md):
- **BookSource** — where bytes come from (`local`, `debrid`, `addon`). Readers/player only consume a source.
- **Locator** — a position in a book: EPUB CFI, PDF page, text offset, or audio time (seconds). Progress,
  bookmarks and (later) text↔audio sync are all stored as Locators.

## Milestones

| # | Milestone | Scope |
|---|-----------|-------|
| M1 | Local reader & player | Scaffold. Import local files. EPUB, PDF, TXT/MD readers. MP3/M4B player with chapters, speed, sleep timer. Library grid, per-book progress resume. |
| M2 | Debrid | `server/`. TorBox first: connect via API key, browse torrents/web downloads/usenet items, filter to book/audio files, stream into readers/player. Provider interface so Real-Debrid/AllDebrid/Premiumize can follow. |
| M3 | Add-on system | Stremio-style manifest + catalog/stream endpoints. Built-in add-ons: Project Gutenberg (ebooks), LibriVox (audiobooks). Add-on install by URL. Discover view. |
| M3b | More sources | Internet Archive, Open Library add-ons; add-on streams resolved through TorBox. (Standard Ebooks: search is patron-only or HTML scraping — on hold.) |
| M4 | Listen to any book | Text-to-speech for ebooks (Web Speech API first), pairing an ebook with its audiobook edition. |
| M5 | Immersive reading | Word/sentence highlight synced to TTS; forced alignment for human-narrated audiobooks. |
| later | PWA/offline, cross-device sync, accounts | |
