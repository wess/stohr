# Admin panel

Visible only to users with `is_owner = true`. Lives at **`/app/admin`** in the SPA, with a sidebar entry under Settings.

The first user on a fresh database is auto-flagged owner. To grant another user owner status, an existing owner uses **Admin → Users → Make owner**.

## Sections

### Requests

The waitlist for invite-only signups. Visitors fill in the request form on the landing page (`POST /invite-requests`) and rows show up here as `pending`. For each row:

- **Send invite** — mints an email-bound invite token and surfaces the `/signup?invite=<token>` URL with a Copy button. Marks the request as `invited` and tags it with your user id (`processed_by`).
- **Dismiss** — mark `dismissed` (kept for audit).
- **Delete** (on `invited`/`dismissed` rows) — hard delete.

Three sub-tabs: **Pending** / **Invited** / **Dismissed**.

### Users

Every user account, ordered by signup date. For each user the panel shows:

- `@username`, name, email, an `owner` pill if applicable, a `you` pill on yourself
- Storage used + file count (computed live from `files.size` totals)
- Created date

Actions: **Make/Revoke owner**, **Delete**. You can't revoke owner from yourself or delete yourself here — use Settings → Danger zone for that path.

### Invites

Every invite ever minted, system-wide (not just the ones you minted). Filterable by **Unused** / **Used** / **All**. Shows who created each invite, who used it (if any), and the `/signup?invite=<token>` URL with Copy. Delete only allowed on unused invites.

### Payments

Lemon Squeezy connection + plan mapping. Has its own four sub-tabs:

- **Connection** — auto-setup card (paste API key, click Run) + manual fields. Per-mode webhook URL display, store URL/ID, masked API key + webhook secret. The **Test/Live** toggle at the top of the section flips the entire panel between the two credential sets.
- **Plans** — six variant ID inputs (Personal/Pro/Studio × monthly/yearly) with current price labels and a status pill ("Linked"/"Not linked"). Mode-aware.
- **Subscriptions** — every user with an active LS subscription, with a manual tier-override dropdown for comp accounts and edge cases.
- **Events** — last 100 webhook events with verified-signature pill, error column, sub ID. Useful for debugging integration issues.

### OAuth applications

Register and manage third-party apps that connect to Stohr via OAuth 2.0 (see [OAUTH.md](OAUTH.md)).

For each app:

- **Public client** (default) — no `client_secret`, relies on PKCE. Required for native, mobile, and SPA apps where a secret can't be safely stored.
- **Confidential client** — issues a `client_secret` shown **once** at creation; for server-side integrations.
- **First-party** (`is_official: true`) — skips the consent screen. Only flag this for apps the operator owns.
- **Redirect URIs** — exact-match list. Add a localhost URL for development plus the production URI.
- **Allowed scopes** — `read`, `write`, `share`. The user can grant a subset on the consent screen.

Actions: edit, **Rotate secret** (confidential only), **Revoke** (existing tokens stop working immediately).

### Audit

`audit_events` log: signups, logins (ok / fail / rate-limited / MFA), MFA enable/disable, password changes, session revocations. Filterable by event name and user id. Shows actor, IP, user agent, timestamp, and structured metadata. Secrets are never recorded.

### Stats

Quick metric grid: total users, total storage, files, folders, pending invite requests, active invites, used invites, total invites.

## Per-user security (lives in Settings, not Admin)

The owner can't manage other users' MFA, sessions, or PATs. Each user controls those from **Settings → Security**:

- **MFA / TOTP** — enroll, disable, regenerate backup codes
- **Active sessions** — list + revoke individual sessions or "revoke others"
- **Personal access tokens** — mint long-lived tokens for SDKs and native clients

## Security

Every `/admin/*` route is gated by both `requireAuth` (valid JWT or PAT) and a custom `ownerOnly` pipe that checks `auth.is_owner` from the token claims. A non-owner with a stolen token cannot reach any admin endpoint. The frontend sidebar entry is also hidden for non-owners, but never trust client-side gating — server-side is the source of truth.
