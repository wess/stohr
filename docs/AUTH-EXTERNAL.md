# External authentication

Stohr can delegate authentication to **OpenID Connect (OIDC)** identity providers and to **LDAP** directories. Both are off by default; the instance owner enables and configures each from **Admin → Auth** in the web UI.

Once enabled:

- **OIDC** — adds a "Sign in with SSO" button on the login screen. Clicking it kicks off the standard authorization-code flow with PKCE. After the IdP redirects back, Stohr verifies the ID token signature against the issuer's JWKS, applies the configured claim mapping, and either links the OIDC subject to an existing local user (matched by email) or auto-provisions a new account.
- **LDAP** — adds a "Sign in with LDAP" toggle on the login screen. Submitting the form binds against your directory using the configured service account, looks the user up by filter, then re-binds as the user with the supplied password.

Both providers store a row in `external_identities` keyed on `(provider, subject)`. The "subject" is the OIDC `sub` claim or the user's LDAP DN — durable enough to survive an email change on the IdP side.

A single local account can carry multiple linked identities (password + OIDC, password + LDAP, etc.). The user retains a hashed throwaway password from auto-provisioning; they can claim it via **Forgot your password?** if they ever need a local fallback.

## OIDC configuration

`Admin → Auth → OIDC`:

| Field | Notes |
|---|---|
| Enabled | Master switch. When off, the SSO button is hidden. |
| Issuer URL | The IdP's base URL — e.g. `https://auth.example.com/`. Stohr appends `/.well-known/openid-configuration`. |
| Client ID | The OAuth client ID registered with your IdP. |
| Client secret | Stored plaintext in `oidc_config.client_secret`. Protect the DB. |
| Scopes | Default `openid profile email`. Adjust if your IdP requires extra scopes. |
| Button label | What the login screen shows. Default `Sign in with SSO`. |
| Auto-provision | On = unknown subjects can create a local account. Off = SSO login is rejected unless the email already exists locally (useful when you want to invite-gate signups). |
| `email_claim` / `name_claim` / `username_claim` | Claim names to read from the ID token. Defaults are `email` / `name` / `preferred_username`. |

The redirect URI Stohr expects on the IdP side is:

```
<APP_URL>/api/auth/oidc/callback
```

Where `APP_URL` is the value of your `APP_URL` env var (defaults to `http://localhost:3001`).

### What happens on first login

1. User clicks the SSO button → browser navigates to `/api/auth/oidc/start`.
2. Stohr generates a `state` + `nonce` + PKCE verifier, persists them in `oidc_states` for 10 minutes, and 302s to the IdP's authorize endpoint.
3. After the user authenticates at the IdP, the IdP redirects to `/api/auth/oidc/callback?code=…&state=…`.
4. Stohr exchanges the code at the token endpoint (using the PKCE verifier), verifies the ID token against the IdP's JWKS (RS256 / RS384 / RS512 / ES256 / ES384 supported), and looks up `external_identities` by `(oidc, sub)`.
5. If a link exists → log the existing user in.
   - Else if the email already exists locally → link the OIDC identity and log in.
   - Else if `auto_provision` is on → create a local account and log in.
   - Else → reject with a clear error.
6. Stohr issues a normal session JWT and redirects back to the SPA with the token in the URL fragment.

State rows are swept every 5 minutes.

## LDAP configuration

`Admin → Auth → LDAP`:

| Field | Notes |
|---|---|
| Enabled | Master switch. |
| URL | `ldap://host:389` or `ldaps://host:636`. |
| Start TLS | Issue `STARTTLS` after connect (use this with port 389 + TLS). |
| Bind DN / password | Service account used to search for the user's DN. Leave empty for anonymous bind. |
| User search base | e.g. `ou=people,dc=example,dc=com`. |
| User filter | `(uid={username})` by default. `{username}` is replaced with the LDAP-escaped input. |
| Email / name / username attributes | Attributes to read from the matched entry. Defaults: `mail` / `cn` / `uid`. |
| Auto-provision | Same semantics as OIDC. |

The owner can test the config with **Admin → Auth → LDAP → Test** before flipping the switch — provide a known username and password and the server reports whether the bind succeeds.

## Reverting

Turning a provider off via the admin toggle is instant and reversible — no data is lost. Existing linked accounts keep working with their local password (or other linked providers). To unlink a single user, delete the corresponding row from `external_identities`.
