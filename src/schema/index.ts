import { column, defineSchema } from "@atlas/db"

export const users = defineSchema("users", {
  id: column.serial().primaryKey(),
  email: column.text().unique(),
  username: column.text().unique(),
  name: column.text(),
  password: column.text(),
  is_owner: column.boolean().default(false),
  tier: column.text().default("free"),
  storage_quota_bytes: column.bigint().default(5368709120),
  ls_customer_id: column.text().nullable(),
  ls_subscription_id: column.text().nullable(),
  subscription_status: column.text().nullable(),
  subscription_renews_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const paymentConfig = defineSchema("payment_config", {
  id: column.serial().primaryKey(),
  provider: column.text().default("lemonsqueezy"),
  api_key: column.text().nullable(),
  webhook_secret: column.text().nullable(),
  store_id: column.text().nullable(),
  store_url: column.text().nullable(),
  test_mode: column.boolean().default(true),
  mode: column.text().default("test"),
  tier_personal_monthly: column.text().nullable(),
  tier_personal_yearly: column.text().nullable(),
  tier_pro_monthly: column.text().nullable(),
  tier_pro_yearly: column.text().nullable(),
  tier_studio_monthly: column.text().nullable(),
  tier_studio_yearly: column.text().nullable(),
  live_webhook_secret: column.text().nullable(),
  live_tier_personal_monthly: column.text().nullable(),
  live_tier_personal_yearly: column.text().nullable(),
  live_tier_pro_monthly: column.text().nullable(),
  live_tier_pro_yearly: column.text().nullable(),
  live_tier_studio_monthly: column.text().nullable(),
  live_tier_studio_yearly: column.text().nullable(),
  created_at: column.timestamp().default("now()"),
  updated_at: column.timestamp().default("now()"),
})

export const lemonsqueezyEvents = defineSchema("lemonsqueezy_events", {
  id: column.serial().primaryKey(),
  event_name: column.text(),
  signature_valid: column.boolean(),
  payload: column.text(),
  user_id: column.integer().nullable().ref("users", "id"),
  ls_subscription_id: column.text().nullable(),
  ls_customer_id: column.text().nullable(),
  error: column.text().nullable(),
  received_at: column.timestamp().default("now()"),
})

export const inviteRequests = defineSchema("invite_requests", {
  id: column.serial().primaryKey(),
  email: column.text(),
  name: column.text().nullable(),
  reason: column.text().nullable(),
  status: column.text().default("pending"),
  processed_at: column.timestamp().nullable(),
  processed_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp().default("now()"),
})

export const invites = defineSchema("invites", {
  id: column.serial().primaryKey(),
  token: column.text().unique(),
  email: column.text().nullable(),
  invited_by: column.integer().nullable().ref("users", "id"),
  used_at: column.timestamp().nullable(),
  used_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp().default("now()"),
})

export const collaborations = defineSchema("collaborations", {
  id: column.serial().primaryKey(),
  resource_type: column.text(),
  resource_id: column.integer(),
  user_id: column.integer().nullable().ref("users", "id"),
  email: column.text().nullable(),
  role: column.text().default("viewer"),
  invited_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp().default("now()"),
  accepted_at: column.timestamp().nullable(),
})

export const folders = defineSchema("folders", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  parent_id: column.integer().nullable().ref("folders", "id"),
  name: column.text(),
  kind: column.text().default("standard"),
  is_public: column.boolean().default(false),
  deleted_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const files = defineSchema("files", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  folder_id: column.integer().nullable().ref("folders", "id"),
  name: column.text(),
  mime: column.text(),
  size: column.bigint(),
  storage_key: column.text(),
  thumb_key: column.text().nullable(),
  version: column.integer().default(1),
  deleted_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const fileVersions = defineSchema("file_versions", {
  id: column.serial().primaryKey(),
  file_id: column.integer().ref("files", "id"),
  version: column.integer(),
  mime: column.text(),
  size: column.bigint(),
  storage_key: column.text(),
  uploaded_by: column.integer().nullable().ref("users", "id"),
  uploaded_at: column.timestamp().default("now()"),
})

export const shares = defineSchema("shares", {
  id: column.serial().primaryKey(),
  file_id: column.integer().ref("files", "id"),
  user_id: column.integer().ref("users", "id"),
  token: column.text().unique(),
  expires_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})
