import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type SpaceRole = "admin" | "editor" | "viewer"

const VALID_ROLES = new Set<SpaceRole>(["admin", "editor", "viewer"])

type SpaceRow = {
  id: number
  slug: string
  name: string
  description: string | null
  owner_id: number
  created_at: string
  deleted_at: string | null
}

type MemberRow = {
  id: number
  space_id: number
  user_id: number
  role: SpaceRole
  added_at: string
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/
const isValidSlug = (s: string) => SLUG_RE.test(s)

const slugFromName = (name: string): string => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return base.slice(0, 40) || "space"
}

const uniqueSlug = async (db: Connection, base: string): Promise<string> => {
  let candidate = base
  for (let i = 0; i < 50; i++) {
    const taken = await db.one(
      from("spaces").where(q => q("slug").equals(candidate)).select("id"),
    )
    if (!taken) return candidate
    const suffix = Math.floor(Math.random() * 9000 + 1000).toString()
    candidate = `${base.slice(0, 40 - suffix.length - 1)}-${suffix}`
  }
  throw new Error("Could not allocate a unique slug")
}

export const spaceMembership = async (
  db: Connection,
  userId: number,
  spaceId: number,
): Promise<SpaceRole | null> => {
  const row = await db.one(
    from("space_members")
      .where(q => q("space_id").equals(spaceId))
      .where(q => q("user_id").equals(userId))
      .select("role"),
  ) as { role: SpaceRole } | null
  return row?.role ?? null
}

// Used by the permissions module: when checking access on a folder that
// belongs to a Space, we map the caller's space role onto the standard
// owner/editor/viewer triple used by everything else.
export const spaceRoleAsFolderRole = (role: SpaceRole): "owner" | "editor" | "viewer" => {
  if (role === "admin") return "owner"
  if (role === "editor") return "editor"
  return "viewer"
}

const listMembers = async (db: Connection, spaceId: number) => {
  return db.execute({
    text: `
      SELECT m.id, m.space_id, m.user_id, m.role, m.added_at,
             u.username, u.name, u.email
        FROM space_members m
        JOIN users u ON u.id = m.user_id
       WHERE m.space_id = $1
       ORDER BY m.added_at ASC
    `,
    values: [spaceId],
  }) as Promise<Array<MemberRow & { username: string; name: string; email: string }>>
}

