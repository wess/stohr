const BASE = "/api"

let token: string | null = localStorage.getItem("stohr_token")
let user: { id: number; email: string; name: string } | null = (() => {
  const raw = localStorage.getItem("stohr_user")
  return raw ? JSON.parse(raw) : null
})()

const headers = (extra: Record<string, string> = {}) => {
  const h: Record<string, string> = { ...extra }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

const jsonReq = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers({ "content-type": "application/json" }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

export const setToken = (t: string | null, u: typeof user = null) => {
  token = t
  user = u
  if (t) localStorage.setItem("stohr_token", t)
  else localStorage.removeItem("stohr_token")
  if (u) localStorage.setItem("stohr_user", JSON.stringify(u))
  else localStorage.removeItem("stohr_user")
}

export const getToken = () => token
export const getUser = () => user

export const signup = async (name: string, email: string, password: string) => {
  const data = await jsonReq("POST", "/signup", { name, email, password })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, name: data.name })
  return data
}

export const login = async (email: string, password: string) => {
  const data = await jsonReq("POST", "/login", { email, password })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, name: data.name })
  return data
}

export const listFolders = (parentId: number | null) =>
  jsonReq("GET", `/folders?parent_id=${parentId ?? "null"}`)

export const getFolder = (id: number) =>
  jsonReq("GET", `/folders/${id}`)

export const createFolder = (name: string, parentId: number | null) =>
  jsonReq("POST", "/folders", { name, parent_id: parentId })

export const renameFolder = (id: number, name: string) =>
  jsonReq("PATCH", `/folders/${id}`, { name })

export const moveFolder = (id: number, parentId: number | null) =>
  jsonReq("PATCH", `/folders/${id}`, { parent_id: parentId })

export const deleteFolder = (id: number) =>
  jsonReq("DELETE", `/folders/${id}`)

export const listFiles = (folderId: number | null, q?: string) => {
  const qs = q ? `q=${encodeURIComponent(q)}` : `folder_id=${folderId ?? "null"}`
  return jsonReq("GET", `/files?${qs}`)
}

export const uploadFiles = async (files: FileList | File[], folderId: number | null) => {
  const form = new FormData()
  for (const f of Array.from(files)) form.append(f.name, f)
  if (folderId != null) form.append("folder_id", String(folderId))
  const res = await fetch(`${BASE}/files`, {
    method: "POST",
    headers: headers(),
    body: form,
  })
  return res.json()
}

export const renameFile = (id: number, name: string) =>
  jsonReq("PATCH", `/files/${id}`, { name })

export const moveFile = (id: number, folderId: number | null) =>
  jsonReq("PATCH", `/files/${id}`, { folder_id: folderId })

export const deleteFile = (id: number) =>
  jsonReq("DELETE", `/files/${id}`)

export const downloadUrl = (id: number) =>
  `${BASE}/files/${id}/download`

export const listShares = () =>
  jsonReq("GET", "/shares")

export const createShare = (fileId: number, expiresIn?: number) =>
  jsonReq("POST", "/shares", { file_id: fileId, expires_in: expiresIn })

export const deleteShare = (id: number) =>
  jsonReq("DELETE", `/shares/${id}`)

export const shareMeta = async (token: string) => {
  const res = await fetch(`${BASE}/s/${token}?meta=1`)
  return res.json()
}

export const shareDownloadUrl = (token: string) => `${BASE}/s/${token}`

export const getMe = () =>
  jsonReq("GET", "/me")

export const updateProfile = async (patch: { name?: string; email?: string }) => {
  const data = await jsonReq("PATCH", "/me", patch)
  if (data.token) setToken(data.token, { id: data.id, email: data.email, name: data.name })
  return data
}

export const changePassword = (current: string, next: string) =>
  jsonReq("POST", "/me/password", { current_password: current, new_password: next })

export const deleteAccount = async (password: string) => {
  const res = await fetch(`${BASE}/me`, {
    method: "DELETE",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ password }),
  })
  return res.json()
}

export const listTrash = () =>
  jsonReq("GET", "/trash")

export const emptyTrash = () =>
  jsonReq("DELETE", "/trash")

export const restoreFile = (id: number) =>
  jsonReq("POST", `/files/${id}/restore`)

export const restoreFolder = (id: number) =>
  jsonReq("POST", `/folders/${id}/restore`)

export const purgeFile = (id: number) =>
  jsonReq("DELETE", `/files/${id}/purge`)

export const purgeFolder = (id: number) =>
  jsonReq("DELETE", `/folders/${id}/purge`)

export const listVersions = (fileId: number) =>
  jsonReq("GET", `/files/${fileId}/versions`)

export const versionDownloadUrl = (fileId: number, version: number) =>
  `${BASE}/files/${fileId}/versions/${version}/download`

export const restoreVersion = (fileId: number, version: number) =>
  jsonReq("POST", `/files/${fileId}/versions/${version}/restore`)

export const deleteVersion = (fileId: number, version: number) =>
  jsonReq("DELETE", `/files/${fileId}/versions/${version}`)
