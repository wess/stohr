import type { Primitive } from "../types.ts"
import { mimeClass } from "../util/mime.ts"

const filterMime: Primitive = {
  kind: "filter.mime",
  name: "Only certain file types",
  category: "filter",
  description: "Skip the rest of this action if the file isn't one of the chosen types.",
  icon: "Filter",
  subjects: ["file"],
  configSchema: {
    type: "object",
    required: ["allow"],
    properties: {
      allow: {
        type: "array",
        items: {
          type: "string",
          enum: ["image", "video", "audio", "document", "text", "archive"],
        },
        title: "Allowed types",
        default: ["image"],
      },
    },
  },
  run: async (env, config) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const allow = Array.isArray(config.allow) ? (config.allow as string[]) : []
    if (allow.length === 0) return { kind: "continue" }
    const cls = mimeClass(env.subject.row.mime)
    if (!allow.includes(cls)) {
      return { kind: "halt", reason: `${env.subject.row.mime} not in allowed list` }
    }
    return { kind: "continue" }
  },
}

export default filterMime
