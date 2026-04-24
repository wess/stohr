export type ParsedQuery = {
  name: string
  types: string[]
  exts: string[]
}

const MIME_CLASSES: Record<string, string[]> = {
  image: ["image/%"],
  video: ["video/%"],
  audio: ["audio/%"],
  text: ["text/%"],
  document: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.%",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
  ],
}

export const mimePatternsFor = (klass: string): string[] =>
  MIME_CLASSES[klass] ?? []

export const escapeLike = (s: string): string =>
  s.replace(/([\\%_])/g, "\\$1")

export const parseQuery = (input: string): ParsedQuery => {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  const types: string[] = []
  const exts: string[] = []
  const name: string[] = []

  for (const tok of tokens) {
    const colon = tok.indexOf(":")
    if (colon > 0) {
      const key = tok.slice(0, colon).toLowerCase()
      const val = tok.slice(colon + 1).toLowerCase()
      if (!val) continue
      if (key === "type" && MIME_CLASSES[val]) {
        types.push(val)
        continue
      }
      if (key === "ext") {
        exts.push(val.replace(/^\./, ""))
        continue
      }
    }
    name.push(tok)
  }

  return { name: name.join(" "), types, exts }
}
