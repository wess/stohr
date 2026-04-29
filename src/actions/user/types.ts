import type { Step } from "../primitives/types.ts"
import type { EventName } from "../types.ts"

export type UserActionRow = {
  id: number
  user_id: number
  name: string
  description: string | null
  icon: string | null
  triggers: string  // JSON array of EventName
  steps: string     // JSON array of Step
  enabled: boolean
  forked_from: string | null
  created_at: string
  updated_at: string
}

export type UserActionParsed = Omit<UserActionRow, "triggers" | "steps"> & {
  triggers: EventName[]
  steps: Step[]
}

const safeJsonArray = <T>(raw: string | null | undefined): T[] => {
  try {
    const v = JSON.parse(raw ?? "[]")
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export const parseUserAction = (row: UserActionRow): UserActionParsed => ({
  ...row,
  triggers: safeJsonArray<EventName>(row.triggers),
  steps: safeJsonArray<Step>(row.steps),
})
