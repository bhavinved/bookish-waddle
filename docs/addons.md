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

- `format` is `epub`, `pdf`, `txt` or `audio`.
- A stream has either `url` (single file) or `tracks` (multi-file audiobook, played in order; `duration` in
  seconds is optional but gives better progress).
- Ebook `url`s are fetched by the browser, so that host must also allow CORS. Audio is played through an `<audio>`
  element, which does not need CORS.
- URLs must be `https://`.

## Built-in add-ons

`gutenberg` (Gutendex search, EPUB served through `/api/addons/gutenberg/file/:id` because gutenberg.org has no
CORS headers) and `librivox` (LibriVox API, per-section MP3 `tracks` on archive.org) are served by our own server
under `/api/addons/<id>/` using this same protocol. They are always installed and cannot be removed.

## Not yet supported

Catalog paging in the UI, add-on-provided TXT/PDF special handling, and streams that resolve through debrid.
