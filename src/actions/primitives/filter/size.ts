import type { Primitive } from "../types.ts"

const filterSize: Primitive = {
  kind: "filter.size",
  name: "Only certain file sizes",
  category: "filter",
  description: "Skip the rest of this action unless the file's size is within the chosen range.",
  icon: "Scale",
  subjects: ["file"],
  configSchema: {
    type: "object",
    properties: {
      min_bytes: {
        type: "integer",
        minimum: 0,
        title: "Minimum size (bytes)",
        description: "Skip files smaller than this.",
      },
      max_bytes: {
        type: "integer",
        minimum: 0,
        title: "Maximum size (bytes)",
        description: "Skip files larger than this.",
      },
    },
  },
  run: async (env, config) => {
    if (env.subject.kind !== "file") return { kind: "halt", reason: "not a file" }
    const size = Number(env.subject.row.size ?? 0)
    const minRaw = config.min_bytes
    const maxRaw = config.max_bytes
    const min = minRaw === undefined || minRaw === null ? null : Number(minRaw)
    const max = maxRaw === undefined || maxRaw === null ? null : Number(maxRaw)
    if (min !== null && Number.isFinite(min) && size < min) {
      return { kind: "halt", reason: `file is ${size}B, smaller than ${min}B` }
    }
    if (max !== null && Number.isFinite(max) && size > max) {
      return { kind: "halt", reason: `file is ${size}B, larger than ${max}B` }
    }
    return { kind: "continue" }
  },
}

export default filterSize
