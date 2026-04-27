# Payments

Stohr uses [Lemon Squeezy](https://lemonsqueezy.com) as a Merchant of Record. They handle global tax compliance (VAT, US sales tax, etc.) in exchange for ~5% + $0.50 per transaction.

## Pricing (default)

| Tier | Storage | Monthly | Yearly |
| --- | --- | --- | --- |
| Free | 5 GB | $0 | — |
| Personal | 50 GB | $6 | $60 |
| Pro | 250 GB | $14 | $140 |
| Studio | 1 TB | $34 | $340 |

Yearly = 2 months free. Quotas are enforced at upload time.

## Setup

In LS dashboard:

1. Create a store called **stohr** (the auto-setup looks for that name)
2. Create three products: **Personal**, **Pro**, **Studio** (each name must contain those words for auto-detection)
3. Add two variants to each: monthly + yearly with the prices above. Mark each variant **Published**.

In Stohr Admin → Payments → Connection:

1. Generate an API key in LS (Settings → API)
2. Paste it into the Auto-setup card with the **mode** toggle set correctly (Test or Live)
3. Click **Run auto-setup**. Stohr will:
   - Find your "stohr" store
   - Detect each Personal/Pro/Studio product
   - Pull all 6 variant IDs
   - Generate a webhook signing secret
   - Register a webhook for `https://your-stohr/api/lemonsqueezy/webhook` with the seven `subscription_*` events

Live and test modes can both be configured simultaneously — the toggle just picks which set is active for new checkouts. The webhook handler tries both secrets and routes events to the matching mode.

## Tier flow

A user clicks **Upgrade Pro** in Settings → Subscription. The frontend hits `POST /me/checkout?tier=pro&period=monthly`. The backend looks up the active mode's `tier_pro_monthly` variant ID and returns `{ checkout_url }` pointing at the LS hosted checkout. The page redirects, the user pays, and:

1. LS sends `subscription_created` to the webhook
2. Backend verifies the signature against the active webhook secret
3. Looks up the user (custom_data.user_id from the checkout, or matching email)
4. Maps the variant_id back to a tier
5. Updates `users.tier`, `storage_quota_bytes`, `subscription_status`, `subscription_renews_at`, `ls_customer_id`, `ls_subscription_id`
6. Logs the event in `lemonsqueezy_events`

## Webhook events handled

- `subscription_created` — set tier + status + renews_at
- `subscription_updated` — sync state
- `subscription_cancelled` — keep tier until period end
- `subscription_resumed` — reactivate
- `subscription_expired` — downgrade to free, clear quotas
- `subscription_paused` / `subscription_unpaused` — sync state

Other events are logged but ignored.

## Manual override

Admin → Payments → Subscriptions has a per-row dropdown to manually flip a user's tier. Use it for comp accounts, refund tier downgrades, or edge cases. The override skips the webhook flow entirely — it just updates `users.tier` + `storage_quota_bytes`.