export const spaceRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/spaces", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.execute({
        text: `
          SELECT s.id, s.slug, s.name, s.description, s.owner_id, s.created_at,
                 m.role AS my_role
            FROM spaces s
            JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
           WHERE s.deleted_at IS NULL
           ORDER BY s.created_at DESC
        `,
        values: [userId],
      }) as Array<SpaceRow & { my_role: SpaceRole }>
      return json(c, 200, { spaces: rows })
    })),

    post("/spaces", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { name?: string; slug?: string; description?: string }
      const name = body.name?.trim()
      if (!name) return json(c, 422, { error: "name is required" })

      const wantedSlug = body.slug ? body.slug.trim() : slugFromName(name)
      if (body.slug && !isValidSlug(wantedSlug)) {
        return json(c, 422, { error: "slug must be lowercase alphanumeric with internal hyphens, 3-40 chars" })
      }
      const slug = await uniqueSlug(db, wantedSlug)

      const inserted = await db.execute(
        from("spaces").insert({
          slug,
          name,
          description: body.description?.trim() ?? null,
          owner_id: userId,
        }).returning("id", "slug", "name", "description", "owner_id", "created_at", "deleted_at"),
      ) as SpaceRow[]
      const space = inserted[0]!

      // Owner is always an admin member; we write the row so member
      // listings need only one query.
      await db.execute(
        from("space_members").insert({
          space_id: space.id,
          user_id: userId,
          role: "admin",
          added_by: userId,
        }),
      )

      return json(c, 201, { ...space, my_role: "admin" as SpaceRole })
    })),

    get("/spaces/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const role = await spaceMembership(db, userId, id)
      if (!role) return json(c, 404, { error: "Space not found" })
      const space = await db.one(
        from("spaces").where(q => q("id").equals(id)).where(q => q("deleted_at").isNull()),
      ) as SpaceRow | null
      if (!space) return json(c, 404, { error: "Space not found" })
      return json(c, 200, { ...space, my_role: role })
    })),

    patch("/spaces/:id", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const role = await spaceMembership(db, userId, id)
      if (role !== "admin") return json(c, 403, { error: "Admin access required" })

      const body = c.body as { name?: string; description?: string | null }
      const update: Record<string, unknown> = {}
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim()) return json(c, 422, { error: "name must be a non-empty string" })
        update.name = body.name.trim()
      }
      if (body.description !== undefined) {
        update.description = body.description === null ? null : String(body.description).trim()
      }
      if (Object.keys(update).length === 0) return json(c, 422, { error: "Nothing to update" })
      await db.execute(from("spaces").where(q => q("id").equals(id)).update(update))
      const fresh = await db.one(
        from("spaces").where(q => q("id").equals(id)),
      ) as SpaceRow
      return json(c, 200, fresh)
    })),

    del("/spaces/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const space = await db.one(
        from("spaces").where(q => q("id").equals(id)).where(q => q("deleted_at").isNull()),
      ) as SpaceRow | null
      if (!space) return json(c, 404, { error: "Space not found" })
      if (space.owner_id !== userId) return json(c, 403, { error: "Only the space owner can delete it" })

      // Soft-delete the space and every folder rooted inside it. Files
      // tag along via their folder. Hard-deletion can come later (mirror
      // of the user-account sweep).
      await db.execute(
        from("spaces").where(q => q("id").equals(id)).update({ deleted_at: raw("NOW()") }),
      )
      await db.execute(
        from("folders").where(q => q("space_id").equals(id)).update({ deleted_at: raw("NOW()") }),
      )
      return json(c, 200, { deleted: id })
    })),

    get("/spaces/:id/members", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const role = await spaceMembership(db, userId, id)
      if (!role) return json(c, 404, { error: "Space not found" })
      const members = await listMembers(db, id)
      return json(c, 200, {
        members: members.map(m => ({
          id: m.id,
          user: { id: m.user_id, username: m.username, name: m.name, email: m.email },
          role: m.role,
          added_at: m.added_at,
        })),
      })
    })),

    post("/spaces/:id/members", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const role = await spaceMembership(db, userId, id)
      if (role !== "admin") return json(c, 403, { error: "Admin access required" })

      const body = c.body as { user_id?: number; userId?: number; username?: string; email?: string; role?: SpaceRole }
      const memberRole = body.role ?? "editor"
      if (!VALID_ROLES.has(memberRole)) {
        return json(c, 422, { error: "role must be admin, editor, or viewer" })
      }

      type Target = { id: number; username: string; name: string; email: string }
      let target: Target | null = null
      const targetId = body.user_id ?? body.userId
      const username = body.username
      const email = body.email
      if (targetId) {
        target = await db.one(
          from("users").where(q => q("id").equals(targetId)).select("id", "username", "name", "email"),
        ) as Target | null
      } else if (username) {
        target = await db.one(
          from("users").where(q => q("username").equals(username.toLowerCase())).select("id", "username", "name", "email"),
        ) as Target | null
      } else if (email) {
        target = await db.one(
          from("users").where(q => q("email").equals(email.toLowerCase())).select("id", "username", "name", "email"),
        ) as Target | null
      } else {
        return json(c, 422, { error: "user_id, username, or email required" })
      }
      if (!target) return json(c, 404, { error: "User not found" })
      const member = target

      const existing = await db.one(
        from("space_members")
          .where(q => q("space_id").equals(id))
          .where(q => q("user_id").equals(member.id))
          .select("id"),
      ) as { id: number } | null
      if (existing) {
        await db.execute(
          from("space_members").where(q => q("id").equals(existing.id)).update({ role: memberRole }),
        )
        return json(c, 200, { id: existing.id, user: member, role: memberRole })
      }

      const inserted = await db.execute(
        from("space_members").insert({
          space_id: id,
          user_id: member.id,
          role: memberRole,
          added_by: userId,
        }).returning("id", "added_at"),
      ) as Array<{ id: number; added_at: string }>
      return json(c, 201, { id: inserted[0]!.id, user: member, role: memberRole, added_at: inserted[0]!.added_at })
    })),

    patch("/spaces/:id/members/:memberId", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const memberId = Number(c.params.memberId)
      const role = await spaceMembership(db, userId, id)
      if (role !== "admin") return json(c, 403, { error: "Admin access required" })
      const body = c.body as { role?: SpaceRole }
      if (!body.role || !VALID_ROLES.has(body.role)) {
        return json(c, 422, { error: "role must be admin, editor, or viewer" })
      }
      const target = await db.one(
        from("space_members")
          .where(q => q("id").equals(memberId))
          .where(q => q("space_id").equals(id))
          .select("user_id"),
      ) as { user_id: number } | null
      if (!target) return json(c, 404, { error: "Member not found" })

      const space = await db.one(
        from("spaces").where(q => q("id").equals(id)).select("owner_id"),
      ) as { owner_id: number } | null
      if (space?.owner_id === target.user_id && body.role !== "admin") {
        return json(c, 422, { error: "The space owner must remain an admin" })
      }
      await db.execute(
        from("space_members").where(q => q("id").equals(memberId)).update({ role: body.role }),
      )
      return json(c, 200, { id: memberId, role: body.role })
    })),

    del("/spaces/:id/members/:memberId", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const memberId = Number(c.params.memberId)
      const role = await spaceMembership(db, userId, id)

      const target = await db.one(
        from("space_members")
          .where(q => q("id").equals(memberId))
          .where(q => q("space_id").equals(id))
          .select("user_id"),
      ) as { user_id: number } | null
      if (!target) return json(c, 404, { error: "Member not found" })

      // Admins can remove anyone except the owner; anyone can remove
      // themselves (i.e. leave the space).
      const isSelf = target.user_id === userId
      if (!isSelf && role !== "admin") return json(c, 403, { error: "Admin access required" })

      const space = await db.one(
        from("spaces").where(q => q("id").equals(id)).select("owner_id"),
      ) as { owner_id: number } | null
      if (space?.owner_id === target.user_id) {
        return json(c, 422, { error: "Cannot remove the space owner. Transfer ownership first." })
      }
      await db.execute(from("space_members").where(q => q("id").equals(memberId)).del())
      return json(c, 200, { removed: memberId })
    })),

    // List the root-level folders of a Space. The folders module handles
    // create/read/etc — this just gives the space "home" a content list
    // without re-piping every folder query through space-aware code.
    get("/spaces/:id/folders", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const role = await spaceMembership(db, userId, id)
      if (!role) return json(c, 404, { error: "Space not found" })
      const folders = await db.all(
        from("folders")
          .where(q => q("space_id").equals(id))
          .where(q => q("parent_id").isNull())
          .where(q => q("deleted_at").isNull())
          .orderBy("name", "ASC")
          .select("id", "name", "kind", "is_public", "created_at"),
      )
      return json(c, 200, { folders })
    })),

    // Create a folder at the root of a Space. Re-uses the regular folder
    // model with space_id pinned; the rest of the folder/file CRUD picks
    // up access via the extended permissions resolver.
    post("/spaces/:id/folders", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const role = await spaceMembership(db, userId, id)
      if (!role || role === "viewer") return json(c, 403, { error: "Editor access required" })
      const body = c.body as { name?: string }
      const name = body.name?.trim()
      if (!name) return json(c, 422, { error: "name required" })
      const inserted = await db.execute(
        from("folders").insert({
          user_id: userId,
          parent_id: null,
          space_id: id,
          name,
        }).returning("id", "name", "kind", "is_public", "created_at"),
      ) as Array<{ id: number; name: string; kind: string; is_public: boolean; created_at: string }>
      return json(c, 201, inserted[0])
    })),
  ]
}
