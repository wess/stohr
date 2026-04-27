const LS_BASE = "https://api.lemonsqueezy.com/v1"

const lsFetch = async (apiKey: string, path: string, init?: RequestInit) => {
  const res = await fetch(`${LS_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/vnd.api+json",
      "content-type": "application/vnd.api+json",
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Lemon Squeezy ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

export type LsStore = {
  id: string
  name: string
  slug: string
  domain: string | null
}

export type LsProduct = {
  id: string
  name: string
  status: string
}

export type LsVariant = {
  id: string
  product_id: string
  name: string
  price: number
  interval: "day" | "week" | "month" | "year" | null
  interval_count: number | null
  is_subscription: boolean
  status: string
}

const SUBSCRIPTION_EVENTS = [
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
]

export const listStores = async (apiKey: string): Promise<LsStore[]> => {
  const res = await lsFetch(apiKey, "/stores?page[size]=100")
  return (res?.data ?? []).map((d: any) => ({
    id: String(d.id),
    name: d.attributes?.name ?? "",
    slug: d.attributes?.slug ?? "",
    domain: d.attributes?.domain ?? null,
  }))
}

export const listProducts = async (apiKey: string, storeId: string): Promise<LsProduct[]> => {
  const res = await lsFetch(apiKey, `/products?filter[store_id]=${storeId}&page[size]=100`)
  return (res?.data ?? []).map((d: any) => ({
    id: String(d.id),
    name: d.attributes?.name ?? "",
    status: d.attributes?.status ?? "",
  }))
}

export const listVariants = async (apiKey: string, productId: string): Promise<LsVariant[]> => {
  const res = await lsFetch(apiKey, `/variants?filter[product_id]=${productId}&page[size]=100`)
  return (res?.data ?? []).map((d: any) => ({
    id: String(d.id),
    product_id: String(productId),
    name: d.attributes?.name ?? "",
    price: Number(d.attributes?.price ?? 0),
    interval: d.attributes?.interval ?? null,
    interval_count: d.attributes?.interval_count ?? null,
    is_subscription: !!d.attributes?.is_subscription,
    status: d.attributes?.status ?? "",
  }))
}

export const createWebhook = async (
  apiKey: string,
  storeId: string,
  url: string,
  secret: string,
): Promise<{ id: string }> => {
  const res = await lsFetch(apiKey, "/webhooks", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "webhooks",
        attributes: {
          url,
          events: SUBSCRIPTION_EVENTS,
          secret,
        },
        relationships: {
          store: { data: { type: "stores", id: storeId } },
        },
      },
    }),
  })
  return { id: String(res.data.id) }
}

export const matchTier = (productName: string): "personal" | "pro" | "studio" | null => {
  const n = productName.toLowerCase()
  if (n.includes("studio") || n.includes("team") || n.includes("business")) return "studio"
  if (n.includes("pro")) return "pro"
  if (n.includes("personal") || n.includes("plus") || n.includes("starter")) return "personal"
  return null
}

export type AutoSetupResult = {
  store: { id: string; name: string; slug: string; url: string }
  webhook: { id: string; url: string } | null
  webhook_error: string | null
  plans: Record<string, { monthly: string | null; yearly: string | null; product_name: string | null }>
  unmatched_products: string[]
}
