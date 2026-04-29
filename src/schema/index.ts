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
  totp_secret: column.text().nullable(),
  totp_enabled: column.boolean().default(false),
  totp_backup_codes: column.text().nullable(),
  totp_enabled_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const rateLimits = defineSchema("rate_limits", {
  bucket: column.text().primaryKey(),
  count: column.integer().default(0),
  window_started_at: column.timestamp().default("now()"),
})

export const auditEvents = defineSchema("audit_events", {
  id: column.serial().primaryKey(),
  user_id: column.integer().nullable().ref("users", "id"),
  event: column.text(),
  metadata: column.text().nullable(),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const sessions = defineSchema("sessions", {
  id: column.text().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  expires_at: column.timestamp(),
  revoked_at: column.timestamp().nullable(),
  last_used_at: column.timestamp().default("now()"),
  created_at: column.timestamp().default("now()"),
})

export const oauthClients = defineSchema("oauth_clients", {
  id: column.serial().primaryKey(),
  client_id: column.text().unique(),
  client_secret_hash: column.text().nullable(),
  name: column.text(),
  description: column.text().nullable(),
  icon_url: column.text().nullable(),
  redirect_uris: column.text(),
  allowed_scopes: column.text(),
  is_official: column.boolean().default(false),
  created_by: column.integer().nullable().ref("users", "id"),
  created_at: column.timestamp().default("now()"),
  revoked_at: column.timestamp().nullable(),
})

export const oauthAuthorizationCodes = defineSchema("oauth_authorization_codes", {
  code: column.text().primaryKey(),
  client_id: column.text(),
  user_id: column.integer().ref("users", "id"),
  redirect_uri: column.text(),
  code_challenge: column.text(),
  code_challenge_method: column.text().default("S256"),
  scope: column.text(),
  expires_at: column.timestamp(),
  used_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const oauthDeviceCodes = defineSchema("oauth_device_codes", {
  device_code: column.text().primaryKey(),
  user_code: column.text().unique(),
  client_id: column.text(),
  scope: column.text(),
  user_id: column.integer().nullable().ref("users", "id"),
  approved_at: column.timestamp().nullable(),
  denied_at: column.timestamp().nullable(),
  last_polled_at: column.timestamp().nullable(),
  expires_at: column.timestamp(),
  created_at: column.timestamp().default("now()"),
})

export const oauthRefreshTokens = defineSchema("oauth_refresh_tokens", {
  token_hash: column.text().primaryKey(),
  client_id: column.text(),
  user_id: column.integer().ref("users", "id"),
  scope: column.text(),
  parent_token_hash: column.text().nullable(),
  expires_at: column.timestamp(),
  revoked_at: column.timestamp().nullable(),
  last_used_at: column.timestamp().default("now()"),
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

export const apps = defineSchema("apps", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  name: column.text(),
  description: column.text().nullable(),
  token_hash: column.text().unique(),
  token_prefix: column.text(),
  last_used_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const s3AccessKeys = defineSchema("s3_access_keys", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  access_key: column.text().unique(),
  secret_key: column.text(),
  name: column.text().nullable(),
  last_used_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
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
  token_hash: column.text().unique(),
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
  password_hash: column.text().nullable(),
  burn_on_view: column.boolean().default(false),
  created_at: column.timestamp().default("now()"),
})

export const folderActions = defineSchema("folder_actions", {
  id: column.serial().primaryKey(),
  folder_id: column.integer().ref("folders", "id"),
  event: column.text(),
  slug: column.text(),
  config: column.text().default("{}"),
  enabled: column.boolean().default(true),
  created_at: column.timestamp().default("now()"),
  updated_at: column.timestamp().default("now()"),
})

export const folderActionRuns = defineSchema("folder_action_runs", {
  id: column.serial().primaryKey(),
  folder_action_id: column.integer().ref("folder_actions", "id"),
  triggered_event: column.text(),
  subject_kind: column.text(),
  subject_id: column.integer(),
  status: column.text(),
  started_at: column.timestamp().default("now()"),
  finished_at: column.timestamp().nullable(),
  error: column.text().nullable(),
  result: column.text().nullable(),
})

export const webauthnCredentials = defineSchema("webauthn_credentials", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  credential_id: column.text().unique(),
  public_key: column.text(),
  counter: column.bigint().default(0),
  transports: column.text().default("[]"),
  name: column.text().nullable(),
  last_used_at: column.timestamp().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const webauthnChallenges = defineSchema("webauthn_challenges", {
  challenge: column.text().primaryKey(),
  user_id: column.integer().nullable().ref("users", "id"),
  kind: column.text(),
  expires_at: column.timestamp(),
  created_at: column.timestamp().default("now()"),
})

export const passwordResets = defineSchema("password_resets", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  token_hash: column.text().unique(),
  expires_at: column.timestamp(),
  used_at: column.timestamp().nullable(),
  ip: column.text().nullable(),
  created_at: column.timestamp().default("now()"),
})

export const userActions = defineSchema("user_actions", {
  id: column.serial().primaryKey(),
  user_id: column.integer().ref("users", "id"),
  name: column.text(),
  description: column.text().nullable(),
  icon: column.text().nullable(),
  triggers: column.text().default("[]"),
  steps: column.text().default("[]"),
  enabled: column.boolean().default(true),
  forked_from: column.text().nullable(),
  created_at: column.timestamp().default("now()"),
  updated_at: column.timestamp().default("now()"),
})
