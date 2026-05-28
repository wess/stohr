import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"

export type LdapConfig = {
  enabled: boolean
  url: string | null
  start_tls: boolean
  bind_dn: string | null
  bind_password: string | null
  user_search_base: string | null
  user_filter: string
  email_attr: string
  name_attr: string
  username_attr: string
  auto_provision: boolean
}

export const loadLdapConfig = async (db: Connection): Promise<LdapConfig> => {
  const row = await db.one(
    from("ldap_config")
      .where(q => q("id").equals(1))
      .select(
        "enabled",
        "url",
        "start_tls",
        "bind_dn",
        "bind_password",
        "user_search_base",
        "user_filter",
        "email_attr",
        "name_attr",
        "username_attr",
        "auto_provision",
      ),
  ) as LdapConfig | null
  return row ?? {
    enabled: false,
    url: null,
    start_tls: false,
    bind_dn: null,
    bind_password: null,
    user_search_base: null,
    user_filter: "(uid={username})",
    email_attr: "mail",
    name_attr: "cn",
    username_attr: "uid",
    auto_provision: true,
  }
}

export const isLdapReady = (cfg: LdapConfig): boolean =>
  cfg.enabled && !!cfg.url && !!cfg.user_search_base

export const updateLdapConfig = async (
  db: Connection,
  patch: Partial<LdapConfig>,
  userId: number,
): Promise<LdapConfig> => {
  const existing = await db.one(
    from("ldap_config").where(q => q("id").equals(1)).select("id"),
  ) as { id: number } | null
  if (!existing) {
    await db.execute(
      from("ldap_config").insert({ id: 1, updated_by: userId }),
    )
  }

  const allowed: (keyof LdapConfig)[] = [
    "enabled",
    "url",
    "start_tls",
    "bind_dn",
    "bind_password",
    "user_search_base",
    "user_filter",
    "email_attr",
    "name_attr",
    "username_attr",
    "auto_provision",
  ]
  const update: Record<string, unknown> = { updated_at: raw("NOW()"), updated_by: userId }
  for (const key of allowed) {
    if (key in patch) update[key] = (patch as Record<string, unknown>)[key]
  }
  await db.execute(
    from("ldap_config").where(q => q("id").equals(1)).update(update),
  )
  return loadLdapConfig(db)
}
