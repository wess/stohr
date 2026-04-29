import { from } from "@atlas/db"
import type { Primitive } from "../types.ts"
import { expandTemplate } from "../util/template.ts"

const routeRename: Primitive = {
  kind: "route.rename",
  name: "Rename the file",
  category: "route",
  description:
    "Renames the file. Template supports {name} {ext} {full} {YYYY} {MM} {DD}. Example: \"{YYYY}-{MM}-{DD}-{name}.{ext}\".",
  icon: "Edit3",
  subjects: ["file"],
  configSchema: {
    type: "object",
    required: ["name_template"],
    properties: {
      name_template: {
        type: "string",
        title: "New name",
        description: 'Use {name}, {ext}, {full}, {YYYY}, {MM}, {DD} as placeholders.',
      },
    },
  },
  run: async (env, config, ctx) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const template = String(config.name_template ?? "").trim()
    if (!template) return { kind: "fail", error: "name_template is required" }
    if (template.includes("/")) return { kind: "fail", error: "rename templates can't contain '/'" }

    const expanded = expandTemplate(template, env.subject)
    if (!expanded.ok) return { kind: "fail", error: expanded.error }
    const newName = expanded.value.trim()
    if (!newName) return { kind: "halt", reason: "empty name after expansion" }
    if (newName === env.subject.row.name) return { kind: "continue" }

    await ctx.db.execute(
      from("files").where(q => q("id").equals(env.subject.row.id)).update({ name: newName }),
    )
    return {
      kind: "continue",
      envelope: {
        ...env,
        subject: { kind: "file", row: { ...env.subject.row, name: newName } },
      },
    }
  },
}

export default routeRename
