import type { Connection } from "@atlas/db"
import type { StorageHandle } from "../storage/index.ts"
import type { FileRow, FolderRow } from "../permissions/index.ts"

export type EventName =
  | "file.created"
  | "file.updated"
  | "file.deleted"
  | "file.moved.in"
  | "file.moved.out"
  | "folder.created"
  | "folder.updated"
  | "folder.deleted"
  | "folder.moved.in"
  | "folder.moved.out"

export const ALL_EVENTS: ReadonlyArray<EventName> = [
  "file.created",
  "file.updated",
  "file.deleted",
  "file.moved.in",
  "file.moved.out",
  "folder.created",
  "folder.updated",
  "folder.deleted",
  "folder.moved.in",
  "folder.moved.out",
]

export const isEventName = (s: unknown): s is EventName =>
  typeof s === "string" && (ALL_EVENTS as readonly string[]).includes(s)

export type SubjectKind = "file" | "folder"

export type Subject =
  | { kind: "file"; row: FileRow }
  | { kind: "folder"; row: FolderRow }

export type ActionPermission =
  | "file.read"
  | "file.write"
  | "folder.read"
  | "folder.write"
  | "network"

export type JsonSchema = Record<string, unknown>

export type ActionContext = {
  db: Connection
  store: StorageHandle
  folder: FolderRow
  event: EventName
  subject: Subject
  actor: { id: number }
  ownerId: number
  config: Record<string, unknown>
  depth: number
}

export type ActionResult =
  | { ok: true; result?: Record<string, unknown> }
  | { ok: false; error: string }

export type Action = {
  slug: string
  name: string
  description: string
  version: string
  author: { name: string; url?: string }
  homepage?: string
  icon?: string
  permissions: ActionPermission[]
  events: EventName[]
  subjects: SubjectKind[]
  configSchema: JsonSchema
  run: (ctx: ActionContext) => Promise<ActionResult>
}

export type FolderActionRow = {
  id: number
  folder_id: number
  event: string
  slug: string
  config: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export type RunStatus = "succeeded" | "failed" | "skipped"

export type FolderActionRunRow = {
  id: number
  folder_action_id: number
  triggered_event: string
  subject_kind: string
  subject_id: number
  status: RunStatus
  started_at: string
  finished_at: string | null
  error: string | null
  result: string | null
}
