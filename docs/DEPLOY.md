# Deploy

## Prerequisites

- A domain you control (DNS pointable at the droplet IP). Optional for first-boot, required for HTTPS / passkeys / OAuth.
- A DigitalOcean account with billing set up. Generate a personal access token with full read/write scope at https://cloud.digitalocean.com/account/api/tokens.
- An SSH key on your local machine. The deploy script defaults to `~/.ssh/id_ed25519.pub`, falls back to `~/.ssh/id_rsa.pub`. Generate one with `ssh-keygen -t ed25519` if you don't have one.
- A Resend account at https://resend.com (free tier ships 3 k emails/month). Without this, password-reset and invite emails won't send. You can deploy without it and add the key later — see "Email setup" below.

## TL;DR — DigitalOcean droplet (recommended)

```sh
DIGITALOCEAN_TOKEN=… bun scripts/deploy/index.ts --github=you/stohr --domain=your.tld
```

After ~10 minutes you have a working droplet. The script:

1. Provisions a droplet (default `s-1vcpu-1gb`, `~$6/mo`)
2. Creates a Spaces bucket + scoped access key
3. Generates a strong `SECRET`
4. Uploads (or reuses) your local SSH public key on DO
5. Cloud-init on the droplet installs Docker + Caddy, clones your repo, writes `.env`, and runs `docker compose up -d --build`

Total cost: ~$11/mo (droplet $6 + Spaces $5).

## Flags

| flag | default | purpose |
| --- | --- | --- |
| `--github=user/repo` | required | GitHub repo to clone |
| `--app-name=name` | `stohr` | droplet name |
| `--region=nyc3` | `nyc3` | DO + Spaces region |
| `--size=slug` | `s-1vcpu-1gb` | droplet size |
| `--domain=your.tld` | none | enables Caddy auto-TLS for that domain |
| `--ssh-pub-key=path` | `~/.ssh/id_ed25519.pub` then `id_rsa.pub` | which key to upload |
| `--github-token=ghp_…` | none | for private repos |

## HTTPS is required for production

If you don't pass `--domain`, Caddy serves the app on `:80` over the droplet IP. **This is fine only for testing.** In that mode:

- Browsers will refuse passkey registration (WebAuthn requires HTTPS — `localhost` is the only HTTP-allowed origin).
- OAuth `redirect_uri` validation will refuse non-HTTPS targets (security best practice).
- Bearer tokens travel in cleartext.

Once your DNS is pointed at the IP, edit `/opt/stohr/caddyfile` to use the domain (or set `DOMAIN=your.tld` in `/opt/stohr/.env`) and run `docker compose restart caddy`. Caddy auto-provisions Let's Encrypt.

## Watching the boot

```sh
ssh root@<ip> 'tail -f /var/log/stohr-bootstrap.log'
```

You're looking for the `docker compose up -d --build` line at the end. Once it's there, hit `https://<your-domain>` (or `http://<ip>` for an undomained instance).

## Post-deploy verification

```sh
# 1. API is up and security headers landed
curl -sI https://<your-domain>/api/setup | grep -iE 'content-security-policy|strict-transport-security'

# 2. Migrations applied (replace POSTGRES_PASSWORD with the value in your .env)
ssh root@<ip> 'docker compose -f /opt/stohr/compose.yaml exec postgres \
  psql -U postgres -d stohr -c "SELECT name FROM atlas_migrations ORDER BY id DESC LIMIT 3;"'

# 3. Tail the API logs for clean boot
ssh root@<ip> 'docker compose -f /opt/stohr/compose.yaml logs --tail=50 api'

# 4. Sign up the first user — they become the owner
open https://<your-domain>/signup
```

If any of these fail, see "Troubleshooting" below.

## Email setup (required for invites + password reset)

Stohr boots fine without email — invites, password-reset links, and collaboration emails just print to the API container's stdout instead of sending. That's useful for first-boot smoke testing but a bad place to stay in production: invitees and users locked out of their accounts will never get the link.

To enable real email:

1. Sign up at https://resend.com.
2. Add and verify your sending domain (the DNS records are guided in their UI; about 5 minutes).
3. Generate an API key at https://resend.com/api-keys.
4. On the droplet:
   ```sh
   ssh root@<ip>
   cd /opt/stohr
   # Edit .env and set:
   #   RESEND_API_KEY=re_...
   #   RESEND_FROM='Stohr <noreply@your-domain>'
   docker compose up -d --force-recreate api
   ```
5. Test by minting an invite from Settings → Invites and asking the recipient if it arrived.

## App Platform alternative

The repo also includes `Dockerfile` + `.do/app.yaml` for App Platform. Trade-off: ~$25/mo (two services + dev DB) vs ~$11/mo for the droplet, but no SSHing for redeploys — `git push` triggers a deploy.

```sh
# Push to GitHub, then in DO dashboard:
# Apps → Create App → GitHub → pick your repo
# DO auto-detects .do/app.yaml and prefills two services + Postgres
# Add a Spaces bucket + key in Spaces dashboard, paste env vars in App Platform UI
```

## Single-container Docker

The `Dockerfile` builds one image that runs the API and the SPA web server together (via `src/start.ts`). The web server proxies `/api/*` to the API internally, so you only publish one port — handy for a PaaS that runs a single container, or any host where you'd rather skip Compose.

You bring your own **Postgres**, and — if you want HTTPS — your own TLS terminator (this image has no Caddy). Migrations run automatically on API startup.

