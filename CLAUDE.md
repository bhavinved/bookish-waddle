# bookish-waddle

Ebook reader + audiobook player web app. Read ROADMAP.md for milestones and architecture.

## Layout
- npm workspaces. `web/` = React 18 + TypeScript (strict) + Vite. `server/` arrives in M2.
- Run from the repo root: `npm install`, `npm run dev`, `npm run build`, `npm test`, `npm run lint`.

## Conventions
- TypeScript strict; no `any` without a comment saying why.
- Feature folders under `web/src/features/<name>/` (library, reader-epub, reader-pdf, reader-text, player).
  Shared types and services in `web/src/core/`.
- Readers and the player never fetch or read files directly — they take a `BookSource` (core/source.ts).
- All positions (progress, bookmarks, future text↔audio sync) are `Locator`s (core/locator.ts).
- Persistence goes through `web/src/core/db.ts` (IndexedDB via Dexie). No localStorage for library data.
- Tests: Vitest for logic in `core/` and parsers. Keep UI tests light.
- Styling: plain CSS modules + CSS custom properties; light and dark themes. No UI kit.
- Smallest change that fully does the job: no speculative options or abstractions; don't add a dependency for a
  few lines. Known limits get `// shortcut: <limit>, <when to upgrade>`.
- Never commit secrets (debrid tokens live in `server/.env`, gitignored).
