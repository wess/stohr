// Build the static site into ./dist:
//   1. Bun.build the three React HTML entries (landing, developers, setup).
//   2. SSR each doc page from the project's docs/*.md files.
//   3. Copy the global stylesheet and assets.
// Output is a flat static tree ready for Cloudflare Pages.
import path from "node:path"
import { rm, mkdir, writeFile, readFile, copyFile, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { DOCS_INDEX, renderDocPage, renderDocsIndex } from "./docs/render"

const ROOT = path.resolve(import.meta.dir, "..")
const SRC = path.resolve(ROOT, "src")
const DIST = path.resolve(ROOT, "dist")
const REPO_ROOT = path.resolve(ROOT, "..")

const HTML_ENTRIES = ["index.html", "developers.html", "setup.html", "federation.html", "webdav.html"]

async function clean() {
  if (existsSync(DIST)) await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })
}

const STATIC_LINKS = `<link rel="icon" type="image/png" href="/assets/logo.png">
  <link rel="apple-touch-icon" href="/assets/logo.png">
  <link rel="stylesheet" href="/style.css">`

async function buildReactPages() {
  const entrypoints = HTML_ENTRIES.map(f => path.join(SRC, f))
  const result = await Bun.build({
    entrypoints,
    outdir: DIST,
    target: "browser",
    format: "esm",
    minify: true,
    splitting: true,
    sourcemap: "external",
    naming: {
      entry: "[name].[ext]",
      chunk: "_chunks/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  })
  if (!result.success) {
    console.error("[site] React build failed:")
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  // Inject the static <link> tags Bun would otherwise refuse to bundle.
  for (const name of HTML_ENTRIES) {
    const file = path.join(DIST, name)
    if (!existsSync(file)) continue
    const html = await readFile(file, "utf8")
    await writeFile(file, html.replace("<!-- STATIC_LINKS -->", STATIC_LINKS), "utf8")
  }
}

async function copyStylesheet() {
  await copyFile(path.join(SRC, "style.css"), path.join(DIST, "style.css"))
}

async function copyAssets() {
  const srcAssets = path.join(SRC, "assets")
  if (!existsSync(srcAssets)) return
  const dstAssets = path.join(DIST, "assets")
  await mkdir(dstAssets, { recursive: true })
  for (const name of await readdir(srcAssets)) {
    const s = await stat(path.join(srcAssets, name))
    if (s.isFile()) await copyFile(path.join(srcAssets, name), path.join(dstAssets, name))
  }
}

async function buildDocs() {
  const docsRoot = path.join(DIST, "docs")
  await mkdir(docsRoot, { recursive: true })

  await writeFile(path.join(docsRoot, "index.html"), renderDocsIndex(), "utf8")

  for (const entry of DOCS_INDEX) {
    const src = path.join(REPO_ROOT, entry.file)
    if (!existsSync(src)) {
      console.warn(`[site] WARN: ${entry.file} missing, skipping`)
      continue
    }
    const md = await readFile(src, "utf8")
    const html = renderDocPage(entry, md)
    const outDir = path.join(docsRoot, entry.slug)
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, "index.html"), html, "utf8")
  }
}

async function writeRedirects() {
  // Cloudflare Pages _redirects file. Send /docs (no trailing slash) to /docs/.
  const body = `/docs   /docs/   301
`
  await writeFile(path.join(DIST, "_redirects"), body, "utf8")
}

async function writeHeaders() {
  // Long-lived caching for hashed assets; everything else default.
  const body = `/_chunks/*
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`
  await writeFile(path.join(DIST, "_headers"), body, "utf8")
}

async function main() {
  console.log("[site] cleaning dist…")
  await clean()
  console.log("[site] copying stylesheet + assets…")
  await copyStylesheet()
  await copyAssets()
  console.log("[site] building React pages…")
  await buildReactPages()
  console.log("[site] rendering docs from markdown…")
  await buildDocs()
  await writeRedirects()
  await writeHeaders()
  console.log("[site] done — dist/")
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
