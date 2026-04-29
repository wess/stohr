import { randomBytes } from "node:crypto"
import { createStore, download, presign, remove, upload } from "@atlas/storage"
import type { Store } from "@atlas/storage"

export type StorageHandle = Store

export const createStorage = (opts: {
  endpoint: string
  bucket: string
  region?: string
  accessKey: string
  secretKey: string
}): StorageHandle => createStore(opts)

export const put = (store: StorageHandle, key: string, body: Blob | Uint8Array | string, contentType?: string) =>
  upload(store, { key, body, contentType })

export const fetchObject = (store: StorageHandle, key: string) =>
  download(store, key)

export const drop = (store: StorageHandle, key: string) =>
  remove(store, key)

export const signedUrl = (store: StorageHandle, key: string, expiresSeconds = 900) =>
  presign(store, key, { expires: expiresSeconds, method: "GET" })

export const makeKey = (userId: number, name: string) => {
  const stamp = Date.now().toString(36)
  // 8 hex chars (32 bits) of cryptographic randomness — keys aren't capabilities,
  // but using crypto-grade randomness avoids ever leaking RNG state.
  const rand = randomBytes(4).toString("hex")
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_")
  return `u${userId}/${stamp}${rand}/${safe}`
}
