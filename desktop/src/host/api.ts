import type { Config } from "./config.ts"
import { loadTokens, persistTokens, refreshTokens, type Tokens } from "./oauth.ts"

const ensureFreshToken = async (cfg: Config): Promise<string> => {
  const tokens = await loadTokens()
  if (!tokens) throw new Error("Not signed in")
  if (Date.now() < tokens.expires_at) return tokens.access_token
  const fresh = await refreshTokens(cfg, tokens.refresh_token)
  await persistTokens(fresh)
  return fresh.access_token
}

const apiFetch = async (cfg: Config, path: string, init: RequestInit = {}): Promise<Response> => {
  const token = await ensureFreshToken(cfg)
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${token}`)
  return fetch(`${cfg.serverUrl}${path}`, { ...init, headers })
}

export type Folder = { id: number; name: string; parent_id: number | null; kind?: string }
export type FileItem = { id: number; name: string; mime: string; size: number }
export type Share = { id: number; token: string; expires_at: string | null }

export const me = async (cfg: Config): Promise<{ id: number; username: string; email: string; name: string }> => {
  const res = await apiFetch(cfg, "/me")
  if (!res.ok) throw new Error(`/me failed: HTTP ${res.status}`)
  return await res.json() as any
}

export const ensureScreenshotsFolder = async (cfg: Config): Promise<number> => {
  const list = await apiFetch(cfg, "/folders?parent_id=null")
  if (!list.ok) throw new Error(`Could not list folders: HTTP ${list.status}`)
  const folders = await list.json() as Folder[]
  const existing = folders.find(f => f.kind === "screenshots")
  if (existing) return existing.id

  const create = await apiFetch(cfg, "/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Screenshots", parent_id: null, kind: "screenshots" }),
  })
  if (!create.ok) throw new Error(`Could not create Screenshots folder: HTTP ${create.status}`)
  const j = await create.json() as { id: number }
  return j.id
}

export const uploadFile = async (
  cfg: Config,
  bytes: Uint8Array,
  filename: string,
  folderId: number,
  mime = "image/png",
): Promise<FileItem> => {
  const form = new FormData()
  form.append(filename, new Blob([bytes as BlobPart], { type: mime }), filename)
  form.append("folder_id", String(folderId))
  const res = await apiFetch(cfg, "/files", { method: "POST", body: form })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Upload failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
  }
  const j = await res.json() as FileItem | FileItem[]
  return Array.isArray(j) ? j[0]! : j
}

export const createShare = async (
  cfg: Config,
  fileId: number,
  expiresInSeconds = 30 * 86400,
): Promise<Share> => {
  const res = await apiFetch(cfg, "/shares", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId, expires_in: expiresInSeconds }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Share failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
  }
  return await res.json() as Share
}

export const shareUrl = (cfg: Config, shareToken: string): string => {
  // /api → /
  const root = cfg.serverUrl.replace(/\/api\/?$/, "")
  return `${root}/s/${shareToken}`
}
