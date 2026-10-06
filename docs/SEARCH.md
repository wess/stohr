# Search

Stohr ships two search surfaces:

1. **Filename search** (`GET /search`) — pg_trgm similarity over `files.name` and `folders.name`, plus filter tokens (`kind:`, `ext:`). Always on; no extraction.
2. **Full-text content search** (`GET /search/content`) — Postgres `tsvector` over extracted file text, with `ts_headline` snippets. Indexing happens out-of-band so uploads stay fast.

Both searches restrict results to resources the caller can read in their team, including Space membership.

## In the web app

Use **Search files, folders, and contents** in the file toolbar or press `⌘K` / `Ctrl+K`. Name search includes files and folders; content search finds text inside supported documents. Open a folder result to browse it, or a file result to preview it. Empty results, loading, and retryable failures are shown separately.

The file browser has a **Grid / List / Gallery** switch. Gallery keeps documents visible alongside images and videos, with filenames beneath previews. The selected view is remembered in that browser; it does not change anyone else's view.

## Content extraction

The background indexer wakes every 30 seconds, claims the next 5 files that haven't been indexed against their current `version`, and extracts text:

| Type | How |
|---|---|
| `text/*`, `application/json`, source code, log files | Read as UTF-8 |
| `text/html`, `*.html` | Tag-stripped |
| `application/pdf` | `pdftotext -enc UTF-8 -nopgbrk - -` (poppler-utils) |
| `*.docx`, `*.xlsx`, `*.pptx` | `unzip -p` + XML extraction |
| Anything else (images, video, archives) | Skipped, recorded as `text_extract_error = 'skipped: …'` |

If `pdftotext` / `unzip` are not installed on the host, those formats are skipped gracefully — Stohr keeps working and the indexer just records the missing-tool reason in `files.text_extract_error`. Install **poppler-utils** and **unzip** on the host (both are tiny) to cover PDF and Office docs.

Extracted text is capped at 1 MiB per file. Files over 50 MiB are skipped before extraction. External extractors are terminated after 8 seconds and have a 2 MiB output ceiling. With malware scanning enabled, only clean files are indexed and only clean files produce content snippets; see [Configuration](CONFIGURATION.md#antivirus-scanning-clamav).

The indexed `files.text_tsv` is a `GENERATED` column combining the filename (weight A) and the extracted content (weight B), so renames and re-uploads automatically update the index.

## Query syntax

`/search/content?q=…` runs the query through Postgres `websearch_to_tsquery`, which supports:

- Plain keywords: `migration plan`
- Quoted phrases: `"key rotation"`
- Boolean OR: `migration OR rollout`
- Negation: `migration -draft`

Each hit returns the file row plus a `snippet`. The server HTML-escapes document text and adds `<mark>` only around matched terms. Preserve that escaping if rendering the snippet as HTML; never substitute raw extracted text.

## Index health

`GET /admin/content-index/status` (owner-only) returns:

```json
{
  "total": 1240,
  "indexed": 1232,
  "pending": 3,
  "errored": 5
}
```

A new import can create a backlog larger than one batch. Check that `pending` falls across successive ticks. `errored` only counts rows where extraction returned an actual error (not "skipped").

## Tuning

- **Indexer batch size** lives in `src/server.ts` (`indexContentBatch(db, store, 5)`). Bump if your backlog is large; each batch holds files in memory while extracting, so don't go higher than ~20.
- **Index frequency** is `setInterval(…, 30 * 1000)`. The cron is guarded so a slow run can't stack.
- **Max indexed text per file** is `MAX_TEXT_BYTES` in `src/search/content/extract.ts`. Bumping it past a few MiB starts to make `ts_headline` slow.

## What's not indexed

- Image/video/audio content (no OCR / ASR — out of scope for now)
- Encrypted archives (zip with password, rar) — `unzip` can't open them
- Files in `/trash` (soft-deleted)
- Federation blobs you don't own a local copy of
