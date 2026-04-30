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
# 1. Liveness — process is up
curl -sf https://<your-domain>/healthz | jq

# 2. Readiness — DB and storage reachable. 503 means a dependency is broken
curl -sf https://<your-domain>/readyz | jq

# 3. API is up and security headers landed
curl -sI https://<your-domain>/api/setup | grep -iE 'content-security-policy|strict-transport-security'

# 4. Migrations applied (replace POSTGRES_PASSWORD with the value in your .env)
ssh root@<ip> 'docker compose -f /opt/stohr/compose.yaml exec postgres \
  psql -U postgres -d stohr -c "SELECT name FROM atlas_migrations ORDER BY id DESC LIMIT 3;"'

# 5. Tail the API logs for clean boot
ssh root@<ip> 'docker compose -f /opt/stohr/compose.yaml logs --tail=50 api'

# 6. Sign up the first user — they become the owner
open https://<your-domain>/signup
```

If any of these fail, see "Troubleshooting" below.

## Health checks for orchestrators

Stohr exposes two unauthenticated endpoints at the API root:

- `GET /healthz` — **liveness**. Returns `200` with `{ ok, uptime_s }` whenever the process is running. Never touches the DB. Use this for "is the container alive" probes (Kubernetes `livenessProbe`, Docker `HEALTHCHECK`).
- `GET /readyz` — **readiness**. Verifies Postgres (`SELECT 1`) and best-effort S3 reachability. Returns `200` with `{ ok, checks }` only if every dependency is healthy; otherwise `503`. Use this for load-balancer health checks and Kubernetes `readinessProbe`.

Both skip the access log to avoid drowning your log stream when the LB polls every second.

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

## AI / semantic search (optional)

Stohr embeds file contents in-process via `bai` (llama.cpp through `bun:ffi`). Disabled by default; the API boots without it and `/search/semantic` returns 503 until enabled. When you turn it on, the SPA's ⌘K palette gets an "Ask AI" mode automatically.

**What's already wired:**

- `compose.yaml` uses `pgvector/pgvector:pg16` so the `vector` extension and HNSW index work out of the box. The `00000038_file_embeddings` migration runs automatically.
- The `api` Dockerfile multi-stage build compiles `libbai.so` from `libs/bai/native/rust` and drops it at `/root/.cache/bai/lib/libbai.so` — the path the FFI loader checks. No env override needed.
- A named volume `baimodels` is mounted at `/root/.cache/bai/models` so model files survive container rebuilds.

**To enable on the server:**

```sh
ssh root@<ip>
cd /opt/stohr
echo 'AI_EMBED_MODEL=nomic-embed-text-v1.5' >> .env
bun run setup           # rebuilds image, pulls model, brings services up
```

`bun run setup` is idempotent — re-running on an already-configured host is a no-op except for the rebuild.

**Backfill existing files** (admin-only, one-shot per model swap):

```sh
STOHR_TOKEN=<owner-jwt-or-pat> bun run ai:backfill
STOHR_TOKEN=<owner-jwt-or-pat> bun run ai:status   # progress
```

**Resource cost on a $6 droplet (1 vCPU, 1 GB RAM):**

- libbai + nomic-embed-text-v1.5 loaded: ~300 MB resident.
- Embedding throughput: ~30–80 chunks/sec on CPU; with the `embeddings.generate` job running serially, indexing 10k files takes 10–20 min. Bigger droplets are faster but it's not the bottleneck for normal use.
- Each query is one embedding call (~10 ms) + indexed pgvector ANN (~5–50 ms).

**To disable:** unset `AI_EMBED_MODEL` and `docker compose up -d api`. The model file is kept in the volume; re-enabling is instant.

## App Platform alternative

The repo also includes `Dockerfile` + `.do/app.yaml` for App Platform. Trade-off: ~$25/mo (two services + dev DB) vs ~$11/mo for the droplet, but no SSHing for redeploys — `git push` triggers a deploy.

```sh
# Push to GitHub, then in DO dashboard:
# Apps → Create App → GitHub → pick your repo
# DO auto-detects .do/app.yaml and prefills two services + Postgres
# Add a Spaces bucket + key in Spaces dashboard, paste env vars in App Platform UI
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
#   S3_*             (your S3-compatible provider credentials)
#   RESEND_API_KEY   (or leave blank for console-output dev mode)
#   TRUSTED_PROXIES=172.16.0.0/12   (covers the docker bridge)
#   AI_EMBED_MODEL   (optional — see "AI / semantic search" below)
bun run setup
```

`bun run setup` validates `.env`, syncs submodules, builds the images, pulls the AI model into the `baimodels` volume if `AI_EMBED_MODEL` is set, brings the stack up, and waits for `/healthz`.

The `caddyfile` shipped in the repo reads `{$DOMAIN}` and proxies to `web:3001`. Caddy auto-provisions Let's Encrypt for that domain.

### Operator scripts

| script | what it does |
| --- | --- |
| `bun run setup` | First-time bring-up. Validates `.env`, builds, pulls AI model if configured, starts services, waits for `/healthz` |
| `bun run update` | Run after `git pull`. Re-syncs submodules, rebuilds, recreates services, verifies `/healthz` |
| `bun run ai:pull [<id>]` | Pull a bai model into the `baimodels` volume (default: `AI_EMBED_MODEL` from `.env`) |
| `bun run ai:backfill` | Enqueue `embeddings.generate` for files missing a current-model embedding. `STOHR_TOKEN` env required. `--force` re-embeds everything |
| `bun run ai:status` | Coverage snapshot — `files_embedded / files_total`, pending + dead jobs |

## Troubleshooting

**The API exits immediately with `FATAL: SECRET is set to its default value`.**
You're running with `NODE_ENV=production` and either an empty `SECRET` or the literal string `dev-secret-change-me`. Generate one with `openssl rand -hex 32` and put it in `.env`.

**The web SPA shows "jsxDEV is not a function" in the browser console.**
The web container was bundled in dev mode. Make sure `NODE_ENV=production` is set on the host before `docker compose build`, then rebuild: `docker compose build --pull web && docker compose up -d web`. Hard-refresh the browser to clear the cached bundle.

**`docker compose build api` is slow / hangs on the rust-builder stage.**
First-build cost. The `rust-builder` stage compiles llama.cpp + the bai shim from source — 5–15 minutes on a $6 droplet, ~3 minutes on a beefy box. Subsequent builds reuse the buildx cache mount and finish in seconds unless `libs/bai/native/rust/src` changes. To skip AI entirely on a build, you can comment out the `rust-builder` stage and the `COPY --from=rust-builder` line in `Dockerfile`; just leave `AI_EMBED_MODEL` unset and the API runs without ever loading libbai.

**`/search/semantic` returns 503 with `bai: native library not found`.**
The image build didn't produce `libbai.so` (the rust-builder stage failed silently — check `docker compose build api` output) or the COPY into the runtime stage was skipped. `docker run --rm api ls -la /root/.cache/bai/lib/` to verify; rebuild with `docker compose build --no-cache api` if it's missing.

**`/search/semantic` returns 503 after enabling `AI_EMBED_MODEL`.**
The model isn't pulled. Run `docker compose run --rm api bunx bai pull nomic-embed-text-v1.5` and `docker compose restart api`. `GET /search/status` will show the exact reason in its `reason` field.

**`CREATE EXTENSION vector` fails on a non-compose Postgres.**
You're running an external Postgres without pgvector. Either install the extension (most managed providers — Supabase, Neon, RDS, DigitalOcean, Crunchy — have it) or leave `AI_EMBED_MODEL` unset and Stohr won't try.

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
bun run update          # syncs submodules, rebuilds, recreates services, polls /healthz
```

`bun run update` is idempotent and verifies `/healthz` before exiting. For zero-downtime swaps you can still bypass it: `docker compose up -d --build --no-deps api web` rebuilds the api/web containers while postgres and caddy keep running.

The old manual flow is still available if you'd rather drive each step yourself:

```sh
git submodule update --init --recursive
docker compose build
docker compose up -d
docker compose logs -f api
```

## Backups

Stohr persists state in two places:

- **Postgres** — user accounts, sessions, file metadata, audit log, OAuth grants. Lives in the `pgdata` volume on the droplet.
- **S3-compatible bucket** — file blobs and thumbnails. Lives in your provider (Spaces, S3, MinIO, etc.).

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
