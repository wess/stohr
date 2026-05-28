import type { Connection } from "@atlas/db"
import { get, json, parseJson, pipeline, put } from "@atlas/server"
import { requireAuth } from "../guard.ts"
import { ownerOnly } from "../../security/owner.ts"
import { loadOidcConfig, type OidcConfig, updateOidcConfig } from "./config.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const redact = (cfg: OidcConfig) => ({
  enabled: cfg.enabled,
  issuer_url: cfg.issuer_url,
  client_id: cfg.client_id,
  has_client_secret: !!cfg.client_secret,
  scopes: cfg.scopes,
  button_label: cfg.button_label,
  auto_provision: cfg.auto_provision,
  email_claim: cfg.email_claim,
  name_claim: cfg.name_claim,
  username_claim: cfg.username_claim,
})

export const adminOidcRoutes = (db: Connection, secret: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get("/admin/oidc", guard(async (c) => {
      const cfg = await loadOidcConfig(db)
      return json(c, 200, redact(cfg))
    })),

    put("/admin/oidc", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as Partial<OidcConfig> & { client_secret?: string | null }
      const patch: Partial<OidcConfig> = {}
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return json(c, 422, { error: "enabled must be boolean" })
        patch.enabled = body.enabled
      }
      if (body.issuer_url !== undefined) {
        if (body.issuer_url !== null && typeof body.issuer_url !== "string") return json(c, 422, { error: "issuer_url must be string or null" })
        patch.issuer_url = body.issuer_url
      }
      if (body.client_id !== undefined) patch.client_id = body.client_id
      // Sentinel: PUT with client_secret: "" leaves the existing value alone
      // so the form can omit secrets when the admin only wants to change
      // other fields. Send `null` to clear.
      if (body.client_secret !== undefined && body.client_secret !== "") {
        patch.client_secret = body.client_secret
      }
      if (body.scopes !== undefined) patch.scopes = body.scopes
      if (body.button_label !== undefined) patch.button_label = body.button_label
      if (body.auto_provision !== undefined) {
        if (typeof body.auto_provision !== "boolean") return json(c, 422, { error: "auto_provision must be boolean" })
        patch.auto_provision = body.auto_provision
      }
      if (body.email_claim !== undefined) patch.email_claim = body.email_claim
      if (body.name_claim !== undefined) patch.name_claim = body.name_claim
      if (body.username_claim !== undefined) patch.username_claim = body.username_claim

      const fresh = await updateOidcConfig(db, patch, userId)
      return json(c, 200, redact(fresh))
    })),
  ]
}
