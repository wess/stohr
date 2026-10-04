import { createHmac } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { checkUrl, type SafeUrlOpts, safeFetch, type UrlCheck } from "../util/safeurl/index.ts"

// Outbound webhook delivery. Fire-and-forget: we do not block the
// triggering API response on the HTTP call to the user's endpoint.
// Each delivery is recorded in `webhook_deliveries` (status + duration,
// never the receiver's response) so the SPA's "Recent deliveries" view
// can surface failures.
//
// Signing: when the webhook row has a `secret`, we send
//   X-Stohr-Signature: sha256=<hmac>
// computed over the exact request body the receiver gets. This matches
// the GitHub convention so existing receivers can drop in.

export type WebhookEvent = "share.created" | "file.created" | "file.deleted" | "collaboration.invited"

export const WEBHOOK_EVENTS: WebhookEvent[] = ["share.created", "file.created", "file.deleted", "collaboration.invited"]

type WebhookRow = {
  id: number
  url: string
  secret: string | null
  content_type: string
  events: string
  active: boolean
}

const DELIVERY_TIMEOUT_MS = 10_000

// Webhook targets are user-supplied, so they get the SSRF guard. Plain http
// stays allowed (the scheme isn't the risk, the address is); redirects are
// not followed — point the hook at its final URL. WEBHOOKS_ALLOW_PRIVATE=true
// is the homelab escape hatch for posting to a LAN service.
export const webhookUrlOpts = (): SafeUrlOpts => ({
  allowHttp: true,
  allowPrivate: /^(1|true|yes)$/i.test((process.env.WEBHOOKS_ALLOW_PRIVATE ?? "").trim()),
  maxRedirects: 0,
})

export const checkWebhookUrl = (raw: string): Promise<UrlCheck> => checkUrl(raw, webhookUrlOpts())

export const sign = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

export const buildBody = (contentType: string, payload: unknown): string => {
  if (contentType === "application/x-www-form-urlencoded") {
    // GitHub-style: the JSON sits inside a `payload=` form field.
    const params = new URLSearchParams()
    params.set("payload", JSON.stringify(payload))
    return params.toString()
  }
  return JSON.stringify(payload)
}

const recordDelivery = (
  db: Connection,
  webhookId: number,
  event: WebhookEvent,
  payloadStr: string,
  status: number | null,
  durationMs: number,
) => {
  void db
    .execute(
      from("webhook_deliveries").insert({
        webhook_id: webhookId,
        event,
        payload: payloadStr,
        status_code: status,
        duration_ms: durationMs,
      }),
    )
    .catch(err => console.error("[webhooks] failed to record delivery:", err))
}

const deliverOne = async (db: Connection, hook: WebhookRow, event: WebhookEvent, payload: unknown): Promise<void> => {
  const body = buildBody(hook.content_type, payload)
  const headers: Record<string, string> = {
    "content-type": hook.content_type,
    "user-agent": "Stohr-Webhook/1.0",
    "x-stohr-event": event,
    "x-stohr-delivery": crypto.randomUUID(),
  }
  if (hook.secret) headers["x-stohr-signature"] = sign(hook.secret, body)

  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS)

  try {
    const res = await safeFetch(hook.url, { method: "POST", headers, body, signal: ctrl.signal }, webhookUrlOpts())
    await res.body?.cancel().catch(() => {})
    recordDelivery(db, hook.id, event, body, res.status, Date.now() - started)
  } catch (err) {
    console.error(`[webhooks] delivery to hook ${hook.id} failed:`, err instanceof Error ? err.message : err)
    recordDelivery(db, hook.id, event, body, null, Date.now() - started)
  } finally {
    clearTimeout(timer)
  }
}

// Public entry point. Takes a snapshot of the user's hooks, filters by
// event subscription, and fires each one in parallel without awaiting
// the lot. The triggering request returns immediately.
export const dispatchWebhook = (db: Connection, userId: number, event: WebhookEvent, payload: unknown): void => {
  void (async () => {
    try {
      const hooks = (await db.all(
        from("webhooks")
          .where(q => q("user_id").equals(userId))
          .where(q => q("active").equals(true))
          .select("id", "url", "secret", "content_type", "events", "active"),
      )) as WebhookRow[]
      const targets = hooks.filter(h => {
        try {
          const subs = JSON.parse(h.events) as string[]
          return Array.isArray(subs) && subs.includes(event)
        } catch {
          return false
        }
      })
      // Run deliveries in parallel — they are independent, and one slow
      // endpoint should not delay the others.
      await Promise.allSettled(targets.map(h => deliverOne(db, h, event, payload)))
    } catch (err) {
      console.error("[webhooks] dispatch failed:", err)
    }
  })()
}
