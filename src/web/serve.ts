import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const API = process.env.API_URL ?? "http://localhost:3000"
const PORT = Number(process.env.WEB_PORT ?? 3001)

// Dev-only: HMR + verbose console in the browser. In production this MUST
// be false, otherwise Bun bundles the SPA with the dev JSX runtime
// (jsxDEV) but resolves React to the prod runtime that has no jsxDEV
// export — every component crashes at first render.
const isDev = (process.env.NODE_ENV ?? "development") === "development"

const HERE = dirname(new URL(import.meta.url).pathname)
const DIST = resolve(HERE, "dist")

// SPA fallback policy: any path that isn't /api, /webdav, or an
// existing built asset returns index.html so React Router takes over
// client-side. We don't keep an allowlist of routes — Stohr has many
// (/me, /folders, /admin, /trash, /shares, …) and an out-of-date list
// here surfaces as a 404 "Not Found" body which, on top-level Safari
// navigations, manifests as a download prompt.

const buildSpa = async (): Promise<void> => {
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true })
  const out = await Bun.build({
    entrypoints: [join(HERE, "index.html")],
    outdir: DIST,
    target: "browser",
    minify: !isDev,
    sourcemap: isDev ? "inline" : "none",
  })
  if (!out.success) {
    for (const log of out.logs) console.error(log)
    throw new Error("SPA bundle failed")
  }
}

await buildSpa()

// Bun.build emits `<script type="module" crossorigin src="…">` and the
// matching crossorigin on <link rel="stylesheet">. The assets are same-
// origin, so the attribute is gratuitous — Safari fetches them in CORS
// mode, finds no Access-Control-Allow-Origin on the response, refuses to
// execute the module, and falls back to a "do you want to download this"
// prompt for the bundle file. Strip the attribute so Safari treats them
// as ordinary same-origin loads.
const indexHtml = (await Bun.file(join(DIST, "index.html")).text()).replace(
  / crossorigin(?=[\s>])/g,
  "",
)

const serveAsset = async (path: string): Promise<Response | null> => {
  // Reject path traversal — DIST is the only thing we ever serve from.
  const safe = path.replace(/^\/+/, "")
  if (safe.includes("..")) return null
  const file = Bun.file(join(DIST, safe))
  if (!(await file.exists())) return null
  return new Response(file)
}

// Heuristic: a request is for an asset file (not a SPA navigation) when
// its last path segment contains a dot — `/foo/bar.png`, `/manifest.json`,
// `/favicon.ico`, etc. SPA routes never have an extension on the final
// segment. Used to decide whether a not-found path should 404 or fall
// back to the SPA index.html.
const looksLikeAsset = (path: string): boolean => {
  const last = path.split("/").pop() ?? ""
  return last.includes(".")
}

const proxy = async (req: Request, target: string): Promise<Response> => {
  const res = await fetch(target, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  })
  return new Response(res.body, { status: res.status, headers: res.headers })
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname.startsWith("/api/")) {
      return proxy(req, `${API}${url.pathname.replace("/api", "")}${url.search}`)
    }

    // WebDAV pass-through. OS-level WebDAV clients (Finder, Explorer) connect
    // to the public hostname (whatever the edge terminates on), not the API
    // port directly. They speak HTTP Basic — the API's WebDAV handler reads
    // Authorization off the request, so we forward headers verbatim. Methods
    // include PROPFIND, MKCOL, MOVE, COPY in addition to GET/PUT/DELETE.
    if (url.pathname === "/webdav" || url.pathname.startsWith("/webdav/")) {
      return proxy(req, `${API}${url.pathname}${url.search}`)
    }

    const asset = await serveAsset(url.pathname)
    if (asset) return asset

    // Asset-shaped path that wasn't found → 404. SPA-shaped path → fall
    // through to the index.html so client-side routing handles it.
    if (looksLikeAsset(url.pathname)) {
      return new Response("Not Found", { status: 404 })
    }

    return new Response(indexHtml, {
      headers: { "content-type": "text/html;charset=utf-8" },
    })
  },
})

console.log(`[stohr] web on http://localhost:${PORT}`)
