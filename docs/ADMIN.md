# Admin panel

Visible only to users with `is_owner = true`. Lives at **`/app/admin`** in the SPA, with a sidebar entry under Settings.

The first user on a fresh database is auto-flagged owner. To grant another user owner status, an existing owner uses **Admin → Users → Make owner**.

## Sections

### Users

Every user account, ordered by signup date. For each user the panel shows:

- `@username`, name, email, an `owner` pill if applicable, a `you` pill on yourself
- Storage used + file count (computed live from `files.size` totals)
- Created date

Each user row also shows their storage cap (or "no cap").

Actions: **Make/Revoke owner**, **Set quota** (sets a per-user `storage_quota_bytes` cap in GB; `0` = unlimited), **Delete**. You can't revoke owner from yourself or delete yourself here — use Settings → Danger zone for that path.

### Invites

Every invite ever minted, system-wide (not just the ones you minted). Filterable by **Unused** / **Used** / **All**. Shows who created each invite, who used it (if any), and the `/signup?invite=<token>` URL with Copy. Delete only allowed on unused invites.

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

Quick metric grid: total users, total storage, files, folders, active invites, used invites, total invites.

### Settings (instance features)

Owner-controlled toggles for instance-wide features. Stored in `instance_settings`; changes apply immediately, no API restart needed.

| Setting | Default | Effect when off |
| --- | --- | --- |
| `webdav_enabled` | off | Every `/webdav/*` verb returns 503. `/me/webdav` (per-user enable) also 503s |
| `federation_enabled` | off | All `/me/federations/*` and peer-to-peer `/federation/*` routes return 503. Existing federation rows are preserved; flip back on to resume |

API:

```bash
# List current state of every known toggle
curl -s https://your-stohr.example.com/api/admin/settings \
  -H "Authorization: Bearer $OWNER_TOKEN"

# Flip one or more — only known keys accepted
curl -s -X PATCH https://your-stohr.example.com/api/admin/settings \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "content-type: application/json" \
  -d '{"webdav_enabled": true, "federation_enabled": true}'
```

Why owner-controlled rather than env vars: deploys don't need a restart to flip a feature, and operators can selectively enable WebDAV on instances that need it without baking it into image builds.

## Per-user security (lives in Settings, not Admin)

The owner can't manage other users' MFA, sessions, or PATs. Each user controls those from **Settings → Security**:

- **MFA / TOTP** — enroll, disable, regenerate backup codes
- **Active sessions** — list + revoke individual sessions or "revoke others"
- **Personal access tokens** — mint long-lived tokens for SDKs and native clients

## Security

Every `/admin/*` route is gated by both `requireAuth` (valid JWT or PAT) and a custom `ownerOnly` pipe that checks `auth.is_owner` from the token claims. A non-owner with a stolen token cannot reach any admin endpoint. The frontend sidebar entry is also hidden for non-owners, but never trust client-side gating — server-side is the source of truth.
