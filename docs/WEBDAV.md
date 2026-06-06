# WebDAV

Stohr exposes a WebDAV endpoint (RFC 4918) so you can mount your storage in macOS Finder, Windows File Explorer, or any standards-compliant WebDAV client and work with your files like a network drive.

## Enabling WebDAV

WebDAV is an instance-wide, owner-controlled feature. The instance owner enables it from **Admin → Settings → WebDAV**. While it's off, every WebDAV request returns `503`.

## Mount URL

WebDAV clients talk to the API directly under the `/webdav` prefix:

```
https://your-stohr.example.com/webdav/
```

The web app proxies `/api/*` to the API (stripping `/api`), but WebDAV clients are not browsers and connect straight to the API host. If you deploy the API behind a reverse proxy (Caddy/Nginx), expose `/webdav` on the public host that your clients reach.

## Authentication

WebDAV uses **HTTP Basic auth** backed by your existing credentials — there is no separate WebDAV password to manage:

- **Username:** your account email (e.g. `you@example.com`)
- **Password:** a Personal Access Token (PAT), the `stohr_pat_…` string created under **Settings → Apps**

The PAT is verified the same way as a `Bearer` token on the rest of the API (SHA-256 hashed, looked up in the `apps` table). Because it's the same credential, **revoking the PAT in Settings → Apps immediately revokes WebDAV access** too. Create a dedicated PAT (for example named "WebDAV / Finder") so you can revoke it independently of your other integrations.

If you don't have a PAT yet, create one: **Settings → Apps → New app token**. The token is shown only once — copy it before closing the dialog.

## Connecting from macOS Finder

1. In Finder, choose **Go → Connect to Server…** (`⌘K`).
2. Enter the mount URL: `https://your-stohr.example.com/webdav/`
3. When prompted, sign in with **Registered User**:
   - **Name:** your account email
   - **Password:** your PAT (`stohr_pat_…`)

The mount appears in the Finder sidebar. Finder probes `LOCK`, which Stohr answers with a synthetic (no-op) lock token so writes succeed.

## Connecting from Windows File Explorer

1. In File Explorer, right-click **This PC → Map network drive…**
2. Folder: `https://your-stohr.example.com/webdav/`
3. Check **Connect using different credentials**, then enter your email and PAT.

## Connecting from the command line

```sh
# List the root collection
curl -u 'you@example.com:stohr_pat_xxxxx' -X PROPFIND -H 'Depth: 1' \
  https://your-stohr.example.com/webdav/

# Upload a file
curl -u 'you@example.com:stohr_pat_xxxxx' -T ./report.pdf \
  https://your-stohr.example.com/webdav/report.pdf

# Download it back
curl -u 'you@example.com:stohr_pat_xxxxx' \
  https://your-stohr.example.com/webdav/report.pdf -o report.pdf
```

## Supported methods

`OPTIONS`, `PROPFIND` (Depth 0 and 1), `GET`, `HEAD`, `PUT`, `DELETE`, `MKCOL`, `MOVE`, `COPY`, and no-op `LOCK`/`UNLOCK`.

- **PROPFIND** returns a `207 Multistatus` with `displayname`, `resourcetype` (collection vs file), `getcontentlength`, `getcontenttype`, `creationdate`, and `getlastmodified`.
- **PUT** of a file with the same name into the same folder archives the previous content as a file version (same behavior as the API upload path).
- **DELETE** on a folder removes the whole subtree (WebDAV clients expect a real delete, not a trash move).
- **MOVE** renames or relocates files and folders, honoring the `Destination` and `Overwrite` headers.
- **COPY** is supported for files. Folder copy is not implemented in 1.0.

## Limitations

- Writes into federation-linked folders are not supported over WebDAV — use the web app or API for those.
- `PROPPATCH` and persistent locking are not implemented; `LOCK`/`UNLOCK` are accepted as no-ops so OS clients that probe them can still write.
- Each WebDAV path maps to a folder/file by name under your own root. You only ever see and touch your own files.
