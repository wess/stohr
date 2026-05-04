import { mkdir, unlink } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import type { StorageDriver } from "../index.ts"

export type LocalConfig = { dir: string }

const safeJoin = (root: string, key: string): string => {
  const target = resolve(root, key)
  // Defense in depth: keys come from makeKey() so traversal shouldn't be
  // possible, but anchoring to the root means a malformed key can never
  // touch a file outside it.
  if (target === root || !target.startsWith(root + sep)) {
    throw new Error(`storage key escapes root: ${key}`)
  }
  return target
}

export const createLocalDriver = (cfg: LocalConfig): StorageDriver => {
  const root = resolve(cfg.dir)
  return {
    put: async (key, body) => {
      const path = safeJoin(root, key)
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, body)
    },
    get: async (key) => {
      const path = safeJoin(root, key)
      const file = Bun.file(path)
      if (!(await file.exists())) {
        throw new Error(`Storage download failed for key '${key}': file not found at ${path}`)
      }
      return new Response(file)
    },
    drop: async (key) => {
      const path = safeJoin(root, key)
      try {
        await unlink(path)
      } catch {
        // Tolerate missing files — matches the S3 driver, which treats 404 as success.
      }
    },
  }
}
