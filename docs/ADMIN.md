# Admin panel

Visible only to users with `is_owner = true`. Lives at **`/app/admin`** in the SPA, with a sidebar entry under Settings.

The first user on a fresh database is auto-flagged owner. To grant another user owner status, an existing owner uses **Admin → Users → Make owner**.

## Sections

### Requests

The waitlist for invite-only signups. Visitors fill in the request form on the landing page (`POST /invite-requests`) and rows show up here as `pending`. For each row:

- **Send invite** — mints an email-bound invite token and surfaces the `/signup?invite=<token>` URL with a Copy button. Mark the request as `invited` and tag it with your user id (`processed_by`).
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

### Stats

Quick metric grid: total users, total storage, files, folders, pending invite requests, active invites, used invites, total invites.

## Security

Every `/admin/*` route is gated by both `requireAuth` (valid JWT) and a custom `ownerOnly` pipe that checks `auth.is_owner` from the token claims. A non-owner with a stolen token cannot reach any admin endpoint. The frontend sidebar entry is also hidden for non-owners, but never trust client-side gating — server-side is the source of truth.
