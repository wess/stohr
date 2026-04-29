import { from } from "@atlas/db"
import type { Primitive } from "../types.ts"
import { fetchObject, makeKey, put } from "../../../storage/index.ts"
import { resolveTemplateChain } from "../util/folders.ts"
import { expandTemplate } from "../util/template.ts"

const routeCopy: Primitive = {
  kind: "route.copy",
  name: "Copy into a folder",
  category: "route",
  description:
    "Saves a duplicate of the file into a (sub)folder under this one. The original stays in place. Path supports {YYYY} {MM} {DD} {name} {ext} {full}.",
  icon: "Copy",
  subjects: ["file"],
  configSchema: {
    type: "object",
    required: ["path_template"],
    properties: {
      path_template: {
        type: "string",
        title: "Where should the copy go?",
        description: 'Use slashes for nested folders. Example: "Backups/{YYYY}".',
      },
    },
  },
  run: async (env, config, ctx) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const template = String(config.path_template ?? "").trim()
    if (!template) return { kind: "fail", error: "path_template is required" }

    const expanded = expandTemplate(template, env.subject)
    if (!expanded.ok) return { kind: "fail", error: expanded.error }

    const segments = expanded.value.split("/").map(s => s.trim()).filter(Boolean)
    if (segments.length === 0) return { kind: "halt", reason: "empty path after expansion" }

    const targetFolderId = await resolveTemplateChain(ctx.db, ctx.ownerId, env.folder.id, segments)
    if (env.subject.row.folder_id === targetFolderId) {
      return { kind: "halt", reason: "already in target folder" }
    }

    const file = env.subject.row
    const obj = await fetchObject(ctx.store, file.storage_key)
    const bytes = new Uint8Array(await obj.arrayBuffer())
    const newKey = makeKey(ctx.ownerId, file.name)
    await put(ctx.store, newKey, bytes, file.mime)

    await ctx.db.execute(
      from("files").insert({
        user_id: ctx.ownerId,
        folder_id: targetFolderId,
        name: file.name,
        mime: file.mime,
        size: file.size,
        storage_key: newKey,
        thumb_key: null,
        version: 1,
      }),
    )

    /* Original is untouched; envelope unchanged. */
    return { kind: "continue" }
  },
}

export default routeCopy
