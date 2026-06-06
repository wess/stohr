import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { requireSettingEnabled, SETTING_WEBDAV_ENABLED } from "../settings/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// WebDAV authenticates with the account email + an existing Personal Access
// Token (no separate WebDAV password). These endpoints back the Settings →
// WebDAV panel: status reflects whether the user has at least one PAT to use
// as the WebDAV password, and the enable/disable mutations just point the
// user at the Apps panel where PATs are minted and revoked.
export const webdavSettingsRoutes = (db: Connection, secret: string) => {
  const gate = requireSettingEnabled(db, SETTING_WEBDAV_ENABLED)
  const authed = pipeline(gate, requireAuth({ secret, db, noOAuth: true }))

  return [
    get(
      "/me/webdav",
      authed(async c => {
        const userId = authId(c)
        const app = (await db.one(
          from("apps")
            .where(q => q("user_id").equals(userId))
            .select("last_used_at", "created_at")
            .orderBy("created_at", "DESC"),
        )) as { last_used_at: string | null; created_at: string } | null
        return json(c, 200, {
          enabled: app != null,
          uses_pat: true,
          last_used_at: app?.last_used_at ?? null,
          updated_at: app?.created_at ?? null,
        })
      }),
    ),

    post(
      "/me/webdav",
      authed(async c =>
        json(c, 200, {
          enabled: true,
          uses_pat: true,
          message: "WebDAV uses your account email and a Personal Access Token. Create one under Settings → Apps.",
        }),
      ),
    ),

    del(
      "/me/webdav",
      authed(async c =>
        json(c, 200, {
          message: "Revoke the Personal Access Token under Settings → Apps to disable WebDAV access.",
        }),
      ),
    ),
  ]
}
