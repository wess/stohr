import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { fileAccess, folderAccess, isOwner } from "../permissions/index.ts"
import { isEmail, normalizeUsername } from "../util/username.ts"
import { randomToken } from "../util/token.ts"
import type { Emailer } from "../email/index.ts"
import { inviteEmail } from "../email/templates/invite.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type ResourceKind = "folder" | "file"

const resolveTarget = async (db: Connection, identity: string) => {
  const trimmed = identity.trim()
  if (!trimmed) return { kind: "invalid" as const }
  if (isEmail(trimmed)) {
    const email = trimmed.toLowerCase()
    const user = await db.one(
      from("users").where(q => q("email").equals(email)).select("id", "email", "username", "name"),
    ) as { id: number; email: string; username: string; name: string } | null
    return user
      ? { kind: "user" as const, user }
      : { kind: "email" as const, email }
  }
  const username = normalizeUsername(trimmed)
  const user = await db.one(
    from("users").where(q => q("username").equals(username)).select("id", "email", "username", "name"),
  ) as { id: number; email: string; username: string; name: string } | null
  if (!user) return { kind: "missing" as const }
  return { kind: "user" as const, user }
}

const enrichCollabs = async (db: Connection, rows: Array<any>) => {
  const userIds = Array.from(new Set(rows.map(r => r.user_id).filter((x): x is number => x != null)))
  if (userIds.length === 0) return rows.map(r => ({ ...r, user: null }))
  const users = await db.all(
    from("users").where(q => q("id").inList(userIds)).select("id", "username", "email", "name"),
  ) as Array<{ id: number; username: string; email: string; name: string }>
  const byId = new Map(users.map(u => [u.id, u]))
  return rows.map(r => ({ ...r, user: r.user_id ? byId.get(r.user_id) ?? null : null }))
}

const accessFor = async (
  db: Connection,
  userId: number,
  kind: ResourceKind,
  resourceId: number,
) => kind === "folder"
  ? await folderAccess(db, userId, resourceId)
  : await fileAccess(db, userId, resourceId)

const listCollabs = (db: Connection, kind: ResourceKind) => async (c: any) => {
  const userId = authId(c)
  const id = Number(c.params.id)
  const access = await accessFor(db, userId, kind, id)
  if (!access) return json(c, 404, { error: `${kind} not found` })

  const rows = await db.all(
    from("collaborations")
      .where(q => q("resource_type").equals(kind))
      .where(q => q("resource_id").equals(id))
      .select("id", "user_id", "email", "role", "created_at", "accepted_at")
      .orderBy("created_at", "ASC"),
  )
  const enriched = await enrichCollabs(db, rows)
  return json(c, 200, enriched)
}

const addCollab = (db: Connection, kind: ResourceKind, emailer: Emailer, appUrl: string) => async (c: any) => {
  const userId = authId(c)
  const id = Number(c.params.id)
  const access = await accessFor(db, userId, kind, id)
  if (!access) return json(c, 404, { error: `${kind} not found` })
  if (!isOwner(access.role)) return json(c, 403, { error: "Only the owner can add collaborators" })

  const body = c.body as { identity?: string; role?: string }
  const identity = body.identity?.trim() ?? ""
  const role = body.role === "editor" ? "editor" : "viewer"
  if (!identity) return json(c, 422, { error: "identity required" })

  const target = await resolveTarget(db, identity)
  if (target.kind === "invalid") return json(c, 422, { error: "Invalid identity" })
  if (target.kind === "missing") return json(c, 404, { error: "User not found" })

  if (target.kind === "user") {
    if (target.user.id === userId) return json(c, 422, { error: "You already own this" })
    const existing = await db.one(
      from("collaborations")
        .where(q => q("resource_type").equals(kind))
        .where(q => q("resource_id").equals(id))
        .where(q => q("user_id").equals(target.user.id))
        .select("id"),
    ) as { id: number } | null
    if (existing) {
      await db.execute(
        from("collaborations").where(q => q("id").equals(existing.id)).update({ role }),
      )
      return json(c, 200, { id: existing.id, user_id: target.user.id, role, user: target.user })
    }
    const inserted = await db.execute(
      from("collaborations").insert({
        resource_type: kind,
        resource_id: id,
        user_id: target.user.id,
        email: null,
        role,
        invited_by: userId,
        accepted_at: raw("NOW()"),
      }).returning("id", "user_id", "email", "role", "created_at", "accepted_at"),
    ) as Array<any>
    return json(c, 201, { ...inserted[0], user: target.user })
  }

  const email = target.email
  const existing = await db.one(
    from("collaborations")
      .where(q => q("resource_type").equals(kind))
      .where(q => q("resource_id").equals(id))
      .where(q => q("user_id").isNull())
      .where(q => q("email").ilike(email))
      .select("id"),
  ) as { id: number } | null

  let collabId: number
  if (existing) {
    await db.execute(
      from("collaborations").where(q => q("id").equals(existing.id)).update({ role }),
    )
    collabId = existing.id
  } else {
    const inserted = await db.execute(
      from("collaborations").insert({
        resource_type: kind,
        resource_id: id,
        user_id: null,
        email,
        role,
        invited_by: userId,
      }).returning("id"),
    ) as Array<{ id: number }>
    collabId = inserted[0]!.id
  }

  let inviteRow = await db.one(
    from("invites")
      .where(q => q("email").ilike(email))
      .where(q => q("used_at").isNull())
      .select("token")
      .orderBy("created_at", "DESC")
      .limit(1),
  ) as { token: string } | null

  if (!inviteRow) {
    const tok = randomToken()
    const out = await db.execute(
      from("invites").insert({ token: tok, email, invited_by: userId }).returning("token"),
    ) as Array<{ token: string }>
    inviteRow = { token: out[0]!.token }
  }

  const inviter = await db.one(
    from("users").where(q => q("id").equals(userId)).select("name", "username"),
  ) as { name: string; username: string } | null
  const signupUrl = `${appUrl.replace(/\/$/, "")}/signup?invite=${encodeURIComponent(inviteRow.token)}`
  const tpl = inviteEmail({
    inviterName: inviter?.name ?? inviter?.username ?? null,
    email,
    signupUrl,
  })
  const sendRes = await emailer.send({
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  })

  return json(c, existing ? 200 : 201, {
    id: collabId,
    user_id: null,
    email,
    role,
    user: null,
    invite_token: inviteRow.token,
    email_sent: sendRes.ok,
    email_error: sendRes.ok ? undefined : sendRes.error,
  })
}

