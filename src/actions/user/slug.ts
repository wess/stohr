const PREFIX = "u/"

export const parseUserSlug = (slug: string): number | null => {
  if (!slug.startsWith(PREFIX)) return null
  const id = parseInt(slug.slice(PREFIX.length), 10)
  return Number.isFinite(id) && id > 0 ? id : null
}

export const formatUserSlug = (id: number): string => `${PREFIX}${id}`
