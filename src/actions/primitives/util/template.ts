import type { FileRow, FolderRow } from "../../../permissions/index.ts"

const ALLOWED_KEYS = ["YYYY", "MM", "DD", "name", "ext", "full"] as const
type Key = typeof ALLOWED_KEYS[number]

const padTwo = (n: number): string => String(n).padStart(2, "0")

const buildVars = (
  subject: { kind: "file"; row: FileRow } | { kind: "folder"; row: FolderRow },
): Record<Key, string> => {
  const now = new Date()
  const fullName = subject.row.name ?? ""
  const dot = fullName.lastIndexOf(".")
  const baseName = dot > 0 ? fullName.slice(0, dot) : fullName
  const ext = dot > 0 ? fullName.slice(dot + 1) : ""
  return {
    YYYY: String(now.getUTCFullYear()),
    MM: padTwo(now.getUTCMonth() + 1),
    DD: padTwo(now.getUTCDate()),
    name: baseName,
    ext,
    full: fullName,
  }
}

export type TemplateResult =
  | { ok: true; value: string }
  | { ok: false; error: string }

export const expandTemplate = (
  template: string,
  subject: { kind: "file"; row: FileRow } | { kind: "folder"; row: FolderRow },
): TemplateResult => {
  const matches = [...template.matchAll(/\{([^}]+)\}/g)]
  for (const m of matches) {
    const key = m[1]!
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        error: `Unknown template variable: {${key}}. Allowed: ${ALLOWED_KEYS.join(", ")}`,
      }
    }
  }
  const vars = buildVars(subject)
  const value = template.replace(/\{([^}]+)\}/g, (_, k) => vars[k as Key] ?? "")
  return { ok: true, value }
}

export { ALLOWED_KEYS as TEMPLATE_KEYS }
