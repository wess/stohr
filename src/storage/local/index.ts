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
    get: async (key, range) => {
      const path = safeJoin(root, key)
      const file = Bun.file(path)
      if (!(await file.exists())) {
        throw new Error(`Storage download failed for key '${key}': file not found at ${path}`)
      }
      // BunFile.slice is lazy — it reads only the requested window off disk
      // rather than materializing the whole file. `end` is inclusive on the
      // wire, exclusive here.
      //
      // Take .stream() off the slice explicitly rather than handing the slice
      // to `new Response(...)`: the Response body stream honors the slice's
      // start offset but runs to EOF, ignoring the end bound, so a ranged
      // read came back with every byte from `start` onward while the headers
      // still advertised the requested length.
      if (range) {
        const slice = file.slice(range.start, range.end + 1)
        return new Response(slice.stream(), {
          headers: { "content-length": String(Math.max(0, range.end - range.start + 1)) },
        })
      }
      return new Response(file)
    },
    drop: async key => {
      const path = safeJoin(root, key)
      try {
        await unlink(path)
      } catch {
        // Tolerate missing files — matches the S3 driver, which treats 404 as success.
      }
    },
  }
}
