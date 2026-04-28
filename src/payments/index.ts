import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, halt, json, parseJson, pipeline, post, put } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { quotaFor, isValidTier, TIER_QUOTAS } from "./quotas.ts"
import {
  type LsEvent,
  type Mode,
  type PaymentConfig,
  type ResolvedConfig,
  checkoutUrl,
  resolveConfig,
  tierForVariant,
  verifySignature,
} from "./lemonsqueezy.ts"
import {
  type AutoSetupResult,
  type LsStore,
  createWebhook,
  listProducts,
  listStores,
  listVariants,
  matchTier,
} from "./lsapi.ts"
import { randomToken } from "../util/token.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const ownerOnly = async (c: any) => {
  if (!c.assigns?.auth?.is_owner) {
    return halt(c, 403, { error: "Owner access required" })
  }
  return c
}

const loadConfig = async (db: Connection): Promise<PaymentConfig> => {
  const row = await db.one(
    from("payment_config").orderBy("id", "ASC").limit(1),
  )
  return (row ?? {
    id: 1,
    mode: "test",
    api_key: null,
    webhook_secret: null,
    store_id: null,
    store_url: null,
    test_mode: true,
    tier_personal_monthly: null,
    tier_personal_yearly: null,
    tier_pro_monthly: null,
    tier_pro_yearly: null,
    tier_studio_monthly: null,
    tier_studio_yearly: null,
    live_webhook_secret: null,
    live_tier_personal_monthly: null,
    live_tier_personal_yearly: null,
    live_tier_pro_monthly: null,
    live_tier_pro_yearly: null,
    live_tier_studio_monthly: null,
    live_tier_studio_yearly: null,
  }) as PaymentConfig
}

const usedBytesFor = async (db: Connection, userId: number): Promise<number> => {
  const rows = await db.all(
    from("files")
      .where(q => q("user_id").equals(userId))
      .where(q => q("deleted_at").isNull())
      .select("size"),
  ) as Array<{ size: number | string }>
  return rows.reduce((acc, r) => acc + Number(r.size), 0)
}

const findUserForEvent = async (
  db: Connection,
  ev: LsEvent,
): Promise<{ id: number } | null> => {
  const customUserId = (ev.meta.custom_data as any)?.user_id
  if (customUserId) {
    const u = await db.one(
      from("users").where(q => q("id").equals(Number(customUserId))).select("id"),
    )
    if (u) return u as { id: number }
  }
  const customerId = ev.data.attributes.customer_id
  if (customerId != null) {
    const u = await db.one(
      from("users").where(q => q("ls_customer_id").equals(String(customerId))).select("id"),
    )
    if (u) return u as { id: number }
  }
  const email = ev.data.attributes.user_email
  if (email) {
    const u = await db.one(
      from("users").where(q => q("email").equals(String(email).toLowerCase())).select("id"),
    )
    if (u) return u as { id: number }
  }
  return null
}

const applySubscriptionEvent = async (
  db: Connection,
  resolved: ResolvedConfig,
  ev: LsEvent,
  userId: number,
) => {
  const a = ev.data.attributes
  const eventName = ev.meta.event_name
  const subId = ev.data.id
  const customerId = a.customer_id != null ? String(a.customer_id) : null
  const status = a.status ?? null
  const renewsAt = a.renews_at ?? null
  const tierMap = tierForVariant(resolved, a.variant_id)
  const isCancelTerminal = ["subscription_expired", "subscription_cancelled"].includes(eventName) && a.ends_at != null

  let nextTier: string | null = null
  if (tierMap) nextTier = tierMap.tier
  if (eventName === "subscription_expired") nextTier = "free"

  const update: Record<string, unknown> = {
    ls_subscription_id: subId,
    ls_customer_id: customerId,
    subscription_status: status,
    subscription_renews_at: renewsAt,
  }
  if (nextTier) {
    update.tier = nextTier
    update.storage_quota_bytes = quotaFor(nextTier)
  }
  if (eventName === "subscription_expired") {
    update.tier = "free"
    update.storage_quota_bytes = quotaFor("free")
    update.ls_subscription_id = null
    update.subscription_status = "expired"
    update.subscription_renews_at = null
  }

  await db.execute(
    from("users").where(q => q("id").equals(userId)).update(update),
  )
}

