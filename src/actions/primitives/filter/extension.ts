import type { Primitive } from "../types.ts"

const filterExtension: Primitive = {
  kind: "filter.extension",
  name: "Only certain file extensions",
  category: "filter",
  description: "Skip the rest of this action unless the file has one of the listed extensions.",
  icon: "FileText",
  subjects: ["file"],
  configSchema: {
    type: "object",
    required: ["extensions"],
    properties: {
      extensions: {
        type: "array",
        items: { type: "string" },
        title: "Allowed extensions",
        description: 'List the extensions without the dot, e.g. ["jpg", "png", "heic"].',
        default: [],
      },
    },
  },
  run: async (env, config) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const raw = Array.isArray(config.extensions) ? (config.extensions as unknown[]) : []
    const list = raw
      .map(v => String(v ?? "").trim().toLowerCase().replace(/^\./, ""))
      .filter(s => s.length > 0)
    if (list.length === 0) return { kind: "continue" }

    const name = env.subject.row.name ?? ""
    const dot = name.lastIndexOf(".")
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
    if (!list.includes(ext)) {
      return { kind: "halt", reason: `${name} doesn't end in any of: ${list.join(", ")}` }
    }
    return { kind: "continue" }
  },
}

export default filterExtension
