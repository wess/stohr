import React, { useEffect } from "react"
import {
  ChevronRight,
  Github,
  Cloud,
  Folder as FolderIcon,
  HardDrive,
  Check,
  X,
  Apple,
  Monitor,
  Terminal,
  KeyRound,
  ShieldCheck,
  Zap,
} from "lucide-react"
import { Nav } from "../components/nav"
import { Footer } from "../components/footer"
import { CodeBlock } from "../components/highlight"

const REPO = "https://github.com/wess/stohr"

const FinderMock: React.FC = () => (
  <div className="lp-mock lp-mock-hero" aria-hidden="true">
    <div className="lp-mock-chrome">
      <span className="lp-mock-dot lp-mock-dot-r" />
      <span className="lp-mock-dot lp-mock-dot-y" />
      <span className="lp-mock-dot lp-mock-dot-g" />
      <div className="lp-mock-url">Finder — Stohr</div>
    </div>
    <div className="lp-mock-shell">
      <aside className="lp-mock-sidebar">
        <div className="lp-mock-brand">Locations</div>
        <ul>
          <li><HardDrive size={14} strokeWidth={1.75} /> Macintosh HD</li>
          <li className="active"><Cloud size={14} strokeWidth={1.75} /> Stohr</li>
          <li><FolderIcon size={14} strokeWidth={1.75} /> AirDrop</li>
        </ul>
      </aside>
      <div className="lp-mock-main">
        <div className="lp-mock-toolbar">
          <span>Stohr</span>
          <span className="lp-mock-sep">/</span>
          <strong>Trips</strong>
          <span className="lp-mock-action-chip"><Cloud size={11} strokeWidth={2.5} /> Mounted</span>
        </div>
        <div className="lp-mock-grid">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className={`lp-mock-tile lp-mock-tile-${i + 1}`} />
          ))}
        </div>
      </div>
    </div>
    <div className="lp-mock-toast">
      <Check size={14} strokeWidth={2.5} />
      Mounted as <code>/Volumes/Stohr</code>
    </div>
  </div>
)

