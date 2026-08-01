import { createStore, download, presign, remove, upload } from "@atlas/storage"
import type { StorageDriver } from "../index.ts"

export type S3Config = {
  endpoint: string
  bucket: string
  region?: string
  accessKey: string
  secretKey: string
}

export const createS3Driver = (cfg: S3Config): StorageDriver => {
  const store = createStore(cfg)
  return {
    put: async (key, body, contentType) => {
      await upload(store, { key, body, contentType })
    },
    // @atlas/storage's `download` signs the request itself but exposes no way
    // to attach headers, so a ranged read presigns a short-lived URL and adds
    // Range at fetch time. Presigning only covers `host`, so the extra header
    // doesn't invalidate the signature. The URL is used here and discarded —
    // it is never handed to a client.
    get: async (key, range) => {
      if (!range) return download(store, key)
      const url = presign(store, key, { expires: 60, method: "GET" })
      const res = await fetch(url, { headers: { range: `bytes=${range.start}-${range.end}` } })
      if (!res.ok) {
        throw new Error(`Storage ranged download failed for key '${key}': HTTP ${res.status}`)
      }
      return res
    },
    drop: key => remove(store, key),
  }
}
