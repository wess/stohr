import React, { useEffect } from "react"
import { ChevronRight } from "lucide-react"
import { Nav } from "../components/nav"
import { Footer } from "../components/footer"
import { CodeBlock } from "../components/highlight"

const REPO = "https://github.com/wess/stohr"

export const Developers: React.FC = () => {
  useEffect(() => {
    document.title = "Stohr — Developers"
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a")
      if (!a) return
      const href = a.getAttribute("href") ?? ""
      if (href.startsWith("#")) {
        e.preventDefault()
        const el = document.querySelector(href)
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    }
    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [])

  return (
    <div className="lp devp-page">
      <Nav />

      <section className="lp-hero">
        <div className="lp-hero-text">
          <p className="lp-eyebrow">Developers</p>
          <h1>
            Run it yourself.<br />
            <em>Build on top.</em>
          </h1>
          <p className="lp-lede">
            Stohr is open source under Apache 2.0. Deploy your own instance in
            ten minutes, or build apps and integrations against an existing one
            with first-party SDKs in TypeScript, Dart, Swift, and Kotlin.
          </p>
          <div className="lp-cta-row">
            <a href="/setup" className="lp-btn lp-btn-primary lp-btn-lg">Get started</a>
            <a href="#api" className="lp-btn lp-btn-ghost lp-btn-lg">Build with the API <ChevronRight size={16} strokeWidth={2} /></a>
          </div>
        </div>
      </section>

      <section className="devp-section" id="self-host">
        <h2>Self-host Stohr</h2>
        <p className="devp-lede">
          Two paths. Both use the official <code>compose.yaml</code>:
          <em> postgres + api + web + caddy</em>. Pick the one that matches
          how you like to ship infra.
        </p>

        <div className="devp-grid-2">
          <div className="devp-card">
            <h3>Turn-key DigitalOcean droplet</h3>
            <p>Provisions a droplet, a Spaces bucket, and an SSH-deployed compose stack from your laptop in one command.</p>
            <CodeBlock lang="bash">{`# On your Mac
DIGITALOCEAN_TOKEN=… bun scripts/deploy/index.ts \\
  --github=you/stohr \\
  --domain=your.tld`}</CodeBlock>
            <p className="devp-note">
              <strong>Cost:</strong> ~$11/mo (droplet $6 + Spaces $5).<br />
              <strong>Time:</strong> ~10 minutes including DNS propagation.<br />
              <a href="/docs/deploy">Deploy guide →</a>
            </p>
          </div>

          <div className="devp-card">
            <h3>Manual docker compose</h3>
            <p>Any host with Docker. Bring your own Postgres, your own object store, your own TLS terminator.</p>
            <CodeBlock lang="bash">{`# On the host
git clone https://github.com/wess/stohr.git
cd stohr
cp .env.example .env
# edit .env (see Configuration below)
docker compose up -d --build
docker compose logs -f api`}</CodeBlock>
            <p className="devp-note">
              <a href="/docs/configuration">All env vars →</a>
            </p>
          </div>
        </div>

        <h3 style={{ marginTop: 36 }}>Production checklist</h3>
        <ul className="devp-checklist">
          <li><code>NODE_ENV=production</code> — without it, the API won't enforce SECRET length</li>
          <li><code>SECRET</code> — at least 32 chars; generate with <code>openssl rand -hex 32</code></li>
          <li><code>DOMAIN</code>, <code>APP_URL</code>, <code>RP_ID</code>, <code>RP_ORIGIN</code> — all on HTTPS, all matching your domain</li>
          <li><code>RESEND_API_KEY</code> — required for invites and password reset to email</li>
          <li><code>TRUSTED_PROXIES</code> — set to your reverse-proxy CIDR (compose default: <code>172.16.0.0/12</code>)</li>
          <li>Postgres backups — schedule <code>pg_dump</code> off-host. The bundled volume is a single point of failure</li>
        </ul>
      </section>

      <section className="devp-section" id="api">
        <h2>Build against the API</h2>
        <p className="devp-lede">
          Every Stohr feature is a JSON-over-HTTPS endpoint under
          <code>/api</code>. The same surface backs the web SPA, the SDKs,
          third-party OAuth apps, and the S3-compatible bucket.
        </p>

        <h3>Base URL &amp; versioning</h3>
        <CodeBlock lang="text">{`https://your-stohr.example.com/api`}</CodeBlock>
        <p>One stable v1 surface. Breaking changes will land behind a new prefix; nothing under <code>/api</code> changes shape.</p>

        <h3>Quick start — list your folders</h3>
        <CodeBlock lang="bash">{`# 1. Mint a personal access token at Settings → Developer
TOKEN="stohr_pat_xxxxxxxx..."

# 2. Hit the API
curl -s https://your-stohr.example.com/api/folders \\
  -H "Authorization: Bearer $TOKEN" | jq`}</CodeBlock>

        <CodeBlock lang="ts">{`// TypeScript
const r = await fetch("https://your-stohr.example.com/api/folders", {
  headers: { authorization: \`Bearer \${process.env.STOHR_TOKEN}\` },
})
const folders = await r.json()`}</CodeBlock>

        <h3>Endpoint groups</h3>
        <div className="devp-table-wrap">
          <table className="devp-table">
            <thead>
              <tr><th>Group</th><th>Highlights</th></tr>
            </thead>
            <tbody>
              <tr><td><code>/auth</code></td><td><code>POST /signup</code>, <code>POST /login</code>, <code>POST /login/mfa</code>, <code>/login/passkey/*</code>, <code>/password/forgot</code></td></tr>
              <tr><td><code>/me</code></td><td>profile, sessions, MFA, passkeys, PATs, S3 keys, storage usage, OAuth apps</td></tr>
              <tr><td><code>/folders</code></td><td>list, CRUD, soft-delete, restore, purge, collaborators, action attachments</td></tr>
              <tr><td><code>/files</code></td><td>list/search, multipart upload, download, thumbnails, versions, collaborators</td></tr>
              <tr><td><code>/shares</code></td><td>create / list / revoke; public read at <code>/s/:token</code> (no auth)</td></tr>
              <tr><td><code>/invites</code></td><td>mint / list / revoke; public check at <code>/invites/:token/check</code></td></tr>
              <tr><td><code>/oauth</code></td><td>authorize / token / revoke / device flow / discovery</td></tr>
              <tr><td><code>/admin</code></td><td>owner-only: users, invites, audit, OAuth clients</td></tr>
              <tr><td><code>/p</code></td><td>public folders &amp; files (no auth)</td></tr>
              <tr><td><code>/s3</code></td><td>S3-compatible bucket — see <a href="/docs/s3">S3 docs</a></td></tr>
            </tbody>
          </table>
        </div>
        <p>
          <a href="/docs/api">Full API reference →</a>
        </p>
      </section>

      <section className="devp-section" id="auth">
        <h2>Authentication</h2>
        <p className="devp-lede">
          Three credential types are accepted by every authed endpoint.
          Pick by use case.
        </p>

        <div className="devp-grid-3">
          <div className="devp-card">
            <h3>Personal access token</h3>
            <p className="devp-tag">Best for scripts &amp; cron jobs you control.</p>
            <p>Mint at <strong>Settings → Developer → Apps</strong>. Token starts with <code>stohr_pat_</code>. Long-lived; revoke any time. Stored as a SHA-256 hash; the plaintext is shown once.</p>
            <CodeBlock lang="bash">{`Authorization: Bearer stohr_pat_…`}</CodeBlock>
          </div>

          <div className="devp-card">
            <h3>OAuth 2.0 access token</h3>
            <p className="devp-tag">Best for third-party apps acting on a user's behalf.</p>
            <p>Authorization Code + PKCE (mandatory) or Device Flow. Refresh tokens rotate; reuse-detection burns the chain. Scopes: <code>read</code>, <code>write</code>, <code>share</code>.</p>
            <CodeBlock lang="bash">{`Authorization: Bearer <oauth-access-jwt>`}</CodeBlock>
            <p className="devp-note">
              <a href="/docs/oauth">OAuth flow walk-through →</a>
            </p>
          </div>

          <div className="devp-card">
            <h3>User session JWT</h3>
            <p className="devp-tag">What the SPA and SDKs use after a normal login.</p>
            <p>Issued by <code>POST /login</code> (and <code>/login/mfa</code> if 2FA is on). 7-day TTL, server-revocable via the sessions table — listing devices and revoking lives at <code>/me/sessions</code>.</p>
          </div>
        </div>
      </section>

      <section className="devp-section" id="errors">
        <h2>Errors &amp; rate limits</h2>

        <p>Every non-2xx response has the shape <code>{"{ error }"}</code>, sometimes with extra fields.</p>

        <CodeBlock lang="json">{`// 402 — quota exceeded
{
  "error": "Storage quota exceeded",
  "quota_bytes": 53687091200,
  "used_bytes": 53600000000,
  "attempted_bytes": 200000000,
  "breakdown": { "active": …, "trash": …, "versions": … }
}

// 429 — rate limited
{ "error": "Too many attempts. Try again later.", "retry_after": 137 }

// 403 — insufficient OAuth scope
{ "error": "Insufficient scope — 'write' is required, token has [read]" }`}</CodeBlock>

        <p>Rate-limit buckets are sliding-window, keyed per-IP and per-identity. The <code>retry_after</code> field is in seconds.</p>
      </section>

      <section className="devp-section" id="sdks">
        <h2>Official SDKs</h2>
        <p className="devp-lede">All four wrap the same v1 REST API with idiomatic shapes per platform.</p>
        <div className="devp-grid-4">
          <a className="devp-card devp-card-link" href={`${REPO}/tree/main/sdks/typescript`} target="_blank" rel="noreferrer">
            <h3>TypeScript</h3>
            <p>Bun, Deno, Node 20+, browsers</p>
            <p className="devp-tag">npm: stohr</p>
          </a>
          <a className="devp-card devp-card-link" href={`${REPO}/tree/main/sdks/dart`} target="_blank" rel="noreferrer">
            <h3>Dart</h3>
            <p>Flutter, Dart 3+</p>
            <p className="devp-tag">pub: stohr</p>
          </a>
          <a className="devp-card devp-card-link" href={`${REPO}/tree/main/sdks/swift`} target="_blank" rel="noreferrer">
            <h3>Swift</h3>
            <p>iOS 15+, macOS 12+</p>
            <p className="devp-tag">SwiftPM</p>
          </a>
          <a className="devp-card devp-card-link" href={`${REPO}/tree/main/sdks/kotlin`} target="_blank" rel="noreferrer">
            <h3>Kotlin</h3>
            <p>Android, JVM</p>
            <p className="devp-tag">Maven Central</p>
          </a>
        </div>
        <p style={{ marginTop: 16 }}>
          <strong>Heads up:</strong> WebAuthn / passkey endpoints and the password-reset flow are REST-only for now — they'll land in the SDKs in a follow-up.
        </p>
      </section>

      <section className="devp-section" id="learn-more">
        <h2>Deeper dives</h2>
        <div className="devp-grid-3">
          <a className="devp-card devp-card-link" href="/docs/architecture">
            <h3>Architecture</h3>
            <p>Process layout, request pipeline, permission model, background sweeps.</p>
          </a>
          <a className="devp-card devp-card-link" href="/docs/oauth">
            <h3>OAuth 2.0 provider</h3>
            <p>Auth code + PKCE, device flow, custom-scheme redirect handling.</p>
          </a>
          <a className="devp-card devp-card-link" href="/docs/actions">
            <h3>Action folders</h3>
            <p>Run code on file/folder events. Built-in catalog and how to ship one.</p>
          </a>
          <a className="devp-card devp-card-link" href="/docs/s3">
            <h3>S3-compatible API</h3>
            <p>Point <code>aws-cli</code>, <code>boto3</code>, <code>rclone</code> at Stohr; reuse your account quota.</p>
          </a>
          <a className="devp-card devp-card-link" href={`${REPO}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
            <h3>Security model</h3>
            <p>Auth, sessions, MFA, passkeys, CSP, trusted proxies, encryption-at-rest.</p>
          </a>
        </div>
      </section>

      <Footer />
    </div>
  )
}
