import { from } from "@atlas/db"
import type { Primitive } from "../types.ts"
import { resolveTemplateChain } from "../util/folders.ts"
import { expandTemplate } from "../util/template.ts"

const routeMove: Primitive = {
  kind: "route.move",
  name: "Move into a folder",
  category: "route",
  description:
    "Moves the file into a (sub)folder under this one. Path supports {YYYY} {MM} {DD} {name} {ext} {full}.",
  icon: "FolderOpen",
  subjects: ["file"],
  configSchema: {
    type: "object",
    required: ["path_template"],
    properties: {
      path_template: {
        type: "string",
        title: "Where should it go?",
        description: 'Use slashes for nested folders. Example: "{YYYY}/{MM}" or "Sorted/{ext}".',
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
      return { kind: "continue" }
    }

    await ctx.db.execute(
      from("files").where(q => q("id").equals(env.subject.row.id)).update({ folder_id: targetFolderId }),
    )

    return {
      kind: "continue",
      envelope: {
        ...env,
        subject: {
          kind: "file",
          row: { ...env.subject.row, folder_id: targetFolderId },
        },
      },
    }
  },
}

export default routeMove
