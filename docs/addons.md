# Add-on protocol

An add-on is a static-or-dynamic HTTPS service that tells bookish-waddle what books exist and where their bytes
are. It is modelled on Stremio add-ons. The web app talks to add-ons directly from the browser; our server never
proxies arbitrary URLs.

Install an add-on by giving the app its **base URL** (e.g. `https://example.com/my-addon`). The app appends the paths
below. A trailing `/manifest.json` or `/` on the pasted URL is ignored.

## Requirements

- Base URL is `https://`.
- Every response is JSON and sends `Access-Control-Allow-Origin: *`.
- Clients treat every field as untrusted: entries with a wrong shape are skipped, not fatal.

## `GET {base}/manifest.json`

```json
{
  "id": "my-addon",
  "name": "My Add-on",
  "version": "1.0.0",
  "description": "What it offers",
  "types": ["ebook", "audiobook"],
  "catalogs": [{ "type": "ebook", "id": "search", "name": "Search", "search": true }]
}
```

`id` must be unique per add-on. Only catalogs with `"search": true` are queried by Discover.

## `GET {base}/catalog/{type}/{catalogId}.json?search=<q>&skip=<n>`

`type` is `ebook` or `audiobook`. `skip` is a result offset (the app currently sends none).

```json
{ "metas": [{ "id": "1342", "type": "ebook", "name": "Pride and Prejudice",
              "author": "Jane Austen", "poster": "https://…/cover.jpg", "description": "…" }] }
```

`id`, `type`, `name` are required; `author`, `poster` (https image URL), `description` (plain text) are optional.

## `GET {base}/stream/{type}/{id}.json`

```json
{ "streams": [
  { "name": "EPUB", "format": "epub", "url": "https://…/book.epub" },
  { "name": "MP3", "format": "audio",
    "tracks": [{ "title": "Chapter 1", "url": "https://…/01.mp3", "duration": 1132 }] }
] }
```

A stream has exactly one of: `url`, `tracks`, `externalUrl` or `infoHash`.

- `format` is `epub`, `pdf`, `txt` or `audio`. Required for `url` and `tracks` streams.
- `url`: a single file.
- `tracks`: a multi-file audiobook, played in order (`duration` in seconds is optional but gives better progress).
- Ebook `url`s are fetched by the browser, so that host must also allow CORS. Audio is played through an `<audio>`
  element, which does not need CORS.
- `externalUrl`: the title cannot be added (e.g. borrow-only). The app shows an "Open" link that opens it in a new
  tab and no "Add" button.
- `infoHash` (40 hex characters), optional `fileIdx` (0-based file index inside the torrent) and `name`: a Stremio-style
  torrent stream. It is resolved through the user's own TorBox account, never by the add-on. The app adds
  "Add via TorBox" when TorBox is configured; if the torrent is not cached it offers "Send to TorBox" instead.
  Without `fileIdx`, the first supported book/audio file is used.
- `url`, `tracks` and `externalUrl` must be `https://`.

```json
{ "streams": [
  { "name": "Borrow on Open Library", "externalUrl": "https://openlibrary.org/works/OL1W" },
  { "name": "Torrent", "infoHash": "0123456789abcdef0123456789abcdef01234567", "fileIdx": 1 }
] }
```

## Built-in add-ons

Served by our own server under `/api/addons/<id>/` using this same protocol. Always installed, cannot be removed.

| id | Source | Notes |
|----|--------|-------|
| `gutenberg` | Project Gutenberg OPDS search | EPUB served through `/api/addons/gutenberg/file/:id` (no CORS upstream) |
| `librivox` | LibriVox API | per-section MP3 `tracks` on archive.org |
| `archive` | Internet Archive | ebook + audiobook catalogs; lending-only items are excluded; ebook files go through `/api/addons/archive/file/:identifier/:filename` (no CORS upstream), only for files listed in the item's metadata; audio uses the original MP3s as `tracks` |
| `openlibrary` | Open Library | ebooks only; free-to-read works reuse the `archive` streams, borrow-only works return an `externalUrl` |

## Not yet supported

Catalog paging in the UI and add-on-provided TXT/PDF special handling.
