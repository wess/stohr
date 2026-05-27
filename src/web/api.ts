const BASE = "/api"

export type AuthUser = { id: number; email: string; username: string; name: string; is_owner: boolean }

let token: string | null = localStorage.getItem("stohr_token")
let user: AuthUser | null = (() => {
  const raw = localStorage.getItem("stohr_user")
  return raw ? JSON.parse(raw) : null
})()

const headers = (extra: Record<string, string> = {}) => {
  const h: Record<string, string> = { ...extra }
  if (token) h.authorization = `Bearer ${token}`
  return h
}

const jsonReq = async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers({ "content-type": "application/json" }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  return res.json()
}

export const setToken = (t: string | null, u: AuthUser | null = null) => {
  token = t
  user = u
  if (t) localStorage.setItem("stohr_token", t)
  else localStorage.removeItem("stohr_token")
  if (u) localStorage.setItem("stohr_user", JSON.stringify(u))
  else localStorage.removeItem("stohr_user")
}

export const getToken = () => token
export const getUser = () => user

export const signup = async (input: {
  name: string
  username: string
  email: string
  password: string
  inviteToken?: string
}) => {
  const data = await jsonReq("POST", "/signup", {
    name: input.name,
    username: input.username,
    email: input.email,
    password: input.password,
    invite_token: input.inviteToken,
  })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
  return data
}

export const login = async (identity: string, password: string) => {
  const data = await jsonReq("POST", "/login", { identity, password })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
  return data as {
    id?: number; email?: string; username?: string; name?: string; is_owner?: boolean
    token?: string
    mfa_required?: boolean; mfa_token?: string
    error?: string; retry_after?: number
  }
}

export const loginMfa = async (mfaToken: string, opts: { code?: string; backupCode?: string }) => {
  const data = await jsonReq("POST", "/login/mfa", {
    mfa_token: mfaToken,
    ...(opts.code ? { code: opts.code } : {}),
    ...(opts.backupCode ? { backup_code: opts.backupCode } : {}),
  })
  if (data.token) setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
  return data
}

export const getMfaStatus = () => jsonReq("GET", "/me/mfa")
export const listSessions = () => jsonReq("GET", "/me/sessions")
export const revokeSession = (id: string) => jsonReq("DELETE", `/me/sessions/${encodeURIComponent(id)}`)
export const revokeOtherSessions = () => jsonReq("POST", "/me/sessions/revoke-others", {})
export const startMfaSetup = () => jsonReq("POST", "/me/mfa/setup", {})
export const enableMfa = (code: string) => jsonReq("POST", "/me/mfa/enable", { code })
export const disableMfa = (password: string, code: string) => jsonReq("POST", "/me/mfa/disable", { password, code })
export const regenerateBackupCodes = (password: string) => jsonReq("POST", "/me/mfa/backup-codes", { password })

export const checkInvite = async (token: string) => {
  const res = await fetch(`${BASE}/invites/${encodeURIComponent(token)}/check`)
  return res.json()
}

export type ContactMessageStatus = "new" | "read" | "handled" | "spam"

export type ContactMessage = {
  id: number
  name: string
  email: string
  subject: string
  message: string
  status: ContactMessageStatus
  ip: string | null
  user_agent: string | null
  handled_by: number | null
  handled_by_user: { id: number; username: string; name: string } | null
  handled_at: string | null
  created_at: string
}

