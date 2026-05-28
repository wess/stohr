import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"

export type OidcConfig = {
  enabled: boolean
  issuer_url: string | null
  client_id: string | null
  client_secret: string | null
  scopes: string
  button_label: string
  auto_provision: boolean
  email_claim: string
  name_claim: string
  username_claim: string
}

export const loadOidcConfig = async (db: Connection): Promise<OidcConfig> => {
  const row = await db.one(
    from("oidc_config")
      .where(q => q("id").equals(1))
      .select(
        "enabled",
        "issuer_url",
        "client_id",
        "client_secret",
        "scopes",
        "button_label",
        "auto_provision",
        "email_claim",
        "name_claim",
        "username_claim",
      ),
  ) as OidcConfig | null
  return row ?? {
    enabled: false,
    issuer_url: null,
    client_id: null,
    client_secret: null,
    scopes: "openid profile email",
    button_label: "Sign in with SSO",
    auto_provision: true,
    email_claim: "email",
    name_claim: "name",
    username_claim: "preferred_username",
  }
}

export const isOidcReady = (cfg: OidcConfig): boolean =>
  cfg.enabled && !!cfg.issuer_url && !!cfg.client_id && !!cfg.client_secret

export const updateOidcConfig = async (
  db: Connection,
  patch: Partial<OidcConfig>,
  userId: number,
): Promise<OidcConfig> => {
  // Upsert: if the singleton row got wiped (tests truncate, fresh DB
  // before migration seed) we re-create it instead of silently no-op'ing
  // the update.
  const existing = await db.one(
    from("oidc_config").where(q => q("id").equals(1)).select("id"),
  ) as { id: number } | null
  if (!existing) {
    await db.execute(
      from("oidc_config").insert({ id: 1, updated_by: userId }),
    )
  }

  const allowed: (keyof OidcConfig)[] = [
    "enabled",
    "issuer_url",
    "client_id",
    "client_secret",
    "scopes",
    "button_label",
    "auto_provision",
    "email_claim",
    "name_claim",
    "username_claim",
  ]
  const update: Record<string, unknown> = { updated_at: raw("NOW()"), updated_by: userId }
  for (const key of allowed) {
    if (key in patch) update[key] = (patch as Record<string, unknown>)[key]
  }
  await db.execute(
    from("oidc_config").where(q => q("id").equals(1)).update(update),
  )
  return loadOidcConfig(db)
}
