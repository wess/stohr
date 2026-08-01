import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { securityHeaders } from "../security/headers.ts"

const API = process.env.API_URL ?? "http://localhost:3000"
const PORT = Number(process.env.WEB_PORT ?? 3001)

// Dev-only: HMR + verbose console in the browser. In production this MUST
// be false, otherwise Bun bundles the SPA with the dev JSX runtime
// (jsxDEV) but resolves React to the prod runtime that has no jsxDEV
// export — every component crashes at first render.
const isDev = (process.env.NODE_ENV ?? "development") === "development"

const HERE = dirname(new URL(import.meta.url).pathname)
const DIST = resolve(HERE, "dist")

// SPA fallback policy: any path that isn't /api, /webdav, /s3, /auth, or an
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
const indexHtml = (await Bun.file(join(DIST, "index.html")).text()).replace(/ crossorigin(?=[\s>])/g, "")

// The theme-init snippet in index.html must run before first paint, so it
// stays inline. Hash whatever is actually in the shipped HTML and allowlist
// that exact text — if the snippet is ever edited the hash follows it, and a
// script injected into the document later still won't match.
const inlineScriptHashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  m =>
    `sha256-${createHash("sha256")
      .update(m[1] ?? "")
      .digest("base64")}`,
)
const SECURITY_HEADERS = securityHeaders(inlineScriptHashes)

const withSecurity = (res: Response): Response => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v)
  }
  return res
}

// Bun.build content-hashes every emitted asset (chunk-az2vnb4n.js,
// logo-fzn7nwb9.png), so those names are safe to cache forever — a rebuild
// changes the name. index.html is the one file that must never be cached:
// it's what points at the current hashed names.
const HASHED_ASSET_RE = /-[a-z0-9]{8,}\.[a-z0-9]+$/i

const serveAsset = async (path: string): Promise<Response | null> => {
  // Reject path traversal — DIST is the only thing we ever serve from.
  const safe = path.replace(/^\/+/, "")
  if (safe.includes("..")) return null
  const file = Bun.file(join(DIST, safe))
  if (!(await file.exists())) return null
  const res = new Response(file)
  res.headers.set(
    "cache-control",
    HASHED_ASSET_RE.test(safe) ? "public, max-age=31536000, immutable" : "public, max-age=300",
  )
  return withSecurity(res)
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
  // redirect: "manual" so 3xx from the API is forwarded to the browser rather
  // than followed server-side. The SSO login route returns a 302 to Castle's
  // /oauth/authorize — following it here would hand the browser Castle's page
  // under stohr's origin, breaking the OIDC state/PKCE cookies and the callback.
  try {
    const res = await fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "manual",
    })
    return new Response(res.body, { status: res.status, headers: res.headers })
  } catch (err) {
    // The API being down, restarting, or refusing the connection is an
    // upstream failure, not ours. Without this it surfaced as an opaque 500
    // from the runtime with no indication of which hop failed.
    console.error(`[stohr] proxy to ${target} failed:`, err)
    return new Response(JSON.stringify({ error: "Upstream API unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  // Seconds of socket inactivity, not total request duration — a steady
  // upload or download is never cut off. 0 meant a stalled peer could hold a
  // connection open indefinitely.
  idleTimeout: Number(process.env.IDLE_TIMEOUT ?? 120),
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

    // S3-compatible API pass-through. S3 SDKs / rclone / s3cmd connect to the
    // public hostname and address path-style as /s3/<bucket>/<key>; the API's
    // SigV4 handler reads the Authorization + x-amz-* headers verbatim, so we
    // forward as-is (no /api strip). Same shape as the WebDAV pass-through.
    if (url.pathname === "/s3" || url.pathname.startsWith("/s3/")) {
      return proxy(req, `${API}${url.pathname}${url.search}`)
    }

    // Castle SSO browser pass-through. The OIDC browser routes (login /
    // callback / backchannel-logout) are mounted on the API at /auth/sso/*
    // with no /api prefix — they drive top-level redirects, not XHR — so the
    // front-door must forward them verbatim like the WebDAV/S3 pass-throughs.
    // Without this /auth/sso/login falls through to index.html and the OIDC
    // redirect never starts.
    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      return proxy(req, `${API}${url.pathname}${url.search}`)
    }

    const asset = await serveAsset(url.pathname)
    if (asset) return asset

    // Asset-shaped path that wasn't found → 404. SPA-shaped path → fall
    // through to the index.html so client-side routing handles it.
    if (looksLikeAsset(url.pathname)) {
      return withSecurity(new Response("Not Found", { status: 404 }))
    }

    return withSecurity(
      new Response(indexHtml, {
        headers: {
          "content-type": "text/html;charset=utf-8",
          // Must revalidate every load: this document is what maps to the
          // current content-hashed bundle names. Caching it pins the browser
          // to a stale deploy.
          "cache-control": "no-cache",
        },
      }),
    )
  },
})

// Match the API's shutdown behaviour so a compose restart drains both halves
// instead of severing whatever the browser had in flight.
let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[stohr] web shutting down (${signal})`)
  const forced = setTimeout(() => process.exit(1), 15_000)
  forced.unref?.()
  await server.stop(false).catch(() => {})
  clearTimeout(forced)
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

console.log(`[stohr] web on http://localhost:${PORT}`)