```sh
# The libs/atlas submodule must be checked out before building.
git submodule update --init
docker build -t stohr .

docker run -d --name stohr -p 80:3001 \
  -e SECRET="$(openssl rand -hex 32)" \
  -e DATABASE_URL=postgres://user:pass@host:5432/stohr \
  -e APP_URL=https://files.example.com \
  -e RP_ID=files.example.com \
  -e RP_ORIGIN=https://files.example.com \
  -e STORAGE_DRIVER=s3 \
  -e S3_ENDPOINT=… -e S3_BUCKET=… -e S3_REGION=… \
  -e S3_ACCESS_KEY=… -e S3_SECRET_KEY=… \
  -e RESEND_API_KEY=re_… -e RESEND_FROM='Stohr <noreply@files.example.com>' \
  stohr
```

For disk-backed storage instead of S3, swap the `S3_*` vars for a mounted volume:

```sh
  -e STORAGE_DRIVER=local -v stohr-blobs:/data/blobs \
```

`NODE_ENV=production`, `PORT`, `WEB_PORT`, `API_URL`, and `STORAGE_LOCAL_DIR` are already baked into the image — you don't pass them. Put a reverse proxy (Caddy, nginx, your PaaS edge) in front for TLS, point it at `:3001`, and set `TRUSTED_PROXIES` to that proxy's address so `X-Forwarded-For` is honored. The container ships a `HEALTHCHECK` that hits `GET /api/setup` through the web proxy.

Update by rebuilding and recreating:

```sh
git pull && git submodule update --init
docker build -t stohr .
docker rm -f stohr && docker run -d --name stohr … stohr
```

## Manual / docker-compose

`compose.yaml` defines `postgres + api + web + caddy`. On any host with Docker:

```sh
git clone https://github.com/you/stohr.git
cd stohr
cp .env.example .env
# Edit .env — at minimum set:
#   POSTGRES_PASSWORD (any strong random)
#   SECRET           (openssl rand -hex 32)
#   NODE_ENV=production
#   DOMAIN=your.tld
#   APP_URL=https://your.tld
#   RP_ID=your.tld
#   RP_ORIGIN=https://your.tld
#   STORAGE_DRIVER   (s3 or local; default s3)
#   S3_*             (when STORAGE_DRIVER=s3 — your provider credentials)
#   STORAGE_LOCAL_DIR (when STORAGE_DRIVER=local — must be a persistent volume)
#   RESEND_API_KEY   (or leave blank for console-output dev mode)
#   TRUSTED_PROXIES=172.16.0.0/12   (covers the docker bridge)
docker compose up -d --build
docker compose logs -f api
```

The `caddyfile` shipped in the repo reads `{$DOMAIN}` and proxies to `web:3001`. Caddy auto-provisions Let's Encrypt for that domain.

## Troubleshooting

**The API exits immediately with `FATAL: SECRET is set to its default value`.**
You're running with `NODE_ENV=production` and either an empty `SECRET` or the literal string `dev-secret-change-me`. Generate one with `openssl rand -hex 32` and put it in `.env`.

**The web SPA shows "jsxDEV is not a function" in the browser console.**
The web container was bundled in dev mode. Make sure `NODE_ENV=production` is set on the host before `docker compose build`, then rebuild: `docker compose build --pull web && docker compose up -d web`. Hard-refresh the browser to clear the cached bundle.

**Migrations fail with `extension "pgcrypto" is not allow-listed`.**
The Postgres role needs `CREATE` on the database (managed Postgres providers usually allow this; some need a flag flipped). Or run as superuser: `psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'`.

**Rate limits behave weirdly — everyone is locked out at the same time.**
`TRUSTED_PROXIES` isn't set, so the API treats Caddy/web's container IP as the client and collapses every bucket onto that one IP. Set `TRUSTED_PROXIES=172.16.0.0/12` in `.env` and recreate the api container.

**Passkey registration fails with "Invalid origin".**
`RP_ID` / `RP_ORIGIN` don't match your actual domain, or you're on HTTP (browsers refuse passkeys over plain HTTP). Make sure `RP_ORIGIN=https://your.tld` and `RP_ID=your.tld` (no protocol, no port).

## Updates

After the initial deploy, redeployments are:

```sh
ssh root@<ip>
cd /opt/stohr
git pull
docker compose up -d --build
docker compose logs -f api    # watch for migration application + clean boot
```

For zero-downtime swaps, `docker compose up -d --build --no-deps api web` builds new containers behind the scenes and replaces them while postgres and caddy keep running.

## Backups

Stohr persists state in two places:

- **Postgres** — user accounts, sessions, file metadata, audit log, OAuth grants. Lives in the `pgdata` volume on the droplet.
- **Blob storage** — file blobs and thumbnails. Either an S3-compatible bucket (`STORAGE_DRIVER=s3`, lives in your provider — Spaces, S3, MinIO, etc.) or a local directory (`STORAGE_DRIVER=local`, lives at `STORAGE_LOCAL_DIR` on the API host — make sure it's a persistent volume and back it up alongside Postgres).

A reasonable cadence:

```sh
# Postgres daily — copies the dump off-host
ssh root@<ip> 'docker compose -f /opt/stohr/compose.yaml exec -T postgres \
  pg_dump -U postgres stohr | gzip' > "stohr-$(date +%F).sql.gz"

# Bucket — Spaces / S3 versioning + lifecycle policy is the cheapest path.
# Enable bucket versioning and a 30-day retention rule in your provider's UI.
```

## Rollback

```sh
# On your Mac
git revert <sha>
git push

# On the server
ssh root@<ip>
cd /opt/stohr
git pull
docker compose up -d --build
```

Migrations don't auto-roll-back. To revert a schema change, run the matching `down.sql`:

```sh
docker compose exec api bunx atlas-migrate down ./migrations <migration_name>
```

Some migrations are destructive (e.g. `00000032_invite_token_hash` cannot recover plaintext invite tokens — its down migration invalidates all unused invites by writing placeholders).
