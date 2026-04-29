import type { Primitive } from "../types.ts"

type Mode = "contains" | "starts_with" | "ends_with" | "equals"

const filterName: Primitive = {
  kind: "filter.name",
  name: "Only certain file names",
  category: "filter",
  description: "Skip the rest of this action unless the file's name matches.",
  icon: "Search",
  subjects: ["file", "folder"],
  configSchema: {
    type: "object",
    required: ["text"],
    properties: {
      mode: {
        type: "string",
        enum: ["contains", "starts_with", "ends_with", "equals"],
        default: "contains",
        title: "Match mode",
      },
      text: {
        type: "string",
        title: "Text to match",
        description: "What to look for in the name (without the extension).",
      },
      case_sensitive: {
        type: "boolean",
        default: false,
        title: "Case sensitive",
      },
    },
  },
  run: async (env, config) => {
    const text = String(config.text ?? "")
    if (!text) return { kind: "continue" }
    const mode = (config.mode as Mode) ?? "contains"
    const cs = !!config.case_sensitive

    const fullName = env.subject.row.name ?? ""
    const dot = fullName.lastIndexOf(".")
    const base = env.subject.kind === "file" && dot > 0 ? fullName.slice(0, dot) : fullName

    const haystack = cs ? base : base.toLowerCase()
    const needle = cs ? text : text.toLowerCase()

    let matched = false
    if (mode === "starts_with") matched = haystack.startsWith(needle)
    else if (mode === "ends_with") matched = haystack.endsWith(needle)
    else if (mode === "equals") matched = haystack === needle
    else matched = haystack.includes(needle)

    if (!matched) {
      return { kind: "halt", reason: `${fullName} does not ${mode.replace("_", " ")} "${text}"` }
    }
    return { kind: "continue" }
  },
}

export default filterName
