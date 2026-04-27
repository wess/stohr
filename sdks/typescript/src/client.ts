import type {
  ApiError,
  AuthResult,
  Collaborator,
  FileDetail,
  FileItem,
  FileVersion,
  Folder,
  FolderDetail,
  Invite,
  ResourceKind,
  S3AccessKey,
  Share,
  Subscription,
  User,
} from "./types.ts"

export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

export type ClientOptions = {
  baseUrl?: string
  token?: string
  fetch?: FetchFn
}

export type Client = ReturnType<typeof createClient>

const isError = (x: unknown): x is ApiError =>
  typeof x === "object" && x !== null && "error" in (x as Record<string, unknown>)

export const createClient = (options: ClientOptions = {}) => {
  const baseUrl = (options.baseUrl ?? "https://stohr.io/api").replace(/\/$/, "")
  const fetcher: FetchFn = options.fetch ?? ((url, init) => fetch(url as RequestInfo | URL, init))
  let token: string | null = options.token ?? null

  const headers = (extra: Record<string, string> = {}): Record<string, string> => {
    const h = { ...extra }
    if (token) h.authorization = `Bearer ${token}`
    return h
  }

  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetcher(`${baseUrl}${path}`, {
      method,
      headers: headers(body !== undefined ? { "content-type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as T | ApiError) : (null as unknown as T)
    if (!res.ok || isError(parsed)) {
      const msg = isError(parsed) ? parsed.error : `HTTP ${res.status}`
      throw new StohrError(msg, res.status, parsed as Record<string, unknown> | null)
    }
    return parsed
  }

  const setToken = (t: string | null) => { token = t }
  const getToken = () => token

  return {
    setToken,
    getToken,

    auth: {
      signup: async (input: {
        name: string
        username: string
        email: string
        password: string
        inviteToken?: string
      }): Promise<AuthResult> => {
        const data = await json<AuthResult>("POST", "/signup", {
          name: input.name,
          username: input.username,
          email: input.email,
          password: input.password,
          invite_token: input.inviteToken,
        })
        if (data.token) token = data.token
        return data
      },

      login: async (identity: string, password: string): Promise<AuthResult> => {
        const data = await json<AuthResult>("POST", "/login", { identity, password })
        if (data.token) token = data.token
        return data
      },
    },

    me: {
      get: () => json<User>("GET", "/me"),
      update: (patch: { name?: string; email?: string; username?: string }) =>
        json<AuthResult>("PATCH", "/me", patch),
      changePassword: (current: string, next: string) =>
        json<{ ok: true }>("POST", "/me/password", { current_password: current, new_password: next }),
      subscription: () => json<Subscription>("GET", "/me/subscription"),
    },

    folders: {
      list: (parentId: number | null = null) =>
        json<Folder[]>("GET", `/folders?parent_id=${parentId ?? "null"}`),
      get: (id: number) => json<FolderDetail>("GET", `/folders/${id}`),
      create: (name: string, parentId: number | null = null, opts?: { kind?: "standard" | "photos"; isPublic?: boolean }) =>
        json<Folder>("POST", "/folders", {
          name,
          parent_id: parentId,
          kind: opts?.kind,
          is_public: opts?.isPublic,
        }),
      rename: (id: number, name: string) => json<Folder>("PATCH", `/folders/${id}`, { name }),
      move: (id: number, parentId: number | null) =>
        json<Folder>("PATCH", `/folders/${id}`, { parent_id: parentId }),
      update: (id: number, patch: { kind?: "standard" | "photos"; isPublic?: boolean }) =>
        json<Folder>("PATCH", `/folders/${id}`, { kind: patch.kind, is_public: patch.isPublic }),
      delete: (id: number) => json<{ trashed: number }>("DELETE", `/folders/${id}`),
    },

    files: {
      list: (folderId: number | null = null, q?: string) => {
        const qs = q ? `q=${encodeURIComponent(q)}` : `folder_id=${folderId ?? "null"}`
        return json<FileItem[]>("GET", `/files?${qs}`)
      },
      get: (id: number) => json<FileDetail>("GET", `/files/${id}`),
      upload: async (input: {
        file: Blob | Uint8Array
        name: string
        folderId?: number | null
        mime?: string
      }): Promise<FileItem[]> => {
        const blob = input.file instanceof Blob
          ? input.file
          : new Blob([input.file as BlobPart], { type: input.mime ?? "application/octet-stream" })
        const form = new FormData()
        form.append(input.name, blob, input.name)
        if (input.folderId != null) form.append("folder_id", String(input.folderId))
        const res = await fetcher(`${baseUrl}/files`, {
          method: "POST",
          headers: headers(),
          body: form,
        })
        const text = await res.text()
        const parsed = text ? JSON.parse(text) : null
        if (!res.ok || isError(parsed)) {
          throw new StohrError(isError(parsed) ? parsed.error : `HTTP ${res.status}`, res.status, parsed)
        }
        return parsed as FileItem[]
      },
      download: async (id: number): Promise<Uint8Array> => {
        const res = await fetcher(`${baseUrl}/files/${id}/download`, { headers: headers() })
        if (!res.ok) throw new StohrError(`HTTP ${res.status}`, res.status, null)
        const buf = await res.arrayBuffer()
        return new Uint8Array(buf)
      },
      thumbnail: async (id: number, version?: number): Promise<Uint8Array | null> => {
        const v = version ? `?v=${version}` : ""
        const res = await fetcher(`${baseUrl}/files/${id}/thumb${v}`, { headers: headers() })
        if (res.status === 404) return null
        if (!res.ok) throw new StohrError(`HTTP ${res.status}`, res.status, null)
        const buf = await res.arrayBuffer()
        return new Uint8Array(buf)
      },
      rename: (id: number, name: string) => json<FileItem>("PATCH", `/files/${id}`, { name }),
      move: (id: number, folderId: number | null) =>
        json<FileItem>("PATCH", `/files/${id}`, { folder_id: folderId }),
      delete: (id: number) => json<{ trashed: number }>("DELETE", `/files/${id}`),
      versions: (id: number) => json<FileVersion[]>("GET", `/files/${id}/versions`),
    },

    shares: {
      list: () => json<Share[]>("GET", "/shares"),
      create: (fileId: number, expiresInSeconds?: number) =>
        json<Share>("POST", "/shares", { file_id: fileId, expires_in: expiresInSeconds }),
      delete: (id: number) => json<{ deleted: number }>("DELETE", `/shares/${id}`),
    },

    collaborators: {
      list: (kind: ResourceKind, id: number) =>
        json<Collaborator[]>("GET", `/${kind}s/${id}/collaborators`),
      add: (kind: ResourceKind, id: number, identity: string, role: "viewer" | "editor") =>
        json<Collaborator>("POST", `/${kind}s/${id}/collaborators`, { identity, role }),
      remove: (kind: ResourceKind, id: number, collabId: number) =>
        json<{ removed: number }>("DELETE", `/${kind}s/${id}/collaborators/${collabId}`),
    },

    sharedWithMe: () =>
      json<{ folders: Folder[]; files: FileItem[] }>("GET", "/shared"),

    invites: {
      list: () => json<Invite[]>("GET", "/invites"),
      create: (email?: string) => json<Invite>("POST", "/invites", { email }),
      revoke: (id: number) => json<{ revoked: number }>("DELETE", `/invites/${id}`),
    },

    s3Keys: {
      list: () => json<S3AccessKey[]>("GET", "/me/s3-keys"),
      create: (name?: string) => json<S3AccessKey>("POST", "/me/s3-keys", { name }),
      revoke: (id: number) => json<{ revoked: number }>("DELETE", `/me/s3-keys/${id}`),
    },
  }
}

export class StohrError extends Error {
  status: number
  body: Record<string, unknown> | null
  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message)
    this.name = "StohrError"
    this.status = status
    this.body = body
  }
}
