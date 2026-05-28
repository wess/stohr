import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

export type NotificationKind =
  | "comment.created"
  | "comment.reply"
  | "collab.invited"
  | "share.created"
  | "file.added"
  | "file.changed"
  | "file.moved"
  | "folder.added"

export type EmitInput = {
  userId: number
  kind: NotificationKind
  resourceType?: "file" | "folder" | "share" | "comment"
  resourceId?: number
  actorId?: number
  payload?: Record<string, unknown>
}

// Fire-and-forget single-row insert. We don't await this from request
// handlers — notifications failing should never block the user's action.
// Callers use `void emit(...)`.
export const emit = async (db: Connection, input: EmitInput): Promise<void> => {
  if (input.actorId && input.actorId === input.userId) return
  try {
    await db.execute(
      from("notifications").insert({
        user_id: input.userId,
        kind: input.kind,
        resource_type: input.resourceType ?? null,
        resource_id: input.resourceId ?? null,
        actor_id: input.actorId ?? null,
        payload: input.payload ? JSON.stringify(input.payload) : null,
      }),
    )
  } catch (err) {
    console.error("[notifications] emit failed:", err)
  }
}

// Emit the same notification to a set of users, de-duplicating and
// skipping the actor. Used when a comment fans out to every other
// participant in a thread.
export const emitMany = async (db: Connection, inputs: EmitInput[]): Promise<void> => {
  const seen = new Set<string>()
  for (const i of inputs) {
    const key = `${i.userId}:${i.kind}:${i.resourceType ?? ""}:${i.resourceId ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    await emit(db, i)
  }
}
