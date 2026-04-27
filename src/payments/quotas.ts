export const TIER_QUOTAS: Record<string, number> = {
  free: 5 * 1024 * 1024 * 1024,
  personal: 50 * 1024 * 1024 * 1024,
  pro: 250 * 1024 * 1024 * 1024,
  studio: 1024 * 1024 * 1024 * 1024,
}

export const VALID_TIERS = ["free", "personal", "pro", "studio"] as const

export type Tier = typeof VALID_TIERS[number]

export const isValidTier = (t: string): t is Tier => VALID_TIERS.includes(t as Tier)

export const quotaFor = (tier: string): number =>
  TIER_QUOTAS[tier] ?? TIER_QUOTAS.free!
