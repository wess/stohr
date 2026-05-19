// Dev server for the static site. Serves the three React HTML entries via
// Bun's HTML bundler (so React pages get HMR), and renders /docs/* on each
// request from the project's docs/*.md files so edits show up instantly.
import path from "node:path"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import indexHtml from "./index.html"
import developersHtml from "./developers.html"
import setupHtml from "./setup.html"
import { DOCS_INDEX, findDoc, renderDocPage, renderDocsIndex } from "./docs/render"

const PORT = Number(process.env.SITE_PORT ?? 4321)
const ROOT = path.resolve(import.meta.dir, "..")
const REPO_ROOT = path.resolve(ROOT, "..")
const SRC = path.resolve(ROOT, "src")
const isDev = (process.env.NODE_ENV ?? "development") === "development"

const renderDocResponse = async (slug: string): Promise<Response> => {
  if (slug === "" || slug === "index") {
    return new Response(renderDocsIndex(), { headers: { "content-type": "text/html; charset=utf-8" } })
  }
  const entry = findDoc(slug)
  if (!entry) return new Response("Not Found", { status: 404 })
  const src = path.join(REPO_ROOT, entry.file)
  if (!existsSync(src)) return new Response("Source markdown missing", { status: 404 })
  const md = await readFile(src, "utf8")
  return new Response(renderDocPage(entry, md), { headers: { "content-type": "text/html; charset=utf-8" } })
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  development: isDev ? { hmr: true, console: true } : false,
  routes: {
    "/": indexHtml,
    "/developers": developersHtml,
    "/setup": setupHtml,
  },
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname.replace(/\/+$/, "") || "/"

    // /docs and /docs/* — render markdown on the fly.
    if (p === "/docs") return renderDocResponse("")
    if (p.startsWith("/docs/")) {
      const slug = p.replace(/^\/docs\//, "").replace(/\/+$/, "")
      return renderDocResponse(slug)
    }

    // /assets/logo.png etc. — serve from src/assets/.
    if (p.startsWith("/assets/")) {
      const file = path.join(SRC, p)
      if (existsSync(file)) return new Response(Bun.file(file))
    }

    // /style.css — serve from src/.
    if (p === "/style.css") {
      const file = path.join(SRC, "style.css")
      if (existsSync(file)) return new Response(Bun.file(file), { headers: { "content-type": "text/css" } })
    }

    return new Response("Not Found", { status: 404 })
  },
})

console.log(`[site] dev on http://localhost:${PORT}`)
console.log(`[site]   /          → landing`)
console.log(`[site]   /developers → developers`)
console.log(`[site]   /setup     → get started`)
console.log(`[site]   /docs/     → docs index`)
for (const d of DOCS_INDEX) console.log(`[site]   /docs/${d.slug.padEnd(14)} → ${d.file}`)
