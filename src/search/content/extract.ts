// Text-extraction front door.
//
// We support a small set of common formats natively (plain text, markdown,
// HTML, CSV, JSON, source code), and shell out to system tools for the
// formats that need a parser (PDF via `pdftotext`, Office formats via
// `unzip` + XML). If the system tool isn't installed, we record a skip and
// move on — the file is still searchable by name + metadata.
//
// We cap extracted text at 1 MiB per file. Anything larger is truncated.
// Postgres handles 1 MiB tsvectors comfortably, and there are diminishing
// returns past that for natural-language search.

import { spawn } from "bun"

export const MAX_TEXT_BYTES = 1024 * 1024

export type ExtractResult =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "skip"; reason: string }
  | { kind: "error"; reason: string }

const isPlainText = (mime: string, name: string): boolean => {
  if (mime.startsWith("text/")) return true
  if (mime === "application/json") return true
  if (mime === "application/xml") return true
  if (mime === "application/x-yaml" || mime === "application/yaml") return true
  if (mime === "application/javascript" || mime === "application/typescript") return true
  // Fall back to extension sniffing for common source/text types when the
  // upload was tagged application/octet-stream.
  const lower = name.toLowerCase()
  return /\.(md|markdown|txt|log|csv|tsv|json|yaml|yml|xml|html?|toml|ini|conf|sh|bash|zsh|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql)$/.test(lower)
}

const stripHtml = (s: string): string =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

const isHtml = (mime: string, name: string): boolean => {
  if (mime === "text/html" || mime === "application/xhtml+xml") return true
  return /\.html?$/i.test(name)
}

const isPdf = (mime: string, name: string): boolean => {
  if (mime === "application/pdf") return true
  return /\.pdf$/i.test(name)
}

type OfficeKind = "docx" | "xlsx" | "pptx" | null

const officeKind = (mime: string, name: string): OfficeKind => {
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(name)) return "docx"
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || /\.xlsx$/i.test(name)) return "xlsx"
  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || /\.pptx$/i.test(name)) return "pptx"
  return null
}

const truncate = (raw: string): { text: string; truncated: boolean } => {
  if (raw.length <= MAX_TEXT_BYTES) return { text: raw, truncated: false }
  return { text: raw.slice(0, MAX_TEXT_BYTES), truncated: true }
}

const decode = (bytes: Uint8Array): string => {
  // Try UTF-8 first, fall back to latin1 — every byte sequence decodes as
  // latin1, so this never throws even on malformed text.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("latin1").decode(bytes)
  }
}

const runCmd = async (cmd: string[], stdin: Uint8Array | null): Promise<{ stdout: Uint8Array; ok: boolean; error?: string }> => {
  try {
    const proc = spawn(cmd, {
      stdin: stdin ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (stdin && proc.stdin) {
      const writer = proc.stdin as unknown as { write: (b: Uint8Array) => Promise<number>; end: () => Promise<void> }
      await writer.write(stdin)
      await writer.end()
    }
    const out = await new Response(proc.stdout).arrayBuffer()
    const err = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code !== 0) return { stdout: new Uint8Array(out), ok: false, error: err.slice(0, 500) || `exit ${code}` }
    return { stdout: new Uint8Array(out), ok: true }
  } catch (err) {
    return { stdout: new Uint8Array(), ok: false, error: (err as Error).message }
  }
}

const extractPdf = async (bytes: Uint8Array): Promise<ExtractResult> => {
  // pdftotext (poppler-utils): `pdftotext -enc UTF-8 -layout -nopgbrk - -`
  // reads from stdin and writes UTF-8 plain text to stdout.
  const res = await runCmd(["pdftotext", "-enc", "UTF-8", "-nopgbrk", "-", "-"], bytes)
  if (!res.ok) {
    if (res.error && /command not found|No such file/i.test(res.error)) {
      return { kind: "skip", reason: "pdftotext not installed (poppler-utils)" }
    }
    return { kind: "error", reason: res.error ?? "pdftotext failed" }
  }
  const text = decode(res.stdout)
  const { text: clamped, truncated } = truncate(text)
  return { kind: "text", text: clamped, truncated }
}

// Strip XML markup. Office documents store their textual content as
// runs nested under <w:t>, <a:t>, or <t> elements depending on the format,
// but the cheapest robust extractor is to pull every visible #PCDATA span
// from the whole archive.
const xmlText = (xml: string): string =>
  xml
    .replace(/<\?xml[^?]*\?>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

const extractOffice = async (kind: "docx" | "xlsx" | "pptx", bytes: Uint8Array): Promise<ExtractResult> => {
  // Office Open XML is a zip archive. We `unzip -p <archive> <member>` for
  // the members that contain user-visible text, concatenate, then strip
  // markup. The member layout differs per format.
  const members =
    kind === "docx" ? ["word/document.xml", "word/header*.xml", "word/footer*.xml", "word/footnotes.xml", "word/endnotes.xml"]
    : kind === "xlsx" ? ["xl/sharedStrings.xml", "xl/worksheets/sheet*.xml"]
    : ["ppt/slides/slide*.xml", "ppt/notesSlides/notesSlide*.xml"]

  const parts: string[] = []
  for (const member of members) {
    const res = await runCmd(["unzip", "-p", "-", member], bytes)
    if (!res.ok) {
      if (res.error && /command not found|No such file/i.test(res.error)) {
        return { kind: "skip", reason: "unzip not installed" }
      }
      // unzip exits non-zero when a member is missing — that's fine,
      // headers/footers are optional.
      continue
    }
    if (res.stdout.length > 0) parts.push(decode(res.stdout))
  }
  if (parts.length === 0) {
    return { kind: "text", text: "", truncated: false }
  }
  const joined = parts.map(xmlText).filter(Boolean).join(" ")
  const { text, truncated } = truncate(joined)
  return { kind: "text", text, truncated }
}

export const extractText = async (
  bytes: Uint8Array,
  meta: { mime: string; name: string },
): Promise<ExtractResult> => {
  if (bytes.length === 0) return { kind: "text", text: "", truncated: false }

  // HTML is checked before generic text/* so we strip the markup instead
  // of indexing raw tags. Same for PDF and Office formats.
  if (isHtml(meta.mime, meta.name)) {
    const html = decode(bytes)
    const { text, truncated } = truncate(stripHtml(html))
    return { kind: "text", text, truncated }
  }
  if (isPdf(meta.mime, meta.name)) {
    return extractPdf(bytes)
  }
  const office = officeKind(meta.mime, meta.name)
  if (office) {
    return extractOffice(office, bytes)
  }
  if (isPlainText(meta.mime, meta.name)) {
    const text = decode(bytes)
    const { text: clamped, truncated } = truncate(text)
    return { kind: "text", text: clamped, truncated }
  }
  return { kind: "skip", reason: `Unsupported type: ${meta.mime || meta.name}` }
}
