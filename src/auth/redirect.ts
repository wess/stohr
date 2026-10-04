// Where to send the browser after an external sign-in. The target arrives as
// a query parameter, so it is resolved against this app's own URL and must
// land on the same origin — that rejects "//evil", "/\evil" (browsers read
// the backslash as a slash), "javascript:" and friends in one check. Only
// path + query survive; a fragment would collide with the #token handoff.

export const safeRedirectPath = (requested: string | null | undefined, appUrl: string): string => {
  if (!requested) return "/"
  let app: URL
  let target: URL
  try {
    app = new URL(appUrl)
    target = new URL(requested, app)
  } catch {
    return "/"
  }
  if (target.origin !== app.origin) return "/"
  return `${target.pathname}${target.search}`
}
