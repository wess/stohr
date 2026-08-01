// Listing endpoints return a bare JSON array, and four SDKs plus the SPA are
// built on that shape — so paging is expressed in query params and response
// headers rather than by wrapping the body in an envelope.
//
// Accepts `limit`/`offset` in both snake_case and camelCase, matching how the
// rest of the API reads params.
export type Paging = { limit: number; offset: number }

export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 1000

const readInt = (url: URL, ...names: string[]): number | null => {
  for (const n of names) {
    const raw = url.searchParams.get(n)
    if (raw === null || raw === "") continue
    const v = Number(raw)
    if (Number.isFinite(v)) return Math.floor(v)
  }
  return null
}

export const parsePaging = (url: URL, defaultLimit = DEFAULT_LIMIT): Paging => {
  const rawLimit = readInt(url, "limit")
  const rawOffset = readInt(url, "offset")
  return {
    limit: Math.max(1, Math.min(rawLimit ?? defaultLimit, MAX_LIMIT)),
    offset: Math.max(0, rawOffset ?? 0),
  }
}

// A page that comes back full is the signal that another one may exist. This
// avoids a COUNT(*) on every listing — the client only needs to know whether
// to offer "load more", not the exact total.
export const pagingHeaders = (
  c: any,
  putHeader: (conn: any, k: string, v: string) => any,
  paging: Paging,
  returned: number,
): any => {
  const more = returned >= paging.limit
  let out = putHeader(c, "x-limit", String(paging.limit))
  out = putHeader(out, "x-offset", String(paging.offset))
  out = putHeader(out, "x-has-more", more ? "true" : "false")
  return out
}
