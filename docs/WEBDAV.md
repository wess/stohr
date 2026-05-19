# WebDAV

Stohr ships an RFC 4918 WebDAV endpoint at `/webdav` so users can mount their account as a network drive from any OS. Off by default; the owner enables it from Admin → Settings (no restart needed), then each user mints their own WebDAV password from Settings.

## Enabling WebDAV

**Owner (instance-wide toggle):**

In the admin UI, **Admin → Settings → WebDAV**, flip to on. Or via the API:

```bash
curl -X PATCH https://your-stohr.example.com/api/admin/settings \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "content-type: application/json" \
  -d '{"webdav_enabled": true}'
```

The change takes effect immediately — no restart. While the toggle is off, every WebDAV verb (including `OPTIONS`) returns 503 so clients can detect the feature is unavailable.

> **Upgrading from an older Stohr?** The legacy `WEBDAV_ENABLED=true` env var still seeds the DB toggle on first boot after the upgrade, so existing instances don't lose WebDAV. After that, ignore the env var and manage from Admin → Settings.

**Per-user (after the owner has enabled WebDAV):**

```bash
# Mint a WebDAV password (one-time reveal — store it now)
curl -s -X POST https://your-stohr.example.com/api/me/webdav \
  -H "Authorization: Bearer $STOHR_TOKEN" -H "content-type: application/json" -d '{}'
# → { "enabled": true, "password": "stohr_dav_…" }

# Check status
curl -s https://your-stohr.example.com/api/me/webdav \
  -H "Authorization: Bearer $STOHR_TOKEN"
# → { "enabled": true, "last_used_at": …, "updated_at": … }

# Disable + invalidate the password
curl -s -X DELETE https://your-stohr.example.com/api/me/webdav \
  -H "Authorization: Bearer $STOHR_TOKEN"
```

The WebDAV password is **distinct from your account password** and stored as a SHA-256 hash. The plaintext is shown once at mint time and unrecoverable; rotate by calling `POST /me/webdav` again. Account password resets do not affect it.

## Why a separate password?

WebDAV clients in the wild (macOS Finder, Windows File Explorer, GNOME, RFC-compliant tools) speak HTTP Basic — username + password sent every request. They cannot present session JWTs, PATs, or OAuth tokens. The separate credential lets you revoke WebDAV access independently of the rest of your account.

## Mounting

### macOS Finder (step-by-step)

You only need to do this once per Mac.

