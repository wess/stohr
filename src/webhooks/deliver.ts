import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"

// Deliver one webhook_deliveries row. Throws on transient failure so the
// job runner retries; permanent failures (deleted hook, malformed url) are
// recorded and returned without throwing.

type DeliveryRow = {
  id: number | string
  webhook_id: number | string
  event: string
  payload: Record<string, unknown> | string
  attempts: number
}

type WebhookRow = {
  id: number | string
  url: string
  secret: string
  enabled: boolean
}

const SIGNATURE_HEADER = "x-stohr-signature"
const EVENT_HEADER = "x-stohr-event"
const DELIVERY_HEADER = "x-stohr-delivery"
const TIMESTAMP_HEADER = "x-stohr-timestamp"

const sign = async (secret: string, body: string, timestamp: string): Promise<string> => {
  // HMAC-SHA256 over `${timestamp}.${body}`. The receiver should reconstruct
  // the same string, recompute, constant-time compare, AND verify the
  // timestamp is within their tolerance window — that prevents replay.
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`))
  const bytes = new Uint8Array(sig)
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return `sha256=${hex}`
}

export const handleWebhookDelivery = async (
  db: Connection,
  payload: { delivery_id: number },
): Promise<void> => {
  const delivery = await db.one(
    from("webhook_deliveries").where(q => q("id").equals(payload.delivery_id)),
  ) as DeliveryRow | null
  if (!delivery) return // already purged

  const hook = await db.one(
    from("webhooks").where(q => q("id").equals(delivery.webhook_id)),
  ) as WebhookRow | null

  if (!hook || !hook.enabled) {
    await db.execute(
      from("webhook_deliveries").where(q => q("id").equals(delivery.id)).update({
        status: "skipped",
        last_error: "webhook disabled or deleted",
      }),
    )
    return
  }

  const body = typeof delivery.payload === "string"
    ? delivery.payload
    : JSON.stringify({ event: delivery.event, data: delivery.payload })

  // Some emitters store the full envelope; others store just the data.
  // Normalize to envelope form on the wire.
  const envelope = (() => {
    try {
      const parsed = typeof delivery.payload === "string" ? JSON.parse(delivery.payload) : delivery.payload
      if (parsed && typeof parsed === "object" && "event" in (parsed as object)) return body
      return JSON.stringify({
        event: delivery.event,
        delivered_at: new Date().toISOString(),
        data: parsed,
      })
    } catch {
      return body
    }
  })()

  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = await sign(hook.secret, envelope, timestamp)
  const deliveryId = String(delivery.id)

  let status = 0
  let responseBody = ""
  let networkErr: string | null = null

  // 10s timeout — receivers that need longer should 202 + queue.
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), 10_000)
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: timestamp,
        [EVENT_HEADER]: delivery.event,
        [DELIVERY_HEADER]: deliveryId,
        "user-agent": "Stohr-Webhook/1.0",
      },
      body: envelope,
      signal: ac.signal,
    })
    status = res.status
    try {
      const text = await res.text()
      responseBody = text.length > 4096 ? text.slice(0, 4096) + "…[truncated]" : text
    } catch { /* ignore body read failures */ }
  } catch (err) {
    networkErr = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timeout)
  }

  const ok = status >= 200 && status < 300
  if (ok) {
    await db.execute(
      from("webhook_deliveries").where(q => q("id").equals(delivery.id)).update({
        status: "delivered",
        response_status: status,
        response_body: responseBody,
        delivered_at: raw("NOW()"),
        attempts: delivery.attempts + 1,
        last_error: null,
      }),
    )
    await db.execute(
      from("webhooks").where(q => q("id").equals(hook.id)).update({
        last_delivery_at: raw("NOW()"),
        last_status: status,
      }),
    )
    return
  }

  // Persist what we know, then throw to signal the job runner to retry.
  // The job runner's exponential backoff governs cadence — we just record
  // the attempt here.
  const errMsg = networkErr ?? `non-2xx response: ${status}`
  await db.execute(
    from("webhook_deliveries").where(q => q("id").equals(delivery.id)).update({
      response_status: status || null,
      response_body: responseBody,
      attempts: delivery.attempts + 1,
      last_error: errMsg,
      status: "pending",
    }),
  )
  await db.execute(
    from("webhooks").where(q => q("id").equals(hook.id)).update({
      last_delivery_at: raw("NOW()"),
      last_status: status || null,
    }),
  )
  throw new Error(errMsg)
}
