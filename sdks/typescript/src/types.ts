export type User = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
  created_at: string
}

export type AuthResult = User & { token: string }

export type Folder = {
  id: number
  name: string
  parent_id: number | null
  kind?: string
  is_public?: boolean
  created_at: string
}

export type FolderTrail = { id: number; name: string }

export type FolderDetail = Folder & {
  role: "owner" | "editor" | "viewer"
  owner: { id: number; username: string; name: string } | null
  trail: FolderTrail[]
}

export type FileItem = {
  id: number
  name: string
  mime: string
  size: number
  folder_id: number | null
  version: number
  created_at: string
}

export type FileDetail = FileItem & {
  role?: "owner" | "editor" | "viewer"
}

export type FileVersion = {
  version: number
  mime: string
  size: number
  uploaded_by: number | null
  uploaded_at: string
  is_current: boolean
}

export type Share = {
  id: number
  token: string
  expires_at: string | null
  created_at: string
  name: string
  size: number
  mime: string
  file_id: number
}

export type Collaborator = {
  id: number
  user_id: number | null
  email: string | null
  role: "viewer" | "editor"
  created_at: string
  accepted_at: string | null
  user: { id: number; username: string; email?: string; name: string } | null
  invite_token?: string | null
}

export type Invite = {
  id: number
  token: string
  email: string | null
  used_at: string | null
  used_by: number | null
  created_at: string
}

export type Subscription = {
  tier: string
  quota_bytes: number
  used_bytes: number
  status: string | null
  renews_at: string | null
  has_subscription: boolean
}

export type S3AccessKey = {
  id: number
  access_key: string
  secret_key?: string
  name: string | null
  created_at: string
  last_used_at: string | null
}

export type ApiError = { error: string; [k: string]: unknown }

export type ResourceKind = "file" | "folder"
