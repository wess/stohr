import type { Connection } from "@atlas/db"
import type { StorageHandle } from "../../storage/index.ts"
import type { FileRow, FolderRow } from "../../permissions/index.ts"

export type StepEnvelope = {
  subject: { kind: "file"; row: FileRow } | { kind: "folder"; row: FolderRow }
  folder: FolderRow
  scratch: Record<string, unknown>
}

export type StepResult =
  | { kind: "continue"; envelope?: StepEnvelope }
  | { kind: "halt"; reason: string }
  | { kind: "fail"; error: string }

export const stepContinue = (envelope?: StepEnvelope): StepResult => ({ kind: "continue", envelope })
export const stepHalt = (reason: string): StepResult => ({ kind: "halt", reason })
export const stepFail = (error: string): StepResult => ({ kind: "fail", error })

export type PrimitiveCategory = "filter" | "transform" | "route"

export type PrimitiveContext = {
  db: Connection
  store: StorageHandle
  ownerId: number
  actor: { id: number }
}

export type JsonSchema = Record<string, unknown>

export type Primitive = {
  kind: string
  name: string
  category: PrimitiveCategory
  description: string
  icon: string
  subjects: ("file" | "folder")[]
  configSchema: JsonSchema
  run: (env: StepEnvelope, config: Record<string, unknown>, ctx: PrimitiveContext) => Promise<StepResult>
}

export type Step = { kind: string; config: Record<string, unknown> }
