import type { Connection } from "@atlas/db"
import { get, json, parseJson, pipeline, post, put } from "@atlas/server"
import { requireAuth } from "../guard.ts"
import { ownerOnly } from "../../security/owner.ts"
import { authenticateLdap } from "./client.ts"
import { isLdapReady, loadLdapConfig, type LdapConfig, updateLdapConfig } from "./config.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const redact = (cfg: LdapConfig) => ({
  enabled: cfg.enabled,
  url: cfg.url,
  start_tls: cfg.start_tls,
  bind_dn: cfg.bind_dn,
  has_bind_password: !!cfg.bind_password,
  user_search_base: cfg.user_search_base,
  user_filter: cfg.user_filter,
  email_attr: cfg.email_attr,
  name_attr: cfg.name_attr,
  username_attr: cfg.username_attr,
  auto_provision: cfg.auto_provision,
})

export const adminLdapRoutes = (db: Connection, secret: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get("/admin/ldap", guard(async (c) => {
      const cfg = await loadLdapConfig(db)
      return json(c, 200, redact(cfg))
    })),

    put("/admin/ldap", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as Partial<LdapConfig> & { bind_password?: string | null }
      const patch: Partial<LdapConfig> = {}
      if (body.enabled !== undefined) patch.enabled = !!body.enabled
      if (body.url !== undefined) patch.url = body.url
      if (body.start_tls !== undefined) patch.start_tls = !!body.start_tls
      if (body.bind_dn !== undefined) patch.bind_dn = body.bind_dn
      if (body.bind_password !== undefined && body.bind_password !== "") {
        patch.bind_password = body.bind_password
      }
      if (body.user_search_base !== undefined) patch.user_search_base = body.user_search_base
      if (body.user_filter !== undefined) patch.user_filter = body.user_filter
      if (body.email_attr !== undefined) patch.email_attr = body.email_attr
      if (body.name_attr !== undefined) patch.name_attr = body.name_attr
      if (body.username_attr !== undefined) patch.username_attr = body.username_attr
      if (body.auto_provision !== undefined) patch.auto_provision = !!body.auto_provision

      const fresh = await updateLdapConfig(db, patch, userId)
      return json(c, 200, redact(fresh))
    })),

    // Owner-only smoke test: try a bind with the supplied creds against the
    // current config. Helpful when filling out the form for the first time.
    post("/admin/ldap/test", authed(async (c) => {
      const body = c.body as { identity?: string; password?: string }
      if (!body.identity || !body.password) {
        return json(c, 422, { error: "identity and password required" })
      }
      const cfg = await loadLdapConfig(db)
      if (!isLdapReady(cfg)) return json(c, 503, { error: "LDAP is not configured" })
      try {
        const profile = await authenticateLdap(cfg, body.identity, body.password)
        return json(c, 200, { ok: true, profile })
      } catch (err) {
        return json(c, 200, { ok: false, error: (err as Error).message })
      }
    })),
  ]
}
