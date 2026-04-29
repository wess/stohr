import type { Action } from "./types.ts"
import resizeImage from "./stohr/resize.ts"
import organizeByDate from "./stohr/organize.ts"

const REGISTRY = new Map<string, Action>()

const register = (action: Action) => {
  if (REGISTRY.has(action.slug)) {
    throw new Error(`Action slug already registered: ${action.slug}`)
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(action.slug)) {
    throw new Error(`Action slug must match <author>/<name> in lowercase: ${action.slug}`)
  }
  REGISTRY.set(action.slug, action)
}

register(resizeImage)
register(organizeByDate)

export const getAction = (slug: string): Action | null => REGISTRY.get(slug) ?? null

export const listActions = (): Action[] =>
  [...REGISTRY.values()].sort((a, b) => a.slug.localeCompare(b.slug))

export const describeAction = (action: Action) => ({
  slug: action.slug,
  name: action.name,
  description: action.description,
  version: action.version,
  author: action.author,
  homepage: action.homepage ?? null,
  icon: action.icon ?? null,
  permissions: action.permissions,
  events: action.events,
  subjects: action.subjects,
  config_schema: action.configSchema,
})
