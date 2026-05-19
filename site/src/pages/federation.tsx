import React, { useEffect } from "react"
import {
  ChevronRight,
  Github,
  Lock,
  Network,
  Server,
  Users,
  ShieldCheck,
  KeyRound,
  Layers,
  Boxes,
  Globe,
  Check,
  X,
} from "lucide-react"
import { Nav } from "../components/nav"
import { Footer } from "../components/footer"

const REPO = "https://github.com/wess/stohr"

const ModeCardCS: React.FC = () => (
  <div className="fx-mode-card">
    <div className="fx-mode-head">
      <Users size={18} strokeWidth={1.75} />
      <span>Content-sharing</span>
    </div>
    <div className="fx-mode-tag">Group-encrypted shared library</div>
    <ul className="fx-mode-list">
      <li><Check size={14} strokeWidth={2.5} /> Every member can browse + copy any file in the pool</li>
      <li><Check size={14} strokeWidth={2.5} /> Group symmetric key, X25519-sealed to each member on join</li>
      <li><Check size={14} strokeWidth={2.5} /> Full N-way replication — any peer can serve any file fast</li>
      <li><Check size={14} strokeWidth={2.5} /> Best for: family, small teams, photo clubs, co-ops</li>
    </ul>
    <div className="fx-mode-foot">
      <strong>Trust model:</strong> high. Everyone sees everything.
    </div>
  </div>
)

const ModeCardSO: React.FC = () => (
  <div className="fx-mode-card">
    <div className="fx-mode-head">
      <ShieldCheck size={18} strokeWidth={1.75} />
      <span>Space-offering</span>
    </div>
    <div className="fx-mode-tag">Zero-knowledge shard hosting</div>
    <ul className="fx-mode-list">
      <li><Check size={14} strokeWidth={2.5} /> Client-side per-file encryption, peers hold ciphertext shards</li>
      <li><Check size={14} strokeWidth={2.5} /> Reed-Solomon-style erasure coding for durability</li>
      <li><Check size={14} strokeWidth={2.5} /> Peers <em>cannot read</em> what they host — only you can</li>
      <li><Check size={14} strokeWidth={2.5} /> Best for: capacity pooling with loose acquaintances</li>
    </ul>
    <div className="fx-mode-foot">
      <strong>Trust model:</strong> zero. Peers are storage substrate.
    </div>
  </div>
)

const HowItWorks: React.FC = () => (
  <div className="fx-flow">
    <div className="fx-flow-step">
      <div className="fx-flow-num">01</div>
      <h4>Mint an invite</h4>
      <p>The federation admin mints a single-use Ed25519-signed invite token from <strong>Settings → Federation</strong>. Send it to the new peer over any channel you trust — Signal, email, in person.</p>
    </div>
    <div className="fx-flow-step">
      <div className="fx-flow-num">02</div>
      <h4>Pair the instances</h4>
      <p>The receiving Stohr instance verifies the signature against the federation's pubkey, reaches out to the introducer, exchanges identity keys, and records the new membership on both sides.</p>
    </div>
    <div className="fx-flow-step">
      <div className="fx-flow-num">03</div>
      <h4>Designate a contribution folder</h4>
      <p>Each member picks a folder on their own instance and sets a quota cap. That folder becomes the mount-point where encrypted blobs or shards land.</p>
    </div>
    <div className="fx-flow-step">
      <div className="fx-flow-num">04</div>
      <h4>Files start replicating</h4>
      <p>Uploads are placed on N peers (content-sharing) or split into K-of-M erasure shards (space-offering). Reads fetch from whoever's online; reconstructions happen transparently.</p>
    </div>
  </div>
)

const NetworkDiagram: React.FC = () => (
  <div className="fx-net">
    <div className="fx-net-node fx-net-center">
      <Server size={20} strokeWidth={1.5} />
      <span>You</span>
    </div>
    <div className="fx-net-node fx-net-n">
      <Server size={16} strokeWidth={1.5} />
      <span>wess@home</span>
    </div>
    <div className="fx-net-node fx-net-e">
      <Server size={16} strokeWidth={1.5} />
      <span>alice@studio</span>
    </div>
    <div className="fx-net-node fx-net-s">
      <Server size={16} strokeWidth={1.5} />
      <span>ben@nas</span>
    </div>
    <div className="fx-net-node fx-net-w">
      <Server size={16} strokeWidth={1.5} />
      <span>cara@cloud</span>
    </div>
    <div className="fx-net-pill"><Lock size={11} strokeWidth={2.5} /> E2E encrypted</div>
  </div>
)

