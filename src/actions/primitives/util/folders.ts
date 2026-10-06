import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

export const findOrCreateFolder = async (
  db: Connection,
  ownerId: number,
  parentId: number,
  name: string,
): Promise<number> => {
  const parent = (await db.one(
    from("folders")
      .where(q => q("id").equals(parentId))
      .select("space_id"),
  )) as { space_id: number | null } | null
  if (!parent) throw new Error("Parent folder not found")
  const existing = (await db.one(
    from("folders")
      .where(q => q("user_id").equals(ownerId))
      .where(q => q("parent_id").equals(parentId))
      .where(q => q("name").equals(name))
      .where(q => q("deleted_at").isNull())
      .select("id"),
  )) as { id: number } | null
  if (existing) return existing.id
  const inserted = (await db.execute(
    from("folders")
      .insert({
        user_id: ownerId,
        parent_id: parentId,
        space_id: parent.space_id,
        name,
        kind: "standard",
        is_public: false,
      })
      .returning("id"),
  )) as Array<{ id: number }>
  return inserted[0]!.id
}

export const resolveTemplateChain = async (
  db: Connection,
  ownerId: number,
  rootFolderId: number,
  segments: string[],
): Promise<number> => {
  let parentId = rootFolderId
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    parentId = await findOrCreateFolder(db, ownerId, parentId, trimmed)
  }
  return parentId
}
