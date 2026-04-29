# OAuth integration guide

Stohr is an OAuth 2.0 provider supporting the **Authorization Code flow with PKCE** (RFC 6749 + 7636) for native, mobile, desktop, and SPA clients. This is what you'd integrate against if you're building Butter, a Flutter app, a Raycast extension, or anything else that wants to act on a user's behalf.

> **What's not here**: full OIDC ("Sign in with Stohr"), client_credentials grant, implicit flow, password grant. Those aren't needed for the common "desktop app uploads on behalf of a user" pattern. Open an issue if you actually need them.

## Endpoints

Discoverable at `/.well-known/oauth-authorization-server` (RFC 8414):

| Endpoint                              | Purpose                                       |
|---------------------------------------|-----------------------------------------------|
| `GET /oauth/authorize`                | Browser redirect-based code flow (PKCE).      |
| `POST /oauth/device/authorize`        | Device-flow start (RFC 8628). **Recommended for native apps.** |
| `POST /oauth/token`                   | Exchange auth code or device code → tokens, refresh later. |
| `POST /oauth/revoke`                  | Revoke a refresh token.                       |
| `GET /pair`                           | Web page where users type their device code (browser-rendered SPA). |

## Scopes

| Scope   | Grants                                                  |
|---------|---------------------------------------------------------|
| `read`  | List/get folders, files, file content, account info     |
| `write` | Create / modify / delete folders and files              |
| `share` | Create and revoke public share links                    |

Routes that **mint further credentials** (PATs, MFA setup, OAuth client registration, password change, account deletion) are *not* accessible via OAuth tokens — only via the user's own JWT or a PAT.

## Client registration

The Stohr operator (the owner) registers your app under **Settings → Developer → OAuth applications**.

- **Name**: shown on the consent screen.
- **Redirect URIs**: exact-match list. For desktop apps use a custom scheme: `butter://oauth/callback`. For SPAs use a localhost URL during dev: `http://localhost:5173/callback`.
- **Scopes**: the maximum scopes the client can ever ask for. The user can grant a subset.
- **First-party** (`is_official: true`): skips the consent screen — only flag this for apps the operator owns.
- **Public client**: default. Issues no `client_secret` — relies on PKCE for proof-of-possession. Required for native/SPA apps; storing a secret in compiled binaries or browser bundles is meaningless.
- **Confidential client**: server-side only. Issues a one-time `client_secret`.

