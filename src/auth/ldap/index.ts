import type { Connection } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { logEvent } from "../../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../../security/ratelimit.ts"
import { issueSession } from "../../security/sessions.ts"
import { upsertFromExternal } from "../external.ts"
import { authenticateLdap } from "./client.ts"
import { isLdapReady, loadLdapConfig } from "./config.ts"

export const ldapRoutes = (db: Connection, secret: string) => {
  const api = pipeline(parseJson)

  return [
    get("/auth/ldap/status", async c => {
      const cfg = await loadLdapConfig(db)
      return json(c, 200, { available: isLdapReady(cfg) })
    }),

    post(
      "/auth/ldap/login",
      api(async c => {
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)
        const body = c.body as { identity?: string; username?: string; password?: string }
        const identity = (body.identity ?? body.username ?? "").trim()
        const password = body.password ?? ""
        if (!identity || !password) {
          return json(c, 422, { error: "identity and password are required" })
        }

        const ipRate = await checkRate(db, `ldap:ip:${ip}`, 30, 900)
        if (!ipRate.ok) return json(c, 429, { error: "Too many attempts.", retry_after: ipRate.retryAfterSeconds })
        const idRate = await checkRate(db, `ldap:id:${identity.toLowerCase()}`, 5, 900)
        if (!idRate.ok)
          return json(c, 429, { error: "Too many attempts for this account.", retry_after: idRate.retryAfterSeconds })

        const cfg = await loadLdapConfig(db)
        if (!isLdapReady(cfg)) {
          return json(c, 503, { error: "LDAP is not configured on this instance" })
        }

        let profile
        try {
          profile = await authenticateLdap(cfg, identity, password)
        } catch (err) {
          const msg = (err as Error).message
          logEvent(db, { event: "ldap.login_fail", metadata: { identity, reason: msg }, ip, userAgent: ua })
          // Always surface a generic 401 to the client — internal errors
          // (timeout, misconfig) shouldn't leak as 5xx because that would
          // tell an attacker which usernames trigger DB lookups.
          return json(c, 401, { error: "Invalid credentials" })
        }

        let user
        try {
          const result = await upsertFromExternal(
            db,
            {
              provider: "ldap",
              subject: profile.dn,
              email: profile.email?.toLowerCase() ?? null,
              display_name: profile.display_name,
              preferred_username: profile.username,
            },
            { autoProvision: cfg.auto_provision },
          )
          user = result.user
          logEvent(db, {
            userId: user.id,
            event: result.created ? "ldap.signup" : "ldap.login",
            ip,
            userAgent: ua,
          })
        } catch (err) {
          logEvent(db, {
            event: "ldap.provision_fail",
            metadata: { identity, reason: (err as Error).message },
            ip,
            userAgent: ua,
          })
          return json(c, 403, { error: (err as Error).message })
        }

        if (user.deleted_at) {
          return json(c, 403, {
            error: "Account is scheduled for deletion. Click the cancel link in your email to restore it.",
            account_deleted: true,
          })
        }

        const sess = await issueSession(
          db,
          {
            id: user.id,
            email: user.email,
            username: user.username,
            name: user.name,
            is_owner: user.is_owner,
          },
          secret,
          { ip, userAgent: ua },
        )

        return json(c, 200, {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          is_owner: user.is_owner,
          token: sess.token,
        })
      }),
    ),
  ]
}
