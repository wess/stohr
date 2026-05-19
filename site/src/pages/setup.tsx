import React, { useEffect } from "react"
import { ChevronRight, Github } from "lucide-react"
import { Nav } from "../components/nav"
import { Footer } from "../components/footer"
import { CodeBlock } from "../components/highlight"
import { TerminalMock } from "../components/terminal"

const REPO = "https://github.com/wess/stohr"

export const Setup: React.FC = () => {
  useEffect(() => { document.title = "Stohr — Get started" }, [])

  return (
    <div className="lp devp-page">
      <Nav />

      <section className="lp-hero">
        <div className="lp-hero-text">
          <p className="lp-eyebrow">Get started</p>
          <h1>
            From clone to <em>running</em> in three commands.
          </h1>
          <p className="lp-lede">
            Stohr is a single repo. Postgres for metadata, S3-compatible or
            local disk for blobs, Bun for everything else. Local dev runs in
            seconds; production is one <code>docker compose up</code> away.
          </p>
          <div className="lp-cta-row">
            <a href={REPO} target="_blank" rel="noreferrer" className="lp-btn lp-btn-primary lp-btn-lg">
              <Github size={16} strokeWidth={2} /> Clone the repo
            </a>
            <a href="/docs/deploy" className="lp-btn lp-btn-ghost lp-btn-lg">Production deploy <ChevronRight size={16} strokeWidth={2} /></a>
          </div>
        </div>
        <div className="lp-hero-vis">
          <TerminalMock />
        </div>
      </section>

      <section className="devp-section">
        <h2>Prerequisites</h2>
        <ul className="devp-checklist">
          <li><strong>Bun</strong> &ge; 1.3 — <code>curl -fsSL https://bun.sh/install | bash</code></li>
          <li><strong>Postgres</strong> &ge; 14 reachable locally. The default URL is <code>postgres://postgres:postgres@localhost:5432/stohr</code></li>
          <li><strong>git</strong> (with submodule support — Stohr depends on the <code>libs/atlas</code> submodule)</li>
          <li><em>Optional:</em> any S3-compatible bucket if you want to test the S3 driver. Or set <code>STORAGE_DRIVER=local</code> to use disk.</li>
        </ul>
      </section>

      <section className="devp-section" id="local-dev">
        <h2>Local development</h2>
        <p className="devp-lede">
          The dev command runs the API on <code>:3000</code> and the SPA on
          <code>:3001</code>, both with hot reload.
        </p>

        <CodeBlock lang="bash">{`# 1. Clone with submodules
git clone --recurse-submodules https://github.com/wess/stohr.git
cd stohr

# 2. Configure
cp .env.example .env
# At minimum, set SECRET. Defaults work for everything else in dev.

# 3. Install + run
bun install
bun run dev`}</CodeBlock>

        <p>The first account you sign up at <code>http://localhost:3001</code> becomes the <strong>owner</strong>. Everyone after that is invite-only — mint invites from <strong>Admin → Invites</strong>.</p>

        <h3>Common dev commands</h3>
        <div className="devp-table-wrap">
          <table className="devp-table">
            <thead>
              <tr><th>Command</th><th>What it does</th></tr>
            </thead>
            <tbody>
              <tr><td><code>bun run dev</code></td><td>API + web, both with <code>--hot</code></td></tr>
              <tr><td><code>bun run api</code></td><td>API only, hot reload</td></tr>
              <tr><td><code>bun run web</code></td><td>Web only, hot reload</td></tr>
              <tr><td><code>bun run test</code></td><td>Test suite against an isolated <code>stohr_test</code> Postgres DB</td></tr>
              <tr><td><code>bunx tsc --noEmit</code></td><td>Type-check (there is no build step for the API)</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="devp-section" id="storage">
        <h2>Pick a storage backend</h2>
        <p className="devp-lede">
          Stohr stores metadata in Postgres and blobs in a pluggable
          backend. Two drivers ship today — pick one in <code>.env</code>:
        </p>

        <div className="devp-grid-2">
          <div className="devp-card">
            <h3>S3-compatible (default)</h3>
            <p>AWS S3, DigitalOcean Spaces, Cloudflare R2, MinIO, Backblaze B2, RustFS — anything that speaks SigV4.</p>
            <CodeBlock lang="bash">{`STORAGE_DRIVER=s3
S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
S3_BUCKET=your-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY=…
S3_SECRET_KEY=…`}</CodeBlock>
          </div>

          <div className="devp-card">
            <h3>Local disk</h3>
            <p>Single-host, no external dependency. Good for self-hosters with a persistent volume. Share over NFS/EFS if you scale out.</p>
            <CodeBlock lang="bash">{`STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=/var/lib/stohr/blobs`}</CodeBlock>
          </div>
        </div>
      </section>

      <section className="devp-section" id="production">
        <h2>Production deploy</h2>
        <p className="devp-lede">Three paths, sharing the same <code>compose.yaml</code> and <code>Dockerfile</code>:</p>

        <div className="devp-grid-3">
          <a className="devp-card devp-card-link" href="/docs/deploy">
            <h3>Turn-key droplet</h3>
            <p>One command from your laptop provisions a DigitalOcean droplet + Spaces bucket and brings the stack up over SSH.</p>
            <p className="devp-tag">~10 minutes · ~$11/mo</p>
          </a>
          <a className="devp-card devp-card-link" href="/docs/deploy">
            <h3>DO App Platform</h3>
            <p>Managed runtime for the API and web; bring your own managed Postgres + Spaces.</p>
            <p className="devp-tag">App Platform spec</p>
          </a>
          <a className="devp-card devp-card-link" href="/docs/deploy">
            <h3>Self-managed Docker</h3>
            <p>Any Linux host with Docker. <code>docker compose up -d</code>, point your domain at it.</p>
            <p className="devp-tag">Caddy auto-TLS</p>
          </a>
        </div>

        <h3 style={{ marginTop: 36 }}>Single-container option</h3>
        <p>If you'd rather not run two containers, the included <code>Dockerfile</code> runs API + web together via <code>src/start.ts</code>. Bring your own Postgres and TLS terminator:</p>
        <CodeBlock lang="bash">{`docker build -t stohr .
docker run -d \\
  -p 3000:3000 -p 3001:3001 \\
  --env-file .env \\
  --name stohr \\
  stohr`}</CodeBlock>
      </section>

      <section className="devp-section" id="email">
        <h2>Email (Resend)</h2>
        <p>Stohr sends transactional mail for invites, password reset, and collaboration invites via <a href="https://resend.com" target="_blank" rel="noreferrer">Resend</a>. In development, leave <code>RESEND_API_KEY</code> empty — mail prints to the API console instead. In production:</p>
        <CodeBlock lang="bash">{`RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM="Stohr <noreply@your.tld>"  # must be a verified sender`}</CodeBlock>
      </section>

      <section className="devp-section" id="passkeys">
        <h2>Passkeys (WebAuthn)</h2>
        <p>Passkeys are bound to a Relying Party ID and an origin. Mismatched values fail silently from the browser's side, so set these once and don't change them:</p>
        <CodeBlock lang="bash">{`RP_ID=your.tld           # no protocol, no port
RP_NAME=Stohr
RP_ORIGIN=https://your.tld`}</CodeBlock>
        <p>A passkey enrolled on <code>localhost</code> will not work on <code>your.tld</code> — they're treated as separate RPs.</p>
      </section>

      <section className="devp-section" id="next">
        <h2>Next steps</h2>
        <div className="devp-grid-3">
          <a className="devp-card devp-card-link" href="/docs/configuration">
            <h3>Every env var</h3>
            <p>The full configuration reference — what each <code>.env</code> setting does and what happens if you skip it.</p>
          </a>
          <a className="devp-card devp-card-link" href="/docs/architecture">
            <h3>How it fits together</h3>
            <p>The request pipeline, permission model, soft-deletes, file versioning, background sweeps.</p>
          </a>
          <a className="devp-card devp-card-link" href="/developers">
            <h3>Build with the API</h3>
            <p>PATs, OAuth, SDKs in four languages, the S3-compatible bucket.</p>
          </a>
        </div>
      </section>

      <Footer />
    </div>
  )
}