export const Webdav: React.FC = () => {
  useEffect(() => {
    document.title = "Stohr — WebDAV"
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
          <p className="lp-eyebrow">Stohr WebDAV</p>
          <h1>
            Mount it like a<br />
            <em>network drive</em>.
          </h1>
          <p className="lp-lede">
            Stohr ships an RFC 4918 WebDAV endpoint baked into the API. Open
            Finder, hit <kbd>⌘K</kbd>, paste your URL — your entire Stohr
            account shows up in the sidebar like any other volume. Drag files
            in, drag files out, work with them in any native app.
          </p>
          <div className="lp-cta-row">
            <a href="#connect" className="lp-btn lp-btn-primary lp-btn-lg">How to connect <ChevronRight size={16} strokeWidth={2} /></a>
            <a href="/docs/webdav" className="lp-btn lp-btn-ghost lp-btn-lg">Read the docs</a>
          </div>
        </div>
        <div className="lp-hero-vis">
          <FinderMock />
        </div>
      </section>

      <section className="lp-trust">
        <span className="lp-trust-item"><Apple size={16} strokeWidth={1.75} /> macOS Finder</span>
        <span className="lp-trust-item"><Monitor size={16} strokeWidth={1.75} /> Windows Explorer</span>
        <span className="lp-trust-item"><FolderIcon size={16} strokeWidth={1.75} /> GNOME / KDE</span>
        <span className="lp-trust-item"><Terminal size={16} strokeWidth={1.75} /> rclone, cadaver</span>
      </section>

      {/* ───────── Why this matters ───────── */}
      <section className="devp-section">
        <div className="fx-pitch">
          <p className="lp-eyebrow">Why bother</p>
          <h2>The browser is fine. The OS is <em>better</em>.</h2>
          <p className="fx-pitch-lede">
            Every cloud has a web UI. The web UI is fine for casual use, but
            the moment you want to crop a photo in Photos, edit a doc in
            Pages, or grep a directory of logs — you're back to downloading,
            editing, re-uploading. Drudgery.
          </p>
          <p className="fx-pitch-lede">
            WebDAV puts Stohr where it belongs: in your file manager. Every
            file lives in the Finder sidebar (or Explorer, or Files, or
            wherever your OS keeps mounted volumes). Apps open it directly.
            Saves go back to the server. Shortcuts and search work. You stop
            thinking about "cloud storage" and start thinking about <em>files</em>.
          </p>
        </div>
      </section>

      {/* ───────── Connection guides ───────── */}
      <section className="devp-section" id="connect">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Connection guides</p>
          <h2>One credential. <em>Every OS.</em></h2>
          <p className="lp-section-lede">
            Mint a WebDAV password from <strong>Settings → Developer → WebDAV</strong> in the Stohr SPA. It's separate from your account password — revoke it any time without affecting login.
          </p>
        </div>

        <div className="devp-grid-2">
          <div className="devp-card">
            <h3><Apple size={14} strokeWidth={1.75} /> macOS Finder</h3>
            <ol className="devp-checklist">
              <li>Press <kbd>⌘K</kbd> (<strong>Go → Connect to Server</strong>)</li>
              <li>Enter <code>https://your-stohr.example.com/webdav</code></li>
              <li>Click <strong>Connect</strong>, choose <strong>Registered User</strong></li>
              <li>Username: your Stohr username</li>
              <li>Password: the <code>stohr_dav_…</code> token</li>
              <li>Optional: <strong>Remember in Keychain</strong></li>
            </ol>
            <p className="devp-note">
              Mounts at <code>/Volumes/your-server</code>. Appears in the Finder sidebar under Locations.
            </p>
          </div>

          <div className="devp-card">
            <h3><Monitor size={14} strokeWidth={1.75} /> Windows File Explorer</h3>
            <ol className="devp-checklist">
              <li>Open <strong>This PC</strong></li>
              <li>Ribbon: <strong>Map network drive</strong></li>
              <li>Click <em>Connect to a Web site that you can use to store your documents and pictures</em></li>
              <li>Paste <code>https://your-stohr.example.com/webdav</code></li>
              <li>Enter username + WebDAV password</li>
            </ol>
            <p className="devp-note">
              HTTPS is strongly recommended. Raise the <code>WebClient</code> upload cap above 50&nbsp;MB if you transfer large files.
            </p>
          </div>

          <div className="devp-card">
            <h3><FolderIcon size={14} strokeWidth={1.75} /> GNOME Files / KDE Dolphin</h3>
            <ol className="devp-checklist">
              <li><strong>Other Locations → Connect to Server</strong></li>
              <li>Use <code>davs://your-stohr.example.com/webdav</code> (HTTPS) or <code>dav://</code> for plain HTTP</li>
              <li>Enter username + WebDAV password</li>
            </ol>
            <p className="devp-note">
              Works in Nautilus, Dolphin, Thunar, and every other GVFS-aware file manager.
            </p>
          </div>

          <div className="devp-card">
            <h3><Terminal size={14} strokeWidth={1.75} /> rclone (CLI / scripts)</h3>
            <CodeBlock lang="bash">{`rclone config              # new remote
                           # type: webdav
                           # url:  https://your-stohr.example.com/webdav
                           # vendor: other
                           # user: <username>
                           # pass: <stohr_dav_…>

rclone ls stohr:
rclone copy ~/Pictures/2024 stohr:photos/2024`}</CodeBlock>
            <p className="devp-note">
              Pair with <code>rclone sync</code> for incremental backup, <code>rclone mount</code> for FUSE-mounted access on Linux.
            </p>
          </div>
        </div>
      </section>

      {/* ───────── What works ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Full RFC 4918</p>
          <h2>Not a toy — a <em>real</em> WebDAV server.</h2>
        </div>
        <div className="devp-table-wrap">
          <table className="devp-table">
            <thead>
              <tr><th>Method</th><th>Behavior</th></tr>
            </thead>
            <tbody>
              <tr><td><code>OPTIONS</code></td><td>Advertises <code>DAV: 1, 2</code> and the implemented <code>Allow:</code> set</td></tr>
              <tr><td><code>PROPFIND</code></td><td>Depth 0 (single item) and Depth 1 (item + children) supported with standard props</td></tr>
              <tr><td><code>GET</code> / <code>HEAD</code></td><td>Streams from any storage backend; federation files reconstructed transparently</td></tr>
              <tr><td><code>PUT</code></td><td>Uploads. Replacing an existing file auto-archives the prior version to <code>file_versions</code></td></tr>
              <tr><td><code>DELETE</code></td><td>Files removed immediately. Folders hard-delete the whole subtree (no soft-delete via DAV)</td></tr>
              <tr><td><code>MKCOL</code></td><td>Create folder. Parent must exist (RFC 4918 §9.3)</td></tr>
              <tr><td><code>MOVE</code></td><td>Rename / relocate files and folders. Subtree-into-self rejected</td></tr>
              <tr><td><code>COPY</code></td><td>File copy across folders</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ───────── Security ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Security</p>
          <h2>Separate credential. <em>Real</em> auth.</h2>
        </div>
        <div className="devp-grid-3">
          <div className="devp-card">
            <h3><KeyRound size={14} strokeWidth={1.75} /> Separate WebDAV password</h3>
            <p>OS-level WebDAV clients speak HTTP Basic. They cannot present session JWTs, PATs, or OAuth tokens — so we mint a separate per-user credential. Revoking it doesn't touch your account password.</p>
          </div>
          <div className="devp-card">
            <h3><ShieldCheck size={14} strokeWidth={1.75} /> SHA-256 hashed at rest</h3>
            <p>The plaintext token is shown once at mint time and never stored. Server-side we only keep the SHA-256 hash. Compromise of the database doesn't expose anyone's WebDAV password.</p>
          </div>
          <div className="devp-card">
            <h3><Zap size={14} strokeWidth={1.75} /> Owner-toggleable</h3>
            <p>The whole endpoint is gated by an admin setting. Owner flips it off → every WebDAV verb returns 503 immediately, no restart. Useful when you only want WebDAV on for specific instances.</p>
          </div>
        </div>
      </section>

      {/* ───────── Caveats ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Be honest</p>
          <h2>Things we'll fix later (and one we won't).</h2>
        </div>
        <div className="devp-grid-2">
          <div className="devp-card">
            <h3>LOCK / UNLOCK</h3>
            <p>Not implemented. Most clients treat WebDAV locking as advisory anyway. Concurrent <code>PUT</code>s can produce version churn, but the file-version archive always preserves the prior write — you can never lose bytes.</p>
          </div>
          <div className="devp-card">
            <h3>Depth-infinity PROPFIND</h3>
            <p>Treated as Depth 1. Walking a huge tree in one response blows up clients more than it helps. Use the SPA or the API for large listings.</p>
          </div>
          <div className="devp-card">
            <h3>WebDAV writes into federation folders</h3>
            <p>Returns 422 today. Uploads to federation-tied folders go through the federation upload flow; we'll teach WebDAV that route in a follow-up.</p>
          </div>
          <div className="devp-card">
            <h3>PROPPATCH / dead properties</h3>
            <p>We don't store dead properties. Clients that try to write arbitrary xattrs through WebDAV get 405. The file metadata that <em>matters</em> (name, mime, size, dates) is exposed via standard props.</p>
          </div>
        </div>
      </section>

      {/* ───────── vs alternative ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">vs. the alternative</p>
          <h2>Why this beats <em>"just use the web UI"</em>.</h2>
        </div>
        <div className="fx-vs">
          <div className="fx-vs-col">
            <div className="fx-vs-head">Web UI only</div>
            <ul className="fx-vs-list fx-vs-bad">
              <li><X size={14} strokeWidth={2.5} /> Download → edit → re-upload loop</li>
              <li><X size={14} strokeWidth={2.5} /> Native apps can't open files directly</li>
              <li><X size={14} strokeWidth={2.5} /> No Spotlight / Finder search</li>
              <li><X size={14} strokeWidth={2.5} /> No drag-and-drop from desktop</li>
              <li><X size={14} strokeWidth={2.5} /> Scripts and CLI tools can't touch it</li>
            </ul>
          </div>
          <div className="fx-vs-col fx-vs-col-good">
            <div className="fx-vs-head">+ WebDAV mounted</div>
            <ul className="fx-vs-list fx-vs-good">
              <li><Check size={14} strokeWidth={2.5} /> Edit-in-place from any native app</li>
              <li><Check size={14} strokeWidth={2.5} /> Spotlight / Quick Look / preview just work</li>
              <li><Check size={14} strokeWidth={2.5} /> Drag-and-drop both directions</li>
              <li><Check size={14} strokeWidth={2.5} /> rclone / sync tools / shell scripts work</li>
              <li><Check size={14} strokeWidth={2.5} /> Looks and feels like local files</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ───────── CTA ───────── */}
      <section className="devp-section">
        <div className="lp-section-head">
          <p className="lp-eyebrow">Get started</p>
          <h2>WebDAV ships with Stohr. Just enable it.</h2>
          <p className="lp-section-lede">
            The endpoint is built into every Stohr instance. Owner enables it
            instance-wide from <strong>Admin → Settings</strong>; users mint
            their own WebDAV password from <strong>Settings → Developer</strong>.
            No additional install, no add-on.
          </p>
        </div>
        <div className="lp-cta-row" style={{ justifyContent: "center" }}>
          <a href="/setup" className="lp-btn lp-btn-primary lp-btn-lg">Get started</a>
          <a href="/docs/webdav" className="lp-btn lp-btn-ghost lp-btn-lg">WebDAV docs <ChevronRight size={16} strokeWidth={2} /></a>
          <a href={REPO} target="_blank" rel="noreferrer" className="lp-btn lp-btn-ghost lp-btn-lg"><Github size={16} strokeWidth={2} /> Source</a>
        </div>
      </section>

      <Footer />
    </div>
  )
}
