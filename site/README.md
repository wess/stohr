# Stohr site

The marketing site + rendered docs for [Stohr](https://github.com/wess/stohr).
Static, deployed to Cloudflare Pages.

## Stack

- Bun's HTML bundler for the three React marketing pages (`/`, `/developers`, `/setup`)
- `marked` + `react-dom/server` to render `docs/*.md` from the project root into static HTML at build time

No runtime API. Pure static output in `dist/`.

## Local dev

```sh
cd site
bun install
bun run dev
```

Serves on `http://localhost:4321`. Marketing pages get HMR via Bun's HTML
bundler. Doc pages re-render from the source markdown on each request —
edit `../docs/*.md` and reload.

Override the port with `SITE_PORT=…`.

## Build

```sh
bun run build
```

Output lands in `site/dist/`. Layout:

```
dist/
  index.html                 — landing
  developers.html
  setup.html
  style.css
  assets/
    logo.png
  _chunks/                   — hashed JS bundles for the React pages
  docs/
    index.html               — docs index
    api/index.html           — rendered from ../docs/API.md
    architecture/index.html  — rendered from ../docs/ARCHITECTURE.md
    …                        — one folder per entry in DOCS_INDEX
  _headers                   — Cloudflare Pages caching hints
  _redirects                 — Cloudflare Pages redirect rules
```

The doc routes map at `src/docs/render.tsx#DOCS_INDEX`. Add a new doc by
adding an entry there.

## Cloudflare Pages

Connect this repo to Cloudflare Pages with:

- **Build command:** `cd site && bun install && bun run build`
- **Build output directory:** `site/dist`
- **Root directory:** the repo root (default)
- **Framework preset:** None (custom)
- **Build system version:** v2 (or whichever supports Bun)
- **Environment variables:** none required

Cloudflare's build container ships with Bun preinstalled; if you hit a
version mismatch, set `BUN_VERSION=1.3.11` (or whatever `bun --version`
prints locally) in the project's build env.

`_redirects` and `_headers` are picked up automatically by CF Pages.