export const submitContact = async (input: {
  name: string
  email: string
  subject: string
  message: string
  hp?: string
}) => {
  // Public endpoint — no auth header. The server treats a non-empty `hp`
  // (honeypot) as a silent success without storing the message.
  const res = await fetch(`${BASE}/contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  return res.json() as Promise<{ ok?: boolean; error?: string; retry_after?: number }>
}

export const adminListContact = (status: ContactMessageStatus | "all" = "all") =>
  jsonReq("GET", `/admin/contact?status=${status}`) as Promise<{
    items: ContactMessage[]
    counts: Record<ContactMessageStatus, number>
    limit: number
    offset: number
  }>

export const adminUpdateContact = (id: number, status: ContactMessageStatus) =>
  jsonReq("PATCH", `/admin/contact/${id}`, { status }) as Promise<{ id: number; status: ContactMessageStatus; error?: string }>

export const adminDeleteContact = (id: number) =>
  jsonReq("DELETE", `/admin/contact/${id}`) as Promise<{ deleted?: number; error?: string }>


export const getSetupStatus = async () => {
  const res = await fetch(`${BASE}/setup`)
  return res.json() as Promise<{ needsSetup: boolean }>
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

export const updateFolder = (id: number, patch: { kind?: "standard" | "photos" | "screenshots"; is_public?: boolean }) =>
  jsonReq("PATCH", `/folders/${id}`, patch)

export const createFolderTyped = (name: string, parentId: number | null, opts?: { kind?: "standard" | "photos" | "screenshots"; is_public?: boolean }) =>
  jsonReq("POST", "/folders", { name, parent_id: parentId, ...opts })

export const deleteFolder = (id: number) =>
  jsonReq("DELETE", `/folders/${id}`)

export const listFiles = (folderId: number | null, q?: string) => {
  const qs = q ? `q=${encodeURIComponent(q)}` : `folder_id=${folderId ?? "null"}`
  return jsonReq("GET", `/files?${qs}`)
}

export type UploadHandle = {
  promise: Promise<any>
  abort: () => void
}

export const uploadFile = (
  file: File,
  folderId: number | null,
  onProgress?: (loaded: number, total: number) => void,
): UploadHandle => {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<any>((resolve, reject) => {
    const form = new FormData()
    form.append(file.name, file)
    if (folderId != null) form.append("folder_id", String(folderId))

    xhr.open("POST", `${BASE}/files`)
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`)

    xhr.upload.addEventListener("progress", e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    })
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error("Invalid server response"))
        }
      } else {
        let msg = `HTTP ${xhr.status}`
        try {
          const body = JSON.parse(xhr.responseText)
          if (body?.error) msg = body.error
        } catch {}
        reject(new Error(msg))
      }
    })
    xhr.addEventListener("error", () => reject(new Error("Network error")))
    xhr.addEventListener("abort", () => reject(new Error("Aborted")))

    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}

export const getFile = (id: number) =>
  jsonReq("GET", `/files/${id}`)

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

export const createShare = (
  fileId: number,
  opts: { expiresIn: number; password?: string; burnOnView?: boolean },
) =>
  jsonReq("POST", "/shares", {
    file_id: fileId,
    expires_in: opts.expiresIn,
    ...(opts.password ? { password: opts.password } : {}),
    ...(opts.burnOnView ? { burn_on_view: true } : {}),
  })

export const deleteShare = (id: number) =>
  jsonReq("DELETE", `/shares/${id}`)

export const shareMeta = async (token: string) => {
  const res = await fetch(`${BASE}/s/${token}?meta=1`)
  return res.json() as Promise<{
    name?: string
    size?: number
    mime?: string
    created_at?: string
    expires_at?: string | null
    password_required?: boolean
    burn_on_view?: boolean
    error?: string
  }>
}

export const fetchShare = async (token: string, password?: string, inline = false) => {
  const url = `${BASE}/s/${token}${inline ? "?inline=1" : ""}`
  const headers: Record<string, string> = {}
  if (password) headers["x-share-password"] = password
  return fetch(url, { headers })
}