export const Federation: React.FC = () => {
  useEffect(() => {
    document.title = "Stohr — Federation"
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
          <p className="lp-eyebrow">Stohr Federation</p>
          <h1>
            Pool storage<br />
            <em>with people you trust</em>.
          </h1>
          <p className="lp-lede">
            Two Stohr instances. One invite token. Suddenly you have a shared
            cloud that lives on hardware <em>you</em> own — encrypted, durable,
            and free of every dark pattern the big providers have spent
            fifteen years inventing.
          </p>
          <div className="lp-cta-row">
            <a href="#modes" className="lp-btn lp-btn-primary lp-btn-lg">How it works <ChevronRight size={16} strokeWidth={2} /></a>
            <a href="/docs/federation" className="lp-btn lp-btn-ghost lp-btn-lg">Read the docs</a>
          </div>
        </div>
        <div className="lp-hero-vis">
          <NetworkDiagram />
        </div>
      </section>

      <section className="lp-trust">
        <span className="lp-trust-item"><Lock size={16} strokeWidth={1.75} /> Ed25519 + X25519 + AES-256-GCM</span>
        <span className="lp-trust-item"><Network size={16} strokeWidth={1.75} /> Invite-gated, no DHT</span>
        <span className="lp-trust-item"><Layers size={16} strokeWidth={1.75} /> Replication + erasure coding</span>
        <span className="lp-trust-item"><KeyRound size={16} strokeWidth={1.75} /> Self-controlled keys</span>
      </section>

      {/* ───────── Problem framing ───────── */}
      <section className="devp-section">
        <div className="fx-pitch">
          <p className="lp-eyebrow">The problem</p>
          <h2>Cloud storage shouldn't mean <em>their</em> cloud.</h2>
          <p className="fx-pitch-lede">
            Every consumer cloud is a tradeoff: you trade ownership for
            convenience. The provider scans your files, raises prices on a
            calendar, kills features for "focus," and quietly trains models on
            whatever you uploaded last summer. You leave when it gets bad
            enough — and the next provider does the same thing.
          </p>
          <p className="fx-pitch-lede">
            Federation flips it. You and three friends each run a Stohr
            instance on whatever hardware you like. You pair them with an
            invite, set a quota each, and suddenly there's a shared pool
            that's nobody's product. Drop out and your data comes home.
            Join a different group of friends and you're in two pools at once.
          </p>
        </div>
      </section>

      {/* ───────── Two modes ───────── */}
      <section className="devp-section" id="modes">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Two modes, one join flow</p>
          <h2>Pick what you're <em>actually</em> sharing.</h2>
          <p className="lp-section-lede">
            Federations come in two flavors. Same invite system, same pairing
            handshake — wildly different trust models underneath.
          </p>
        </div>
        <div className="fx-modes">
          <ModeCardCS />
          <ModeCardSO />
        </div>
        <div className="fx-mode-note">
          <strong>Quota model:</strong> each member contributes X bytes and stores up to X (or N × X if the admin enables overcommit). Joining a federation isn't free space — it's <em>durable, off-site, encrypted</em> space, replicated across peers so a single server failure doesn't lose anything.
        </div>
      </section>

      {/* ───────── How it works ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Under the hood</p>
          <h2>How a federation comes together.</h2>
          <p className="lp-section-lede">
            Four steps from "we should share storage" to "files replicating."
          </p>
        </div>
        <HowItWorks />
      </section>

      {/* ───────── Use cases ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Use cases</p>
          <h2>What people actually use it for.</h2>
        </div>
        <div className="devp-grid-3">
          <div className="devp-card">
            <h3>Family photo archive</h3>
            <p>Three generations, three Stohr instances. Content-sharing federation = everyone sees Grandma's slide-scan project, no one's photos sit on Google's servers. Off-site copies in case any single drive dies.</p>
          </div>
          <div className="devp-card">
            <h3>Backup club</h3>
            <p>You and four friends each contribute 500 GB. Space-offering mode shards your files across the group; you get encrypted, geographically-distributed backup without paying Backblaze. No one can read what they store for you.</p>
          </div>
          <div className="devp-card">
            <h3>Small team / studio</h3>
            <p>Tiny design shop, photographers' co-op, journalism collective. Content-sharing federation = shared asset library that's invite-only, audit-logged, end-to-end encrypted in transit, and owned by the people doing the work.</p>
          </div>
          <div className="devp-card">
            <h3>Off-site disaster recovery</h3>
            <p>Two instances, one at home, one at your office or a friend's. Pair them in space-offering mode. Your primary uploads land sharded at both — fire takes one location, the other rebuilds you.</p>
          </div>
          <div className="devp-card">
            <h3>Open-source collective</h3>
            <p>Maintainers of a project pool storage for build artifacts, release archives, and large test fixtures. Encrypted shard hosting means contributors offer disk without seeing what's on it.</p>
          </div>
          <div className="devp-card">
            <h3>Field research team</h3>
            <p>Researchers across institutions share raw datasets via a content-sharing federation. Group key controls access; no institutional cloud has to sign off; revoke by rotating membership.</p>
          </div>
        </div>
      </section>

      {/* ───────── Versus the alternative ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">vs. the alternative</p>
          <h2>Why this beats <em>"just pay for a bigger plan"</em>.</h2>
        </div>
        <div className="fx-vs">
          <div className="fx-vs-col">
            <div className="fx-vs-head">Consumer cloud</div>
            <ul className="fx-vs-list fx-vs-bad">
              <li><X size={14} strokeWidth={2.5} /> Files scanned for ad targeting + model training</li>
              <li><X size={14} strokeWidth={2.5} /> Pricing tiers redesigned annually</li>
              <li><X size={14} strokeWidth={2.5} /> Account suspension = data hostage</li>
              <li><X size={14} strokeWidth={2.5} /> Provider can read everything</li>
              <li><X size={14} strokeWidth={2.5} /> No off-site copy without paying again</li>
              <li><X size={14} strokeWidth={2.5} /> One outage = everyone is down</li>
            </ul>
          </div>
          <div className="fx-vs-col fx-vs-col-good">
            <div className="fx-vs-head">Stohr federation</div>
            <ul className="fx-vs-list fx-vs-good">
              <li><Check size={14} strokeWidth={2.5} /> Files stay on hardware you and your peers own</li>
              <li><Check size={14} strokeWidth={2.5} /> Free, Apache 2.0, no SaaS in the loop</li>
              <li><Check size={14} strokeWidth={2.5} /> Your data lives on N machines; one going dark doesn't lose it</li>
              <li><Check size={14} strokeWidth={2.5} /> Space-offering mode = peers can't read your files</li>
              <li><Check size={14} strokeWidth={2.5} /> Off-site backup is the <em>default</em></li>
              <li><Check size={14} strokeWidth={2.5} /> Federate with multiple groups simultaneously</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ───────── Security ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Security</p>
          <h2>What's <em>actually</em> protecting your bytes.</h2>
        </div>
        <div className="devp-grid-3">
          <div className="devp-card">
            <h3><KeyRound size={14} strokeWidth={1.75} /> Per-instance Ed25519 identity</h3>
            <p>Each Stohr server has its own signing keypair. Every peer-to-peer request is signed with it; receivers verify before doing anything. Pubkeys are short and fingerprintable so you can sanity-check who you're pairing with.</p>
          </div>
          <div className="devp-card">
            <h3><Lock size={14} strokeWidth={1.75} /> X25519 sealed-box key delivery</h3>
            <p>Group keys (content-sharing) and per-file keys (space-offering) are wrapped using ephemeral X25519 + HKDF-SHA256 to the recipient's pubkey. Forward-secret per seal.</p>
          </div>
          <div className="devp-card">
            <h3><ShieldCheck size={14} strokeWidth={1.75} /> AES-256-GCM at rest</h3>
            <p>All blob bytes on disk are AES-256-GCM ciphertext, never plaintext. Authenticated encryption means tampering is detected at decrypt time.</p>
          </div>
          <div className="devp-card">
            <h3><Boxes size={14} strokeWidth={1.75} /> Erasure-coded durability</h3>
            <p>Space-offering files split into K data fragments × R replicas. Any one copy of each fragment is enough to reconstruct — survives losing entire peers.</p>
          </div>
          <div className="devp-card">
            <h3><Network size={14} strokeWidth={1.75} /> Invite-only membership</h3>
            <p>No DHT, no anonymous peers, no public discovery. Federations are named lists of pubkeys; the only way in is a single-use signed invite.</p>
          </div>
          <div className="devp-card">
            <h3><Globe size={14} strokeWidth={1.75} /> Graceful departure</h3>
            <p>Leaving puts a member into <em>drain</em> mode. A background sweep re-replicates their hosted shards onto remaining peers before the membership is fully removed — no data loss when someone shuts a server down.</p>
          </div>
        </div>
      </section>

      {/* ───────── CTA ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Get started</p>
          <h2>Federation is built in. Just turn it on.</h2>
          <p className="lp-section-lede">
            Federation ships with every Stohr instance and is owner-toggleable
            from <strong>Admin → Settings</strong>. No additional install, no
            extra services. Stand up your instance, flip the toggle, and start
            inviting peers.
          </p>
        </div>
        <div className="lp-cta-row" style={{ justifyContent: "center" }}>
          <a href="/setup" className="lp-btn lp-btn-primary lp-btn-lg">Get started</a>
          <a href="/docs/federation" className="lp-btn lp-btn-ghost lp-btn-lg">Federation docs <ChevronRight size={16} strokeWidth={2} /></a>
          <a href={REPO} target="_blank" rel="noreferrer" className="lp-btn lp-btn-ghost lp-btn-lg"><Github size={16} strokeWidth={2} /> Source</a>
        </div>
      </section>

      <Footer />
    </div>
  )
}
