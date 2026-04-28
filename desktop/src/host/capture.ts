import { $ } from "bun"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "./config.ts"
import { createShare, ensureScreenshotsFolder, shareUrl, uploadFile } from "./api.ts"

const stampForFilename = (d: Date): string => {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
}

export type CaptureMode = "region" | "window" | "screen"

const tempPng = (): string =>
  join(tmpdir(), `stohrshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)

/**
 * Trigger the OS-native interactive screenshot. macOS only for now via
 * `/usr/sbin/screencapture`. Returns the PNG bytes, or null if the user
 * cancelled (no file produced).
 */
export const grabScreenshot = async (mode: CaptureMode = "region"): Promise<{ bytes: Uint8Array; filename: string } | null> => {
  if (process.platform !== "darwin") {
    throw new Error("Screen capture is currently macOS-only")
  }
  const path = tempPng()
  const flag = mode === "region" ? "-i" : mode === "window" ? "-iW" : ""
  // -x suppresses the camera shutter sound.
  const result = flag
    ? await $`screencapture ${flag} -x ${path}`.nothrow().quiet()
    : await $`screencapture -x ${path}`.nothrow().quiet()
  // screencapture returns 0 even on cancel; check for the file.
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  if (file.size === 0) {
    await unlink(path).catch(() => {})
    return null
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  await unlink(path).catch(() => {})
  if (result.exitCode !== 0) return null
  const filename = `Screenshot ${stampForFilename(new Date())}.png`
  return { bytes, filename }
}

export type CaptureResult = {
  shareUrl: string
  fileId: number
  filename: string
}

/**
 * Full capture-and-share flow. Caller is responsible for surfacing errors
 * (e.g., notification + log).
 */
export const captureAndShare = async (cfg: Config, mode: CaptureMode = "region"): Promise<CaptureResult | null> => {
  const grabbed = await grabScreenshot(mode)
  if (!grabbed) return null
  const folderId = await ensureScreenshotsFolder(cfg)
  const file = await uploadFile(cfg, grabbed.bytes, grabbed.filename, folderId)
  const share = await createShare(cfg, file.id)
  return { shareUrl: shareUrl(cfg, share.token), fileId: file.id, filename: grabbed.filename }
}

export type RecentCapture = {
  filename: string
  shareUrl: string
  fileId: number
  createdAt: number
}

const recents: RecentCapture[] = []
const MAX_RECENTS = 10

export const remember = (entry: Omit<RecentCapture, "createdAt">): void => {
  recents.unshift({ ...entry, createdAt: Date.now() })
  if (recents.length > MAX_RECENTS) recents.length = MAX_RECENTS
}

export const listRecents = (): RecentCapture[] => recents.slice()