export const paymentsRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const adminGuard = pipeline(requireAuth({ secret, db }), ownerOnly)
  const adminAuthed = pipeline(requireAuth({ secret, db }), ownerOnly, parseJson)

  return [
    get("/payments/plans", async (c) => {
      const cfg = await loadConfig(db)
      return json(c, 200, {
        store_url: cfg.store_url,
        test_mode: cfg.test_mode,
        tiers: {
          personal: { monthly: cfg.tier_personal_monthly, yearly: cfg.tier_personal_yearly },
          pro: { monthly: cfg.tier_pro_monthly, yearly: cfg.tier_pro_yearly },
          studio: { monthly: cfg.tier_studio_monthly, yearly: cfg.tier_studio_yearly },
        },
      })
    }),

    get("/me/subscription", guard(async (c) => {
      const userId = authId(c)
      const user = await db.one(
        from("users")
          .where(q => q("id").equals(userId))
          .select("tier", "storage_quota_bytes", "subscription_status", "subscription_renews_at", "ls_subscription_id"),
      ) as {
        tier: string
        storage_quota_bytes: number | string
        subscription_status: string | null
        subscription_renews_at: string | null
        ls_subscription_id: string | null
      } | null
      if (!user) return json(c, 404, { error: "User not found" })
      const used = await usedBytesFor(db, userId)
      return json(c, 200, {
        tier: user.tier,
        quota_bytes: Number(user.storage_quota_bytes),
        used_bytes: used,
        status: user.subscription_status,
        renews_at: user.subscription_renews_at,
        has_subscription: !!user.ls_subscription_id,
      })
    })),

    post("/me/checkout", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const tier = url.searchParams.get("tier") ?? ""
      const period = (url.searchParams.get("period") ?? "monthly") as "monthly" | "yearly"
      if (!isValidTier(tier) || tier === "free") return json(c, 422, { error: "Invalid tier" })
      if (period !== "monthly" && period !== "yearly") return json(c, 422, { error: "Invalid period" })

      const cfg = await loadConfig(db)
      const resolved = resolveConfig(cfg)
      const variantKey = `tier_${tier}_${period}` as keyof ResolvedConfig
      const variantId = resolved[variantKey] as string | null
      if (!variantId || !resolved.store_url) {
        return json(c, 503, { error: `Payments not configured for ${resolved.mode} mode. Owner must set it up in Admin → Payments.` })
      }

      const user = await db.one(
        from("users").where(q => q("id").equals(userId)).select("email", "name"),
      ) as { email: string; name: string }

      const url2 = checkoutUrl(resolved, variantId, {
        email: user.email,
        userName: user.name,
        userId,
      })
      return json(c, 200, { checkout_url: url2, mode: resolved.mode })
    })),

    post("/lemonsqueezy/webhook", async (c) => {
      const cfg = await loadConfig(db)
      const sig = c.request.headers.get("x-signature") ?? ""
      const rawBody = await c.request.text()

      let detectedMode: Mode | null = null
      if (cfg.webhook_secret && verifySignature(rawBody, sig, cfg.webhook_secret)) {
        detectedMode = "test"
      } else if (cfg.live_webhook_secret && verifySignature(rawBody, sig, cfg.live_webhook_secret)) {
        detectedMode = "live"
      }

      let event: LsEvent | null = null
      try {
        event = JSON.parse(rawBody) as LsEvent
      } catch {
        await db.execute(from("lemonsqueezy_events").insert({
          event_name: "invalid_json",
          signature_valid: !!detectedMode,
          payload: rawBody.slice(0, 8000),
          error: "Could not parse JSON",
        }))
        return json(c, 400, { error: "Invalid JSON" })
      }

      if (!detectedMode) {
        await db.execute(from("lemonsqueezy_events").insert({
          event_name: event.meta?.event_name ?? "unknown",
          signature_valid: false,
          payload: rawBody.slice(0, 8000),
          error: "Invalid signature (no test or live secret matched)",
        }))
        return json(c, 401, { error: "Invalid signature" })
      }

      const resolved = resolveConfig(cfg, detectedMode)
      const eventName = event.meta?.event_name ?? "unknown"
      let user: { id: number } | null = null
      let errorMsg: string | null = null

      try {
        user = await findUserForEvent(db, event)
        if (
          user &&
          event.data.type === "subscriptions" &&
          [
            "subscription_created",
            "subscription_updated",
            "subscription_cancelled",
            "subscription_resumed",
            "subscription_expired",
            "subscription_paused",
            "subscription_unpaused",
          ].includes(eventName)
        ) {
          await applySubscriptionEvent(db, resolved, event, user.id)
        }
      } catch (e: any) {
        errorMsg = e?.message ?? String(e)
      }

      await db.execute(from("lemonsqueezy_events").insert({
        event_name: `${eventName} (${detectedMode})`,
        signature_valid: true,
        payload: rawBody.slice(0, 16000),
        user_id: user?.id ?? null,
        ls_subscription_id: event.data?.type === "subscriptions" ? event.data.id : null,
        ls_customer_id: event.data?.attributes?.customer_id != null ? String(event.data.attributes.customer_id) : null,
        error: errorMsg,
      }))

      return json(c, 200, { ok: true })
    }),

    get("/admin/payments/config", adminGuard(async (c) => {
      const cfg = await loadConfig(db)
      const masked = (s: string | null) => s ? `${s.slice(0, 4)}…${s.slice(-4)}` : null
      return json(c, 200, {
        ...cfg,
        api_key: masked(cfg.api_key),
        webhook_secret: masked(cfg.webhook_secret),
        live_webhook_secret: masked(cfg.live_webhook_secret),
        api_key_set: !!cfg.api_key,
        webhook_secret_set: !!cfg.webhook_secret,
        live_webhook_secret_set: !!cfg.live_webhook_secret,
      })
    })),

    put("/admin/payments/config", adminAuthed(async (c) => {
      const body = c.body as Partial<PaymentConfig> & { api_key?: string; webhook_secret?: string; live_webhook_secret?: string }
      const update: Record<string, unknown> = { updated_at: raw("NOW()") }
      const fields: Array<keyof PaymentConfig> = [
        "mode", "store_id", "store_url", "test_mode",
        "tier_personal_monthly", "tier_personal_yearly",
        "tier_pro_monthly", "tier_pro_yearly",
        "tier_studio_monthly", "tier_studio_yearly",
        "live_tier_personal_monthly", "live_tier_personal_yearly",
        "live_tier_pro_monthly", "live_tier_pro_yearly",
        "live_tier_studio_monthly", "live_tier_studio_yearly",
      ]
      for (const f of fields) {
        if (f in body) update[f as string] = (body as any)[f] ?? null
      }
      if ("api_key" in body && body.api_key !== undefined && !body.api_key?.includes("…")) {
        update.api_key = body.api_key || null
      }
      if ("webhook_secret" in body && body.webhook_secret !== undefined && !body.webhook_secret?.includes("…")) {
        update.webhook_secret = body.webhook_secret || null
      }
      if ("live_webhook_secret" in body && body.live_webhook_secret !== undefined && !body.live_webhook_secret?.includes("…")) {
        update.live_webhook_secret = body.live_webhook_secret || null
      }
      const cfg = await loadConfig(db)
      await db.execute(
        from("payment_config").where(q => q("id").equals(cfg.id)).update(update),
      )
      return json(c, 200, { ok: true })
    })),

    get("/admin/payments/subscriptions", adminGuard(async (c) => {
      const rows = await db.all(
        from("users")
          .where(q => q("ls_subscription_id").isNotNull())
          .select("id", "username", "email", "tier", "subscription_status", "subscription_renews_at", "ls_subscription_id", "ls_customer_id")
          .orderBy("subscription_renews_at", "DESC")
          .limit(500),
      )
      return json(c, 200, rows)
    })),

    post("/admin/payments/users/:id/tier", adminAuthed(async (c) => {
      const id = Number(c.params.id)
      const body = c.body as { tier?: string }
      const tier = body.tier ?? ""
      if (!isValidTier(tier)) return json(c, 422, { error: "Invalid tier" })
      await db.execute(
        from("users").where(q => q("id").equals(id)).update({
          tier,
          storage_quota_bytes: quotaFor(tier),
        }),
      )
      return json(c, 200, { id, tier, quota_bytes: quotaFor(tier) })
    })),

    post("/admin/payments/autosetup", adminAuthed(async (c) => {
      const body = c.body as { api_key?: string; webhook_url?: string; mode?: Mode }
      const apiKey = (body.api_key ?? "").trim()
      const webhookUrl = body.webhook_url?.trim()
      const mode: Mode = body.mode === "live" ? "live" : "test"
      if (!apiKey) return json(c, 422, { error: "api_key required" })
      if (!webhookUrl) return json(c, 422, { error: "webhook_url required" })

      let stores: LsStore[]
      try {
        stores = await listStores(apiKey)
      } catch (e: any) {
        return json(c, 400, { error: `Could not connect: ${e.message}` })
      }

      const store = stores.find(s =>
        s.name.toLowerCase().includes("stohr") ||
        s.slug.toLowerCase().includes("stohr"),
      )
      if (!store) {
        return json(c, 404, {
          error: 'No store named "stohr" found. Create one in Lemon Squeezy → Stores (call it "stohr"), then try again.',
          stores: stores.map(s => ({ id: s.id, name: s.name })),
        })
      }
      const storeUrl = store.domain ? `https://${store.domain}` : `https://${store.slug}.lemonsqueezy.com`

      const products = await listProducts(apiKey, store.id)
      const plans: AutoSetupResult["plans"] = {
        personal: { monthly: null, yearly: null, product_name: null },
        pro: { monthly: null, yearly: null, product_name: null },
        studio: { monthly: null, yearly: null, product_name: null },
      }
      const unmatched: string[] = []

      for (const p of products) {
        const tier = matchTier(p.name)
        if (!tier) {
          unmatched.push(p.name)
          continue
        }
        plans[tier].product_name = p.name
        const variants = await listVariants(apiKey, p.id)
        for (const v of variants) {
          if (!v.is_subscription) continue
          if (v.status !== "published" && v.status !== "pending") continue
          if (v.interval === "month") plans[tier].monthly = v.id
          else if (v.interval === "year") plans[tier].yearly = v.id
        }
      }

      const cfg = await loadConfig(db)
      const existingSecret = mode === "live" ? cfg.live_webhook_secret : cfg.webhook_secret
      const webhookSecret = existingSecret || randomToken(16)

      let webhookInfo: AutoSetupResult["webhook"] = null
      let webhookErr: string | null = null
      try {
        const wh = await createWebhook(apiKey, store.id, webhookUrl, webhookSecret)
        webhookInfo = { id: wh.id, url: webhookUrl }
      } catch (e: any) {
        webhookErr = e?.message ?? String(e)
      }

      const update: Record<string, unknown> = {
        api_key: apiKey,
        store_id: store.id,
        store_url: storeUrl,
        mode,
        updated_at: raw("NOW()"),
      }
      if (mode === "live") {
        update.live_webhook_secret = webhookInfo ? webhookSecret : cfg.live_webhook_secret
        update.live_tier_personal_monthly = plans.personal.monthly
        update.live_tier_personal_yearly = plans.personal.yearly
        update.live_tier_pro_monthly = plans.pro.monthly
        update.live_tier_pro_yearly = plans.pro.yearly
        update.live_tier_studio_monthly = plans.studio.monthly
        update.live_tier_studio_yearly = plans.studio.yearly
      } else {
        update.webhook_secret = webhookInfo ? webhookSecret : cfg.webhook_secret
        update.tier_personal_monthly = plans.personal.monthly
        update.tier_personal_yearly = plans.personal.yearly
        update.tier_pro_monthly = plans.pro.monthly
        update.tier_pro_yearly = plans.pro.yearly
        update.tier_studio_monthly = plans.studio.monthly
        update.tier_studio_yearly = plans.studio.yearly
      }

      await db.execute(
        from("payment_config").where(q => q("id").equals(cfg.id)).update(update),
      )

      const result: AutoSetupResult & { mode: Mode } = {
        mode,
        store: { id: store.id, name: store.name, slug: store.slug, url: storeUrl },
        webhook: webhookInfo,
        webhook_error: webhookErr,
        plans,
        unmatched_products: unmatched,
      }
      return json(c, 200, result)
    })),

    get("/admin/payments/events", adminGuard(async (c) => {
      const rows = await db.all(
        from("lemonsqueezy_events")
          .select("id", "event_name", "signature_valid", "user_id", "ls_subscription_id", "error", "received_at")
          .orderBy("received_at", "DESC")
          .limit(100),
      )
      return json(c, 200, rows)
    })),
  ]
}

export { TIER_QUOTAS } from "./quotas.ts"
