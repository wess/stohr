# Deploy

## TL;DR — DigitalOcean droplet (recommended)

```sh
DIGITALOCEAN_TOKEN=… bun scripts/deploy/index.ts --github=you/stohr
```

After ~10 minutes you have a working droplet. The script:

1. Provisions a droplet (default `s-1vcpu-1gb`, `~$6/mo`)
2. Creates a Spaces bucket + scoped access key
3. Generates a `SECRET`
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

If you don't pass `--domain`, Caddy serves the app on `:80` over the droplet IP. Once you point a domain at the IP, edit `/opt/stohr/caddyfile` and `docker compose restart caddy` to switch to TLS.

## Watching the boot

```sh
ssh root@<ip> 'tail -f /var/log/stohr-bootstrap.log'
```

You're looking for the `docker compose up -d --build` line at the end. Once it's there, hit `http://<ip>` (or your domain).

## App Platform alternative

The repo also includes `dockerfile` + `.do/app.yaml` for App Platform. Trade-off: ~$25/mo (two services + dev DB) vs ~$11/mo for the droplet, but no SSHing for redeploys — `git push` triggers a deploy.

```sh
# Push to GitHub, then in DO dashboard:
# Apps → Create App → GitHub → pick your repo
# DO auto-detects .do/app.yaml and prefills two services + Postgres
# Add Spaces bucket + key in Spaces dashboard, paste env vars in App Platform UI
```

## Manual / docker-compose

`compose.yaml` defines `postgres + api + web + caddy`. On any host with Docker:

```sh
git clone --recurse-submodules https://github.com/you/stohr.git
cd stohr
echo "POSTGRES_PASSWORD=…" > .env
echo "SECRET=…" >> .env
echo "S3_ENDPOINT=…" >> .env
# (etc — see docs/CONFIGURATION.md)
echo ":80 { reverse_proxy web:3001 }" > caddyfile
docker compose up -d --build
```

## Updates

After the initial deploy, redeployments are:

```sh
ssh root@<ip>
cd /opt/stohr
git pull
docker compose up -d --build
```

For zero-downtime swaps, `docker compose up -d --build --no-deps api web` builds new containers behind the scenes and replaces them while postgres and caddy keep running.