export const updateProfile = async (patch: { name?: string; email?: string; username?: string }) => {
  const data = await jsonReq("PATCH", "/me", patch)
  if (data.token) setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
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

export const search = (q: string, limit?: number, signal?: AbortSignal) => {
  const qs = limit !== undefined
    ? `q=${encodeURIComponent(q)}&limit=${limit}`
    : `q=${encodeURIComponent(q)}`
  return jsonReq("GET", `/search?${qs}`, undefined, signal)
}

export const listVersions = (fileId: number) =>
  jsonReq("GET", `/files/${fileId}/versions`)

export const versionDownloadUrl = (fileId: number, version: number) =>
  `${BASE}/files/${fileId}/versions/${version}/download`

export const restoreVersion = (fileId: number, version: number) =>
  jsonReq("POST", `/files/${fileId}/versions/${version}/restore`)

export const deleteVersion = (fileId: number, version: number) =>
  jsonReq("DELETE", `/files/${fileId}/versions/${version}`)

export const listInvites = () =>
  jsonReq("GET", "/invites")

export const createInvite = (email?: string) =>
  jsonReq("POST", "/invites", { email: email || undefined })

export const revokeInvite = (id: number) =>
  jsonReq("DELETE", `/invites/${id}`)

export const listSharedWithMe = () =>
  jsonReq("GET", "/shared")

export const listFolderCollabs = (id: number) =>
  jsonReq("GET", `/folders/${id}/collaborators`)

export const listFileCollabs = (id: number) =>
  jsonReq("GET", `/files/${id}/collaborators`)

export const addFolderCollab = (id: number, identity: string, role: "viewer" | "editor") =>
  jsonReq("POST", `/folders/${id}/collaborators`, { identity, role })

export const addFileCollab = (id: number, identity: string, role: "viewer" | "editor") =>
  jsonReq("POST", `/files/${id}/collaborators`, { identity, role })

export const removeFolderCollab = (id: number, collabId: number) =>
  jsonReq("DELETE", `/folders/${id}/collaborators/${collabId}`)

export const removeFileCollab = (id: number, collabId: number) =>
  jsonReq("DELETE", `/files/${id}/collaborators/${collabId}`)

export const adminListUsers = () =>
  jsonReq("GET", "/admin/users")

export const adminSetOwner = (id: number, isOwner: boolean) =>
  jsonReq("POST", `/admin/users/${id}/owner`, { is_owner: isOwner })

export const adminDeleteUser = (id: number) =>
  jsonReq("DELETE", `/admin/users/${id}`)

export const adminListAllInvites = (filter: "all" | "used" | "unused" = "all") =>
  jsonReq("GET", `/admin/invites?filter=${filter}`)

export const adminDeleteInvite = (id: number) =>
  jsonReq("DELETE", `/admin/invites/${id}`)

export const adminGetStats = () =>
  jsonReq("GET", "/admin/stats")

export const oauthAuthorizeInfo = (query: string) =>
  fetch(`${BASE}/oauth/authorize/info${query}`, { headers: headers() }).then(r => r.json())

export const oauthAuthorizeApprove = (params: Record<string, string>) =>
  jsonReq("POST", "/oauth/authorize/approve", params)

export const oauthAuthorizeDeny = (params: Record<string, string>) =>
  jsonReq("POST", "/oauth/authorize/deny", params)

export const oauthDeviceInfo = (userCode: string) =>
  jsonReq("GET", `/oauth/device/info?user_code=${encodeURIComponent(userCode)}`)

export const oauthDeviceApprove = (userCode: string) =>
  jsonReq("POST", "/oauth/device/approve", { user_code: userCode })

export const oauthDeviceDeny = (userCode: string) =>
  jsonReq("POST", "/oauth/device/deny", { user_code: userCode })

export const adminListOAuthClients = () =>
  jsonReq("GET", "/admin/oauth/clients")

export const adminCreateOAuthClient = (input: {
  name: string
  description?: string
  icon_url?: string
  redirect_uris: string[]
  allowed_scopes: string[]
  is_official?: boolean
  is_public_client?: boolean
}) =>
  jsonReq("POST", "/admin/oauth/clients", input)

export const adminRevokeOAuthClient = (id: number) =>
  jsonReq("DELETE", `/admin/oauth/clients/${id}`)

export const adminRotateOAuthClientSecret = (id: number) =>
  jsonReq("POST", `/admin/oauth/clients/${id}/rotate-secret`, {})

export const adminListAuditEvents = (filters: { event?: string; userId?: number; limit?: number } = {}) => {
  const qs = new URLSearchParams()
  if (filters.event) qs.set("event", filters.event)
  if (filters.userId !== undefined) qs.set("user_id", String(filters.userId))
  if (filters.limit !== undefined) qs.set("limit", String(filters.limit))
  const tail = qs.toString()
  return jsonReq("GET", `/admin/audit${tail ? `?${tail}` : ""}`)
}

export const getMyUsage = () =>
  jsonReq("GET", "/me/usage")

export const adminSetUserQuota = (id: number, quotaBytes: number) =>
  jsonReq("POST", `/admin/users/${id}/quota`, { quota_bytes: quotaBytes })

export type AdminSetting = {
  key: string
  value: unknown
  type: "boolean"
  description: string
  default: unknown
  updated_by: number | null
  updated_at: string | null
}

export const adminGetSettings = () =>
  jsonReq("GET", "/admin/settings") as Promise<AdminSetting[]>

export const adminUpdateSettings = (updates: Record<string, unknown>) =>
  jsonReq("PATCH", "/admin/settings", updates)

// ──────────────── MCP (Model Context Protocol) ────────────────

export type McpPreview = {
  enabled: boolean
  endpoint: string
  advertised_tools: Array<{ name: string; category: "read" | "write" | "delete" | "share"; description: string }>
  hidden_tools: Array<{ name: string; category: "read" | "write" | "delete" | "share" }>
}

export const adminGetMcpPreview = () =>
  jsonReq("GET", "/admin/mcp/preview") as Promise<McpPreview>

export type McpServer = {
  id: number
  name: string
  description: string | null
  url: string
  has_auth_token: boolean
  enabled: boolean
  created_by: number | null
  created_at: string
  updated_at: string
}

export const adminListMcpServers = () =>
  jsonReq("GET", "/admin/mcp/servers") as Promise<McpServer[]>

export const adminCreateMcpServer = (body: { name: string; description?: string; url: string; auth_token?: string | null; enabled?: boolean }) =>
  jsonReq("POST", "/admin/mcp/servers", body) as Promise<McpServer>

export const adminUpdateMcpServer = (id: number, body: { name?: string; description?: string | null; url?: string; auth_token?: string | null; enabled?: boolean }) =>
  jsonReq("PATCH", `/admin/mcp/servers/${id}`, body) as Promise<McpServer>

export const adminDeleteMcpServer = (id: number) =>
  jsonReq("DELETE", `/admin/mcp/servers/${id}`) as Promise<{ deleted: number } | { error: string }>

export const adminProbeMcpServer = (id: number) =>
  jsonReq("POST", `/admin/mcp/servers/${id}/probe`, {}) as Promise<{ ok: boolean; tools?: Array<{ name: string; description: string }>; error?: string }>

export type WebdavStatus = {
  enabled: boolean
  last_used_at: string | null
  updated_at: string | null
  password?: string  // only present on POST response
}

export const getWebdav = () =>
  jsonReq("GET", "/me/webdav") as Promise<WebdavStatus>

export const enableWebdav = () =>
  jsonReq("POST", "/me/webdav", {}) as Promise<WebdavStatus>

export const disableWebdav = () =>
  jsonReq("DELETE", "/me/webdav") as Promise<{ disabled: boolean }>

// ──────────────── Federation ────────────────

export type FederationType = "content-sharing" | "space-offering"

export type FederationSummary = {
  id: number
  slug: string
  name: string
  description: string | null
  type: FederationType
  public_key: string
  replication_factor: number
  erasure_k: number | null
  erasure_m: number | null
  quota_multiplier: string
  created_at: string
  local_member: {
    is_admin: boolean
    contributed_bytes: number | string
    used_bytes: number | string
    status: "active" | "draining" | "left"
  }
}

export type FederationDetail = {
  id: number
  slug: string
  name: string
  description: string | null
  type: FederationType
  public_key: string
  public_key_raw: string
  replication_factor: number
  erasure_k: number | null
  erasure_m: number | null
  quota_multiplier: string
  is_admin: boolean
  contributed_bytes: number
  used_bytes: number
  status: "active" | "draining" | "left"
  created_at: string
}

export type FederationMember = {
  id: number
  peer_pubkey: string
  peer_base_url: string
  display_name: string | null
  is_local: boolean
  is_admin: boolean
  contributed_bytes: number
  used_bytes: number
  status: "active" | "draining" | "left"
  joined_at: string
  last_seen_at: string | null
}

export type FederationInvite = {
  id: number
  expires_at: string
  used_at: string | null
  used_by_pubkey: string | null
  created_by: number | null
  created_at: string
}

export type FederationUsage = {
  federation_id: number
  contributed_bytes: number
  used_bytes: number
  quota_multiplier: number
  allowance_bytes: number
  available_bytes: number
}

export type InstanceKeys = {
  ed25519_pubkey: string
  x25519_pubkey: string
}

export const listFederations = () =>
  jsonReq("GET", "/me/federations") as Promise<FederationSummary[]>

export const createFederation = (input: {
  slug: string
  name: string
  description?: string
  type: FederationType
  replication_factor?: number
  erasure_k?: number
  erasure_m?: number
  quota_multiplier?: number
}) =>
  jsonReq("POST", "/me/federations", input)

export const getFederation = (id: number) =>
  jsonReq("GET", `/me/federations/${id}`) as Promise<FederationDetail>

export const leaveFederation = (id: number) =>
  jsonReq("DELETE", `/me/federations/${id}`)

export const listFederationMembers = (id: number) =>
  jsonReq("GET", `/me/federations/${id}/members`) as Promise<FederationMember[]>

export const mintFederationInvite = (id: number, ttlHours?: number) =>
  jsonReq("POST", `/me/federations/${id}/invites`, ttlHours ? { ttl_hours: ttlHours } : {}) as Promise<{ token: string; expires_at: string }>

export const listFederationInvites = (id: number) =>
  jsonReq("GET", `/me/federations/${id}/invites`) as Promise<FederationInvite[]>

export const revokeFederationInvite = (id: number, inviteId: number) =>
  jsonReq("DELETE", `/me/federations/${id}/invites/${inviteId}`)

export const acceptFederationInvite = (token: string, displayName?: string) =>
  jsonReq("POST", "/me/federations/accept", { invite: token, display_name: displayName })

export const getFederationUsage = (id: number) =>
  jsonReq("GET", `/me/federations/${id}/usage`) as Promise<FederationUsage>

export const setFederationContribution = (id: number, folderId: number, quotaBytes: number) =>
  jsonReq("POST", `/me/federations/${id}/folders/${folderId}/contribute`, { quota_bytes: quotaBytes })

export const updateFederationContribution = (id: number, folderId: number, quotaBytes: number) =>
  jsonReq("PATCH", `/me/federations/${id}/folders/${folderId}/contribute`, { quota_bytes: quotaBytes })

export const releaseFederationContribution = (id: number, folderId: number) =>
  jsonReq("DELETE", `/me/federations/${id}/folders/${folderId}/contribute`)

export const createFederationMount = (id: number, name?: string, parentId?: number | null) =>
  jsonReq("POST", `/me/federations/${id}/folders/mount`, { name, parent_id: parentId })

export const getInstanceKeys = () =>
  jsonReq("GET", "/me/federations/instance/keys") as Promise<InstanceKeys>

// Lightweight "is this feature on for me?" probe. Returns true when the
// owner has enabled the feature on the instance, false when they haven't.
// Implementation: hit the list endpoint and look at the response shape.
// A normal response is an array (possibly empty). A disabled feature
// responds 503 with `{ error: "... disabled on this instance ..." }`, which
// jsonReq surfaces as the parsed body (not an exception).
export const federationAvailable = async (): Promise<boolean> => {
  try {
    const res = await jsonReq("GET", "/me/federations") as unknown
    return Array.isArray(res)
  } catch { return false }
}

export const listS3Keys = () =>
  jsonReq("GET", "/me/s3-keys")

export const createS3Key = (name?: string) =>
  jsonReq("POST", "/me/s3-keys", { name })

export const revokeS3Key = (id: number) =>
  jsonReq("DELETE", `/me/s3-keys/${id}`)

export const listApps = () =>
  jsonReq("GET", "/me/apps")

export const createApp = (name: string, description?: string) =>
  jsonReq("POST", "/me/apps", { name, description })

export const revokeApp = (id: number) =>
  jsonReq("DELETE", `/me/apps/${id}`)

export const getPublicFolder = async (username: string, folderId: number) => {
  const res = await fetch(`${BASE}/p/${encodeURIComponent(username)}/${folderId}`)
  return res.json()
}

export const publicFileInlineUrl = (id: number) => `${BASE}/p/files/${id}?inline=1`
export const publicThumbUrl = (id: number) => `${BASE}/p/files/${id}/thumb`

/* Action folders */
export type ActionEventName =
  | "file.created" | "file.updated" | "file.deleted"
  | "file.moved.in" | "file.moved.out"
  | "folder.created" | "folder.updated" | "folder.deleted"
  | "folder.moved.in" | "folder.moved.out"

export type FolderActionRow = {
  id: number
  folder_id: number
  event: ActionEventName
  slug: string
  config: Record<string, unknown>
  enabled: boolean
  created_at: string
  updated_at: string
}

export const listFolderActions = (folderId: number) =>
  jsonReq("GET", `/folders/${folderId}/actions`) as Promise<FolderActionRow[]>

export const createFolderAction = (folderId: number, input: { event: ActionEventName; slug: string; config?: Record<string, unknown>; enabled?: boolean }) =>
  jsonReq("POST", `/folders/${folderId}/actions`, input) as Promise<FolderActionRow & { error?: string }>

export const updateFolderAction = (folderId: number, actionId: number, patch: { event?: ActionEventName; config?: Record<string, unknown>; enabled?: boolean }) =>
  jsonReq("PATCH", `/folders/${folderId}/actions/${actionId}`, patch) as Promise<FolderActionRow & { error?: string }>

export const deleteFolderAction = (folderId: number, actionId: number) =>
  jsonReq("DELETE", `/folders/${folderId}/actions/${actionId}`) as Promise<{ deleted?: number; error?: string }>

/* User-built Actions (Action Builder) */

export type PrimitiveCategory = "filter" | "transform" | "route"
export type PrimitiveDescriptor = {
  kind: string
  name: string
  category: PrimitiveCategory
  description: string
  icon: string
  subjects: ("file" | "folder")[]
  config_schema: Record<string, unknown>
}

export type Step = { kind: string; config: Record<string, unknown> }

export type UserAction = {
  id: number
  slug: string
  name: string
  description: string | null
  icon: string | null
  triggers: ActionEventName[]
  steps: Step[]
  enabled: boolean
  forked_from: string | null
  is_builtin: false
  editable: true
  created_at: string
  updated_at: string
}

export const listPrimitives = () =>
  jsonReq("GET", "/actions/primitives") as Promise<{ primitives: PrimitiveDescriptor[]; total: number }>

export const listUserActions = () =>
  jsonReq("GET", "/me/actions") as Promise<UserAction[]>

export const getUserAction = (id: number) =>
  jsonReq("GET", `/me/actions/${id}`) as Promise<UserAction & { error?: string }>

export const createUserAction = (input: {
  name: string
  description?: string
  icon?: string
  triggers: ActionEventName[]
  steps: Step[]
  enabled?: boolean
}) =>
  jsonReq("POST", "/me/actions", input) as Promise<UserAction & { error?: string }>

export const updateUserAction = (id: number, patch: {
  name?: string
  description?: string | null
  icon?: string | null
  triggers?: ActionEventName[]
  steps?: Step[]
  enabled?: boolean
}) =>
  jsonReq("PATCH", `/me/actions/${id}`, patch) as Promise<UserAction & { error?: string }>

export const deleteUserAction = (id: number) =>
  jsonReq("DELETE", `/me/actions/${id}`) as Promise<{ deleted?: number; error?: string }>

export const cloneBuiltin = (slug: string) =>
  jsonReq("POST", `/me/actions/from-builtin/${slug.replace(/^stohr\//, "")}`, {}) as Promise<UserAction & { error?: string }>

/* Password reset */
export const requestPasswordReset = (email: string) =>
  jsonReq("POST", "/password/forgot", { email }) as Promise<{ ok?: boolean; message?: string; error?: string }>

export const resetPassword = (token: string, newPassword: string) =>
  jsonReq("POST", "/password/reset", { token, new_password: newPassword }) as Promise<{ ok?: boolean; error?: string }>

/* Passkeys (WebAuthn) */
export type Passkey = {
  id: number
  name: string | null
  transports: string[]
  last_used_at: string | null
  created_at: string
}

export const listPasskeys = () =>
  jsonReq("GET", "/me/passkeys") as Promise<Passkey[]>

export const beginPasskeyRegistration = () =>
  jsonReq("POST", "/me/passkeys/register/start", {}) as Promise<any>

export const finishPasskeyRegistration = (input: { name?: string; response: any }) =>
  jsonReq("POST", "/me/passkeys/register/finish", input) as Promise<Passkey & { error?: string }>

export const renamePasskey = (id: number, name: string | null) =>
  jsonReq("PATCH", `/me/passkeys/${id}`, { name }) as Promise<{ ok?: boolean; error?: string }>

export const deletePasskey = (id: number) =>
  jsonReq("DELETE", `/me/passkeys/${id}`) as Promise<{ deleted?: number; error?: string }>

export const beginPasskeyDiscoverableLogin = () =>
  jsonReq("POST", "/login/passkey/discover/start", {}) as Promise<any>

export const finishPasskeyDiscoverableLogin = async (response: any) => {
  const data = await jsonReq("POST", "/login/passkey/discover/finish", { response })
  if (data.token) {
    setToken(data.token, { id: data.id, email: data.email, username: data.username, name: data.name, is_owner: !!data.is_owner })
  }
  return data as {
    id?: number; email?: string; username?: string; name?: string; is_owner?: boolean
    token?: string; error?: string
  }
}

