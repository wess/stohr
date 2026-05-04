import { createStore, download, remove, upload } from "@atlas/storage"
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
    get: (key) => download(store, key),
    drop: (key) => remove(store, key),
  }
}