const removeCollab = (db: Connection, kind: ResourceKind) => async (c: any) => {
  const userId = authId(c)
  const id = Number(c.params.id)
  const collabId = Number(c.params.collabId)
  const access = await accessFor(db, userId, kind, id)
  if (!access) return json(c, 404, { error: `${kind} not found` })
  if (!isOwner(access.role)) return json(c, 403, { error: "Only the owner can remove collaborators" })

  const row = await db.one(
    from("collaborations")
      .where(q => q("id").equals(collabId))
      .where(q => q("resource_type").equals(kind))
      .where(q => q("resource_id").equals(id))
      .select("id"),
  ) as { id: number } | null
  if (!row) return json(c, 404, { error: "Collaborator not found" })

  await db.execute(from("collaborations").where(q => q("id").equals(collabId)).del())
  return json(c, 200, { removed: collabId })
}

const sharedWithMe = (db: Connection) => async (c: any) => {
  const userId = authId(c)
  const collabs = await db.all(
    from("collaborations")
      .where(q => q("user_id").equals(userId))
      .select("id", "resource_type", "resource_id", "role", "created_at"),
  ) as Array<{ id: number; resource_type: "folder" | "file"; resource_id: number; role: string; created_at: string }>

  const folderIds = collabs.filter(c => c.resource_type === "folder").map(c => c.resource_id)
  const fileIds = collabs.filter(c => c.resource_type === "file").map(c => c.resource_id)

  const folders = folderIds.length === 0 ? [] : await db.all(
    from("folders")
      .where(q => q("id").inList(folderIds))
      .where(q => q("deleted_at").isNull())
      .select("id", "user_id", "parent_id", "name", "created_at"),
  ) as Array<{ id: number; user_id: number; parent_id: number | null; name: string; created_at: string }>

  const files = fileIds.length === 0 ? [] : await db.all(
    from("files")
      .where(q => q("id").inList(fileIds))
      .where(q => q("deleted_at").isNull())
      .select("id", "user_id", "name", "mime", "size", "folder_id", "version", "created_at"),
  ) as Array<{ id: number; user_id: number; name: string; mime: string; size: number; folder_id: number | null; version: number; created_at: string }>

  const ownerIds = Array.from(new Set([...folders.map(f => f.user_id), ...files.map(f => f.user_id)]))
  const owners = ownerIds.length === 0 ? [] : await db.all(
    from("users").where(q => q("id").inList(ownerIds)).select("id", "username", "name"),
  ) as Array<{ id: number; username: string; name: string }>
  const ownerById = new Map(owners.map(o => [o.id, o]))

  const roleByFolder = new Map(collabs.filter(c => c.resource_type === "folder").map(c => [c.resource_id, c.role]))
  const roleByFile = new Map(collabs.filter(c => c.resource_type === "file").map(c => [c.resource_id, c.role]))

  return json(c, 200, {
    folders: folders.map(f => ({
      ...f,
      role: roleByFolder.get(f.id) ?? "viewer",
      owner: ownerById.get(f.user_id) ?? null,
    })),
    files: files.map(f => ({
      ...f,
      role: roleByFile.get(f.id) ?? "viewer",
      owner: ownerById.get(f.user_id) ?? null,
    })),
  })
}

export const collabRoutes = (db: Connection, secret: string, emailer: Emailer, appUrl: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/shared", guard(sharedWithMe(db))),

    get("/folders/:id/collaborators", guard(listCollabs(db, "folder"))),
    post("/folders/:id/collaborators", authed(addCollab(db, "folder", emailer, appUrl))),
    del("/folders/:id/collaborators/:collabId", guard(removeCollab(db, "folder"))),

    get("/files/:id/collaborators", guard(listCollabs(db, "file"))),
    post("/files/:id/collaborators", authed(addCollab(db, "file", emailer, appUrl))),
    del("/files/:id/collaborators/:collabId", guard(removeCollab(db, "file"))),
  ]
}