Save the `client_id` (and `client_secret` if you registered confidential — it's only shown once at creation).

## Two flows: pick the right one

### **Device Authorization Grant (RFC 8628) — recommended for native apps**

This is the cleanest path for desktop, CLI, and embedded clients. **No redirect URI registration required**, no custom URL scheme, no browser → native handoff. The user types an 8-character code into a web page on any device.

1. App calls `POST /oauth/device/authorize` with `client_id` (and optional `scope`).
2. Server returns:
   ```json
   {
     "device_code": "long-opaque-string",
     "user_code": "ABCD-1234",
     "verification_uri": "https://stohr.example.com/pair",
     "verification_uri_complete": "https://stohr.example.com/pair?code=ABCD-1234",
     "expires_in": 600,
     "interval": 5
   }
   ```
3. App displays `user_code` to the user and opens `verification_uri_complete` in their browser (any device — phone, work computer, doesn't matter).
4. User signs in to Stohr if needed, sees the consent screen with the code prefilled, clicks **Authorize**.
5. App polls `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` until it gets either tokens or a terminal error.

**Polling rules** (per RFC 8628):
- Wait `interval` seconds (default 5) between polls. The server returns `slow_down` if you go faster.
- `authorization_pending` — keep polling.
- `slow_down` — increase interval by 5 seconds, keep polling.
- `access_denied` — user denied; stop and inform them.
- `expired_token` — code expired (10-minute window); restart the flow.
- `200 OK` with `access_token` + `refresh_token` — done.

### **Authorization Code with PKCE — for browser apps and SPAs**

When the app already has a browser context (web app, embedded webview), the authorization code flow with PKCE (RFC 7636) is more direct.

### 1. Send the user to /oauth/authorize

Generate a cryptographically random PKCE pair:

```ts
const verifier = base64url(randomBytes(32))               // 43–128 chars
const challenge = base64url(sha256(verifier))             // S256
const state = base64url(randomBytes(16))                  // anti-CSRF
```

Open the user's browser to:

```
https://stohr.example.com/oauth/authorize?
  response_type=code
  &client_id=cli_…
  &redirect_uri=butter%3A%2F%2Foauth%2Fcallback
  &scope=read+write+share
  &code_challenge=<base64url SHA-256 of verifier>
  &code_challenge_method=S256
  &state=<random>
```

For a desktop app, this typically means: register the custom URL scheme with the OS, open the browser, wait for the OS to relaunch your app with the redirect URL.

### 2. Receive the redirect

Stohr redirects to your `redirect_uri` with either:

- Success: `?code=<one-time>&state=<echo>`
- Denial:  `?error=access_denied&state=<echo>`
- Validation error: `?error=invalid_request&error_description=...&state=<echo>`

**Verify** that `state` matches what you sent. If it doesn't, abort.

### 3. Exchange the code for tokens

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<from redirect>
&client_id=<your client_id>
&code_verifier=<the verifier you generated, NOT the challenge>
&redirect_uri=<the same one you used in step 1>
```

JSON works too if you prefer: send `Content-Type: application/json` and a JSON body.

You get back:

```json
{
  "access_token": "<JWT>",
  "refresh_token": "oat_<opaque>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "read write share"
}
```

The auth code is **single-use** and expires in 60 seconds. The PKCE verifier must hash to the original challenge or the exchange fails.

### 4. Use the access token

```http
GET /me HTTP/1.1
Authorization: Bearer <access_token>
```

Same Bearer-header pattern as everywhere else in the API.

### 5. Refresh before it expires

Access tokens are short-lived (1h). When you get a 401 (or pre-emptively before expiry), call:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=oat_<the one you got>
&client_id=<your client_id>
```

You get a **new pair**: `access_token` and `refresh_token`. The old refresh token is now revoked.

**This rotation is mandatory.** If you reuse an old refresh token, Stohr treats it as a leak signal and revokes the entire token family for that user/client — the user has to authorize again.

### 6. Revoke (optional, on logout)

```http
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=oat_<refresh token>
```

Returns 200 regardless of whether the token existed (per RFC 7009 — avoids leaking validity).

## Security requirements (non-negotiable)

- **PKCE is mandatory** — `code_challenge_method=S256`. Verifier 43–128 chars from the `[A-Z][a-z][0-9]-._~` set.
- **`redirect_uri` is exact-match** — no substring tricks, no path appending. If you registered `butter://oauth/callback`, you must hit exactly that URI; `butter://oauth/callback?extra=1` is rejected.
- **`state` parameter is required** for any production client to prevent CSRF on the redirect.
- **Store tokens in OS keychain** (macOS Keychain, Windows Credential Manager, Linux Secret Service). Don't write them to plain config files.
- **Refresh tokens rotate**. Discard the old one immediately after a refresh.
- **Custom-scheme handling on macOS**: register the scheme in `Info.plist` and listen for the URL via `NSAppleEventManager` (Cocoa) or the appropriate Tauri / Electron / Flutter plugin.

## Quick example: Rust (for Butter)

```rust
// Cargo.toml: oauth2 = "5"
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenUrl, basic::BasicClient,
};

let client = BasicClient::new(ClientId::new("cli_<your id>".into()))
    .set_auth_uri(AuthUrl::new("https://stohr.example.com/oauth/authorize".into())?)
    .set_token_uri(TokenUrl::new("https://stohr.example.com/oauth/token".into())?)
    .set_redirect_uri(RedirectUrl::new("butter://oauth/callback".into())?);

let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();
let (auth_url, csrf) = client
    .authorize_url(CsrfToken::new_random)
    .add_scope(Scope::new("read".into()))
    .add_scope(Scope::new("write".into()))
    .add_scope(Scope::new("share".into()))
    .set_pkce_challenge(pkce_challenge)
    .url();

// open auth_url in browser, wait for redirect with code

let token = client
    .exchange_code(AuthorizationCode::new(received_code))
    .set_pkce_verifier(pkce_verifier)
    .request_async(&reqwest_client)
    .await?;
// token.access_token() and token.refresh_token() are ready to use
```

## Quick share endpoint (recommended for screenshot-style flows)

For desktop screenshot apps, the natural sequence is "upload one PNG → get a public link". Today this is three calls (find/create folder → upload → create share). A `POST /me/quickshare` endpoint that collapses these is on the roadmap; for now use the existing routes:

1. `GET /folders?parent_id=null` to find or `POST /folders` to create the Screenshots folder (`kind: screenshots`).
2. `POST /files` (multipart) with `folder_id` set, body = the PNG.
3. `POST /shares` with `{file_id, expires_in: 2592000}` for a 30-day link.

The full URL is `<your-stohr-host>/s/<share.token>`.

## Help / questions

Open an issue at https://github.com/wess/stohr or email me@wess.io.
