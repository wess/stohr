import { createWriteStream, existsSync, statSync } from "node:fs"
import { rename, unlink } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { dirname, join } from "node:path"
import { mkdirSync } from "node:fs"

// Stream a remote file to disk through a `.partial` suffix, then rename.
// Crash-safe: an interrupted run leaves a `.partial` you can resume from
// (the resumeFrom argument requests a Range header).

export type DownloadOptions = {
  readonly url: string
  readonly destPath: string
  readonly onProgress?: (bytesDone: number, bytesTotal: number | null) => void
  readonly resume?: boolean
}

export const download = async (opts: DownloadOptions): Promise<void> => {
  mkdirSync(dirname(opts.destPath), { recursive: true })

  const partial = `${opts.destPath}.partial`
  const resumeFrom = opts.resume && existsSync(partial) ? statSync(partial).size : 0

  const headers: Record<string, string> = {
    "user-agent": "bai/0.0.1 (model-puller)",
    accept: "*/*",
  }
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`

  const res = await fetch(opts.url, { headers, redirect: "follow" })
  if (!res.ok && !(resumeFrom > 0 && res.status === 416)) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${opts.url}`)
  }
  if (!res.body) throw new Error(`download failed: empty body for ${opts.url}`)

  const total = (() => {
    const len = res.headers.get("content-length")
    const range = res.headers.get("content-range")
    if (range) {
      const m = /\/(\d+)$/.exec(range)
      if (m && m[1]) return Number(m[1])
    }
    return len ? Number(len) + resumeFrom : null
  })()

  let done = resumeFrom
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      done += chunk.byteLength
      opts.onProgress?.(done, total)
      controller.enqueue(chunk)
    },
  })

  const out = createWriteStream(partial, { flags: resumeFrom > 0 ? "a" : "w" })
  const piped = res.body.pipeThrough(tap)
  await pipeline(Readable.fromWeb(piped as never), out)
  await rename(partial, opts.destPath)
}

export const cleanupPartial = async (destPath: string): Promise<void> => {
  const partial = `${destPath}.partial`
  if (existsSync(partial)) {
    try { await unlink(partial) } catch { /* best-effort */ }
  }
}

// HuggingFace public-file URL builder — used by the model registry.
export const hfUrl = (repo: string, file: string, branch = "main"): string =>
  `https://huggingface.co/${repo}/resolve/${branch}/${file}`

export const hfDest = (modelsDir: string, cacheName: string): string =>
  join(modelsDir, cacheName)