1. **Mint your WebDAV password.** Sign in to Stohr in your browser, go to **Settings → Developer → WebDAV**, click **Enable WebDAV** (or **Regenerate password** if you've already enabled it). Copy the `stohr_dav_…` token that appears — it's shown only once.
2. **Open Finder** and press <kbd>⌘</kbd>+<kbd>K</kbd> (or **Go → Connect to Server…** from the menu bar).
3. **Enter the server URL:**

   ```
   https://your-stohr.example.com/webdav
   ```

   Use `https://` for any production server. `http://` only works for `localhost` (macOS refuses plaintext Basic auth elsewhere).
4. Click **Connect**. Finder will show a security prompt if the server uses a self-signed cert.
5. In the authentication dialog choose **Registered User** and fill in:
   - **Name:** your Stohr **username** (not your email). You can see it in **Settings → Profile**.
   - **Password:** the `stohr_dav_…` token from step 1.
6. *(Optional)* tick **Remember this password in my keychain** so Finder doesn't ask again.
7. Click **Connect**. Your Stohr root mounts at `/Volumes/<servername>` and shows up in the Finder sidebar under **Locations**.

To unmount, right-click it in the sidebar and choose **Eject**.

### macOS gotchas

- **HTTP-only servers are blocked.** macOS 11+ refuses HTTP Basic auth over plaintext to non-`localhost` hosts. Use HTTPS in production. For local dev, point Finder at `http://localhost:3001/webdav` (the web server's port).
- **Self-signed certs.** Finder will warn but let you proceed. If a connection silently fails, open Keychain Access and verify the cert is trusted for the hostname you used.
- **Rotating the password.** Regenerating the password in **Settings → Developer → WebDAV** invalidates the prior one. macOS Keychain still has the old one cached — open **Keychain Access**, search for your Stohr hostname, and delete the entry, or Finder will keep failing auth.
- **`.DS_Store` files.** macOS writes these into every directory it browses. They land on the server as real files. Suppress with `defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true` and re-login.
- **Speed.** Finder over WebDAV is sluggish on directories with thousands of files. For bulk transfer, use `rclone` instead.

### Windows File Explorer

`This PC` → ribbon: **Map network drive** → **Connect to a Web site that you can use to store your documents and pictures** → enter:

```
https://your-stohr.example.com/webdav
```

Windows aggressively rejects HTTP-only DAV servers and has a 50 MB default upload cap that you need to raise via the `WebClient` registry tweak. HTTPS + production server is strongly recommended.

### GNOME Files (Nautilus)

`Other Locations` → **Connect to Server**:

```
davs://your-stohr.example.com/webdav     # HTTPS
dav://your-stohr.example.com/webdav      # HTTP
```

### Command-line clients (`rclone`)

```bash
rclone config        # new remote of type "webdav"
                     # url:    https://your-stohr.example.com/webdav
                     # vendor: other
                     # user:   <your stohr username>
                     # pass:   <stohr_dav_…>
rclone ls stohr:
rclone copy ~/Pictures/2024 stohr:photos/2024
```

## What works

| Verb | Behavior |
| --- | --- |
| `OPTIONS` | Advertises `DAV: 1, 2` plus the implemented `Allow:` set |
| `PROPFIND` | Depth `0` and `1` are supported. Returns `displayname`, `resourcetype`, `getcontentlength`, `getcontenttype`, `creationdate`, `getlastmodified` |
| `GET` / `HEAD` | Downloads (or metadata-only). Files stored in a federation pool are fetched transparently |
| `PUT` | Uploads a file. Replacing an existing file archives the prior version to `file_versions` |
| `DELETE` | Files: removes the row + blob immediately. Folders: hard-deletes the whole subtree (no soft-delete via WebDAV — clients don't model trash) |
| `MKCOL` | Creates a folder. Parent must exist (per RFC 4918 §9.3) |
| `MOVE` | Renames / relocates files and folders. `Destination` must be inside `/webdav`. Subtree-into-self is rejected |
| `COPY` | File copy; folder copy is not yet implemented |

## What's not implemented (yet)

- **LOCK / UNLOCK** — every client we care about treats locking as advisory; if you need conflict avoidance, ask. Until then concurrent writers may produce file-version churn but not lost writes (`PUT` always archives current).
- **Depth `infinity` PROPFIND** — large trees would blow up the response. Treated as depth 1.
- **WebDAV writes into federation-tied folders** — `PUT` into a federation contribution or mount returns 422. Upload via the regular API into the federation routes.
- **PROPPATCH / dead properties** — clients that try to write custom xattrs through WebDAV will get a 405. The Stohr file model doesn't store dead properties.

## Path semantics

WebDAV paths map 1:1 to Stohr's folder tree under the authenticated user's owned items:

```
/webdav/                       → root listing
/webdav/photos/                → folder "photos" under root
/webdav/photos/2024/IMG.jpg    → file "IMG.jpg" inside "photos/2024"
```

Folders or files owned by *other users and shared with you* are not visible via WebDAV in the MVP. Add them as a feature request if you need cross-owner access — the rest of the API exposes shared resources, the WebDAV resolver just doesn't walk into other users' trees.

## Security notes

- Stohr's standard rate limiter and audit log do not cover WebDAV in the MVP. If you expose `/webdav` publicly, front it with a rate limiter (Caddy, nginx, Cloudflare) keyed on the source IP or Authorization header.
- The WebDAV credential rotates atomically — `POST /me/webdav` overwrites the prior hash, immediately invalidating it for in-flight clients.
- HTTPS is strongly recommended. HTTP Basic over plaintext exposes the password on every request, and macOS Finder + Windows Explorer both ignore strict-transport hints from non-DAV endpoints.
