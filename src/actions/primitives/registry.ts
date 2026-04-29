import type { Primitive } from "./types.ts"
import filterMime from "./filter/mime.ts"
import filterExtension from "./filter/extension.ts"
import filterSize from "./filter/size.ts"
import filterName from "./filter/name.ts"
import transformResize from "./transform/resize.ts"
import transformCompress from "./transform/compress.ts"
import transformThumbnail from "./transform/thumbnail.ts"
import routeMove from "./route/move.ts"
import routeCopy from "./route/copy.ts"
import routeRename from "./route/rename.ts"

const REGISTRY = new Map<string, Primitive>()

const register = (p: Primitive) => {
  if (REGISTRY.has(p.kind)) {
    throw new Error(`Primitive kind already registered: ${p.kind}`)
  }
  if (!/^[a-z]+\.[a-z]+$/.test(p.kind)) {
    throw new Error(`Primitive kind must match <category>.<name> in lowercase: ${p.kind}`)
  }
  REGISTRY.set(p.kind, p)
}

register(filterMime)
register(filterExtension)
register(filterSize)
register(filterName)
register(transformResize)
register(transformCompress)
register(transformThumbnail)
register(routeMove)
register(routeCopy)
register(routeRename)

export const getPrimitive = (kind: string): Primitive | null => REGISTRY.get(kind) ?? null

export const listPrimitives = (): Primitive[] =>
  [...REGISTRY.values()].sort((a, b) => a.kind.localeCompare(b.kind))

export const describePrimitive = (p: Primitive) => ({
  kind: p.kind,
  name: p.name,
  category: p.category,
  description: p.description,
  icon: p.icon,
  subjects: p.subjects,
  config_schema: p.configSchema,
})
