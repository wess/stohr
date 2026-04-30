import { mkdirSync } from "node:fs"
import { join } from "node:path"

// XDG-respecting cache root. Override with $BAI_CACHE_DIR if you want
// to share a cache between users or pin a model directory.
const root = (): string => {
  if (process.env.BAI_CACHE_DIR) return process.env.BAI_CACHE_DIR
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "bai")
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  return join(home, ".cache", "bai")
}

export const cacheRoot = (): string => {
  const r = root()
  mkdirSync(r, { recursive: true })
  return r
}

export const modelsCacheDir = (): string => {
  const d = join(cacheRoot(), "models")
  mkdirSync(d, { recursive: true })
  return d
}

export const libCacheDir = (): string => {
  const d = join(cacheRoot(), "lib")
  mkdirSync(d, { recursive: true })
  return d
}
