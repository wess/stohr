import { createHmac, timingSafeEqual } from "node:crypto"

export type Mode = "test" | "live"

export type PaymentConfig = {
  id: number
  mode: Mode
  api_key: string | null
  webhook_secret: string | null
  store_id: string | null
  store_url: string | null
  test_mode: boolean
  tier_personal_monthly: string | null
  tier_personal_yearly: string | null
  tier_pro_monthly: string | null
  tier_pro_yearly: string | null
  tier_studio_monthly: string | null
  tier_studio_yearly: string | null
  live_webhook_secret: string | null
  live_tier_personal_monthly: string | null
  live_tier_personal_yearly: string | null
  live_tier_pro_monthly: string | null
  live_tier_pro_yearly: string | null
  live_tier_studio_monthly: string | null
  live_tier_studio_yearly: string | null
}

export type ResolvedConfig = {
  mode: Mode
  api_key: string | null
  webhook_secret: string | null
  store_id: string | null
  store_url: string | null
  tier_personal_monthly: string | null
  tier_personal_yearly: string | null
  tier_pro_monthly: string | null
  tier_pro_yearly: string | null
  tier_studio_monthly: string | null
  tier_studio_yearly: string | null
}

export const resolveConfig = (cfg: PaymentConfig, modeOverride?: Mode): ResolvedConfig => {
  const mode = modeOverride ?? cfg.mode
  if (mode === "live") {
    return {
      mode,
      api_key: cfg.api_key,
      webhook_secret: cfg.live_webhook_secret,
      store_id: cfg.store_id,
      store_url: cfg.store_url,
      tier_personal_monthly: cfg.live_tier_personal_monthly,
      tier_personal_yearly: cfg.live_tier_personal_yearly,
      tier_pro_monthly: cfg.live_tier_pro_monthly,
      tier_pro_yearly: cfg.live_tier_pro_yearly,
      tier_studio_monthly: cfg.live_tier_studio_monthly,
      tier_studio_yearly: cfg.live_tier_studio_yearly,
    }
  }
  return {
    mode: "test",
    api_key: cfg.api_key,
    webhook_secret: cfg.webhook_secret,
    store_id: cfg.store_id,
    store_url: cfg.store_url,
    tier_personal_monthly: cfg.tier_personal_monthly,
    tier_personal_yearly: cfg.tier_personal_yearly,
    tier_pro_monthly: cfg.tier_pro_monthly,
    tier_pro_yearly: cfg.tier_pro_yearly,
    tier_studio_monthly: cfg.tier_studio_monthly,
    tier_studio_yearly: cfg.tier_studio_yearly,
  }
}

export type LsEvent = {
  meta: {
    event_name: string
    custom_data?: Record<string, unknown>
  }
  data: {
    type: string
    id: string
    attributes: {
      store_id?: number
      customer_id?: number
      user_email?: string
      user_name?: string
      status?: string
      renews_at?: string | null
      ends_at?: string | null
      variant_id?: number | string
      product_id?: number | string
      [k: string]: unknown
    }
  }
}

export const verifySignature = (rawBody: string, signature: string, secret: string): boolean => {
  if (!signature || !secret) return false
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const a = Buffer.from(signature, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export const tierForVariant = (
  config: ResolvedConfig,
  variantId: string | number | undefined,
): { tier: string; period: "monthly" | "yearly" } | null => {
  if (variantId == null) return null
  const id = String(variantId)
  if (id === config.tier_personal_monthly) return { tier: "personal", period: "monthly" }
  if (id === config.tier_personal_yearly) return { tier: "personal", period: "yearly" }
  if (id === config.tier_pro_monthly) return { tier: "pro", period: "monthly" }
  if (id === config.tier_pro_yearly) return { tier: "pro", period: "yearly" }
  if (id === config.tier_studio_monthly) return { tier: "studio", period: "monthly" }
  if (id === config.tier_studio_yearly) return { tier: "studio", period: "yearly" }
  return null
}

export const checkoutUrl = (
  config: ResolvedConfig,
  variantId: string,
  opts: { email?: string; userId?: number; userName?: string },
): string | null => {
  if (!config.store_url) return null
  const base = config.store_url.replace(/\/$/, "")
  const url = new URL(`${base}/buy/${variantId}`)
  if (opts.email) url.searchParams.set("checkout[email]", opts.email)
  if (opts.userName) url.searchParams.set("checkout[name]", opts.userName)
  if (opts.userId != null) url.searchParams.set("checkout_data[custom][user_id]", String(opts.userId))
  return url.toString()
}
