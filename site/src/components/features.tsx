import React from "react"
import {
  Folder as FolderIcon,
  Link2,
  Copy,
  Check,
  ArrowRight,
  Zap,
  Network,
  Server,
  Lock,
  HardDrive,
  Cloud,
  Search,
  Briefcase,
  Smartphone,
  Mail,
  KeyRound,
} from "lucide-react"

const PhotoGridMock: React.FC = () => (
  <div className="lp-mock lp-mock-gallery" aria-hidden="true">
    <div className="lp-mock-gallery-grid">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className={`lp-mock-tile lp-mock-tile-${i + 1}`} />
      ))}
    </div>
    <div className="lp-mock-gallery-pip">
      <span className="lp-mock-pip-key">↑↓←→</span>
      <span>navigate</span>
      <span className="lp-mock-pip-key">esc</span>
      <span>close</span>
    </div>
  </div>
)

const ActionFolderMock: React.FC = () => (
  <div className="lp-mock lp-mock-card lp-mock-action" aria-hidden="true">
    <div className="lp-mock-card-head">
      <FolderIcon size={16} strokeWidth={1.75} />
      <span>Photos</span>
      <span className="lp-mock-sep">/</span>
      <strong>thumbnails</strong>
      <span className="lp-mock-action-chip"><Zap size={11} strokeWidth={2.5} /> Action</span>
    </div>
    <div className="lp-mock-action-body">
      <div className="lp-mock-action-line">
        <code className="lp-mock-event">file.created</code>
        <ArrowRight size={14} strokeWidth={2} className="lp-mock-arrow" />
        <code className="lp-mock-slug">stohr/resize-image</code>
      </div>
      <div className="lp-mock-action-line">
        <code className="lp-mock-event">file.moved.in</code>
        <ArrowRight size={14} strokeWidth={2} className="lp-mock-arrow" />
        <code className="lp-mock-slug">stohr/resize-image</code>
      </div>
      <div className="lp-mock-action-result">
        <Check size={13} strokeWidth={2.5} />
        <span>sunset.jpg → 800×600 · 245 KB → 38 KB</span>
      </div>
    </div>
  </div>
)

const CollabMock: React.FC = () => (
  <div className="lp-mock lp-mock-card lp-mock-collab" aria-hidden="true">
    <div className="lp-mock-card-head">
      <FolderIcon size={16} strokeWidth={1.75} />
      <strong>Wedding photos</strong>
      <span className="lp-mock-public-pill">Shared</span>
    </div>
    <ul className="lp-mock-collab-list">
      <li>
        <span className="lp-mock-avatar lp-mock-avatar-1">W</span>
        <span className="lp-mock-collab-name">@wess</span>
        <span className="lp-mock-role lp-mock-role-owner">Owner</span>
      </li>
      <li>
        <span className="lp-mock-avatar lp-mock-avatar-2">A</span>
        <span className="lp-mock-collab-name">alice@studio.io</span>
        <span className="lp-mock-role lp-mock-role-editor">Editor</span>
      </li>
      <li>
        <span className="lp-mock-avatar lp-mock-avatar-3">B</span>
        <span className="lp-mock-collab-name">@ben</span>
        <span className="lp-mock-role lp-mock-role-viewer">Viewer</span>
      </li>
      <li className="lp-mock-collab-pending">
        <span className="lp-mock-avatar lp-mock-avatar-pending">·</span>
        <span className="lp-mock-collab-name">cara@team.dev</span>
        <span className="lp-mock-role lp-mock-role-pending">Pending</span>
      </li>
    </ul>
  </div>
)

const LinkMock: React.FC = () => (
  <div className="lp-mock lp-mock-card lp-mock-link" aria-hidden="true">
    <div className="lp-mock-link-bar">
      <Link2 size={15} strokeWidth={1.75} />
      <code>stohr.io/p/wess/photos/124</code>
      <button type="button"><Copy size={13} strokeWidth={2} /> Copy</button>
    </div>
    <div className="lp-mock-link-meta">
      <span className="lp-mock-link-pill">Public</span>
      <span>Expires in 30 days</span>
      <span className="lp-mock-sep">·</span>
      <span>0 views</span>
    </div>
    <div className="lp-mock-link-preview">
      <div className="lp-mock-tile lp-mock-tile-2" />
      <div className="lp-mock-link-preview-text">
        <strong>Trips / Iceland</strong>
        <span>14 photos · 142 MB</span>
      </div>
    </div>
  </div>
)

const FederationMock: React.FC = () => (
  <div className="lp-mock lp-mock-card lp-mock-fed" aria-hidden="true">
    <div className="lp-mock-card-head">
      <Network size={16} strokeWidth={1.75} />
      <strong>friends-of-the-pod</strong>
      <span className="lp-mock-public-pill">Federation</span>
    </div>
    <div className="lp-mock-fed-stat">
      <div>
        <div className="lp-mock-fed-stat-value">5.2 TB</div>
        <div className="lp-mock-fed-stat-label">Pooled across 4 peers</div>
      </div>
      <div className="lp-mock-fed-badge">
        <Lock size={11} strokeWidth={2.5} />
        E2E encrypted
      </div>
    </div>
    <ul className="lp-mock-fed-list">
      <li>
        <span className="lp-mock-fed-host"><Server size={12} strokeWidth={1.75} /> wess@home</span>
        <span className="lp-mock-fed-meta">2.1 / 2.0 TB</span>
        <span className="lp-mock-role lp-mock-role-owner">Admin</span>
      </li>
      <li>
        <span className="lp-mock-fed-host"><Server size={12} strokeWidth={1.75} /> alice@studio</span>
        <span className="lp-mock-fed-meta">1.4 / 1.5 TB</span>
        <span className="lp-mock-role lp-mock-role-editor">Member</span>
      </li>
      <li>
        <span className="lp-mock-fed-host"><Server size={12} strokeWidth={1.75} /> ben@nas</span>
        <span className="lp-mock-fed-meta">0.9 / 1.0 TB</span>
        <span className="lp-mock-role lp-mock-role-editor">Member</span>
      </li>
      <li>
        <span className="lp-mock-fed-host"><Server size={12} strokeWidth={1.75} /> cara@cloud</span>
        <span className="lp-mock-fed-meta">0.8 / 1.0 TB</span>
        <span className="lp-mock-role lp-mock-role-editor">Member</span>
      </li>
    </ul>
  </div>
)

const WebDAVMock: React.FC = () => (
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

export type Feature = {
  num: string
  eyebrow: string
  title: React.ReactNode
  body: React.ReactNode
  visual: React.ReactNode
}

export const FEATURES: Feature[] = [
  {
    num: "01",
    eyebrow: "Galleries",
    title: <>Photo galleries, <em>instantly</em>.</>,
    body: <>Mark any folder as a Photos folder and the view becomes a tight square grid with click-to-lightbox keyboard navigation. Zero plugins, zero config — just toggle a checkbox.</>,
    visual: <PhotoGridMock />,
  },
  {
    num: "02",
    eyebrow: "Action folders",
    title: <>Folders that <em>act for you</em>.</>,
    body: <>Attach automations directly to a folder. Resize images on upload, route files into year/month subfolders, run any built-in or community action on <code>file.created</code>, <code>file.moved.in</code>, and more.</>,
    visual: <ActionFolderMock />,
  },
  {
    num: "03",
    eyebrow: "Collaboration",
    title: <>Real <em>collaboration</em>.</>,
    body: <>Share folders by username or email with viewer or editor roles. Pending invites resolve automatically when the other person signs up — no copying tokens around.</>,
    visual: <CollabMock />,
  },
  {
    num: "04",
    eyebrow: "Public links",
    title: <>Public links <em>without the chrome</em>.</>,
    body: <>Flip on public access and get a clean <code>/p/you/123</code> URL anyone can browse — no signup wall, no upsells, no email capture before they see your work.</>,
    visual: <LinkMock />,
  },
  {
    num: "05",
    eyebrow: "Federation",
    title: <>Pool storage <em>with people you trust</em>.</>,
    body: <>Pair two Stohr instances with an invite token and your storage stacks. <strong>Content-sharing</strong> mode is a group-encrypted shared library; <strong>space-offering</strong> mode is end-to-end encrypted shard hosting where peers can't even read what they store. Ed25519-signed peer transport, replication or erasure coding, graceful drain when a member leaves. <a href="/federation" className="lp-inline-more">Learn how it works →</a></>,
    visual: <FederationMock />,
  },
  {
    num: "06",
    eyebrow: "WebDAV",
    title: <>Mount it like a <em>network drive</em>.</>,
    body: <>Stohr ships an RFC 4918 WebDAV endpoint at <code>/webdav</code>. Connect from macOS Finder with <kbd>⌘K</kbd>, Windows Explorer's <em>Map network drive</em>, GNOME Files, or <code>rclone</code> — every PROPFIND, PUT, MOVE, MKCOL, COPY just works. <a href="/webdav" className="lp-inline-more">Connection guides →</a></>,
    visual: <WebDAVMock />,
  },
  {
    num: "07",
    eyebrow: "Spaces",
    title: <>Team workspaces, <em>not just shared folders</em>.</>,
    body: <>Spaces are co-owned by their members. Add teammates by username or email with admin / editor / viewer roles; files inside live in the Space, not in any one person's drive. Personal storage and team storage stay cleanly separated. <a href="/docs/spaces" className="lp-inline-more">Read the docs →</a></>,
    visual: <div className="lp-mock lp-mock-card" aria-hidden="true">
      <div className="lp-mock-card-head"><Briefcase size={16} strokeWidth={1.75} /><strong>Acme · Engineering</strong><span className="lp-mock-public-pill">Space</span></div>
      <ul className="lp-mock-collab-list">
        <li><span className="lp-mock-avatar lp-mock-avatar-1">W</span><span className="lp-mock-collab-name">@wess</span><span className="lp-mock-role lp-mock-role-owner">Admin</span></li>
        <li><span className="lp-mock-avatar lp-mock-avatar-2">A</span><span className="lp-mock-collab-name">@alice</span><span className="lp-mock-role lp-mock-role-editor">Editor</span></li>
        <li><span className="lp-mock-avatar lp-mock-avatar-3">B</span><span className="lp-mock-collab-name">@ben</span><span className="lp-mock-role lp-mock-role-viewer">Viewer</span></li>
      </ul>
    </div>,
  },
  {
    num: "08",
    eyebrow: "Search",
    title: <>Search <em>inside</em> your files.</>,
    body: <>Full-text content search across PDFs, Office docs, code, and plain text. Indexed in the background via Postgres <code>tsvector</code> + GIN, with highlighted <code>ts_headline</code> snippets so you find the passage, not just the filename. <a href="/docs/search" className="lp-inline-more">How it works →</a></>,
    visual: <div className="lp-mock lp-mock-card" aria-hidden="true">
      <div className="lp-mock-card-head"><Search size={16} strokeWidth={1.75} /><code>"key rotation"</code></div>
      <div className="lp-mock-action-body">
        <div className="lp-mock-action-line"><FolderIcon size={14} strokeWidth={1.75} /><strong>security/runbook.md</strong></div>
        <div className="lp-mock-action-result"><span>… steps for <b>key rotation</b> in the prod cluster …</span></div>
        <div className="lp-mock-action-line"><FolderIcon size={14} strokeWidth={1.75} /><strong>q3-audit.pdf</strong></div>
        <div className="lp-mock-action-result"><span>… <b>key rotation</b> evidence reviewed, see Appendix C …</span></div>
      </div>
    </div>,
  },
  {
    num: "09",
    eyebrow: "Photo backup",
    title: <>Camera roll on <em>your own server</em>.</>,
    body: <>An idempotent mobile protocol: init once, send your local asset IDs to the manifest endpoint, upload only what the server doesn't have. Retry-safe across flaky networks. Swift, Kotlin, Dart, and TypeScript SDKs ship with helpers. <a href="/docs/photo-backup" className="lp-inline-more">Protocol spec →</a></>,
    visual: <div className="lp-mock lp-mock-card" aria-hidden="true">
      <div className="lp-mock-card-head"><Smartphone size={16} strokeWidth={1.75} /><strong>Photo backup</strong><span className="lp-mock-action-chip"><Check size={11} strokeWidth={2.5} /> 2,418 backed up</span></div>
      <div className="lp-mock-action-body">
        <div className="lp-mock-action-line"><code className="lp-mock-event">manifest</code><ArrowRight size={14} strokeWidth={2} className="lp-mock-arrow" /><code className="lp-mock-slug">{`{ known: 2,401 }`}</code></div>
        <div className="lp-mock-action-line"><code className="lp-mock-event">upload</code><ArrowRight size={14} strokeWidth={2} className="lp-mock-arrow" /><code className="lp-mock-slug">17 new (3 retried)</code></div>
      </div>
    </div>,
  },
  {
    num: "10",
    eyebrow: "SSO",
    title: <>Enterprise <em>sign-on</em>.</>,
    body: <>Delegate authentication to your IdP via OIDC (PKCE + JWKS-verified ID tokens) or LDAP (bind-and-search). Auto-provision new users or restrict to invite-only — your call. <a href="/docs/auth-external" className="lp-inline-more">OIDC + LDAP setup →</a></>,
    visual: <div className="lp-mock lp-mock-card" aria-hidden="true">
      <div className="lp-mock-card-head"><KeyRound size={16} strokeWidth={1.75} /><strong>Sign in</strong></div>
      <div className="lp-mock-action-body">
        <button type="button" className="lp-mock-link-bar"><Lock size={13} strokeWidth={2} /> Sign in with Okta</button>
        <button type="button" className="lp-mock-link-bar">🔑 Sign in with a passkey</button>
        <div className="lp-mock-action-line"><span>Email or username</span></div>
        <div className="lp-mock-action-line"><span>Password</span></div>
      </div>
    </div>,
  },
  {
    num: "11",
    eyebrow: "Mailbox + activity",
    title: <>Comments, messages, <em>and a real inbox</em>.</>,
    body: <>Per-file comments with notifications, a user-to-user mailbox, and system messages from Stohr itself (welcome, account events, owner broadcasts). The activity feed pulls every event a user has access to into one timeline. <a href="/docs/messaging" className="lp-inline-more">Messaging docs →</a></>,
    visual: <div className="lp-mock lp-mock-card" aria-hidden="true">
      <div className="lp-mock-card-head"><Mail size={16} strokeWidth={1.75} /><strong>Inbox</strong><span className="lp-mock-action-chip">3 unread</span></div>
      <ul className="lp-mock-collab-list">
        <li><span className="lp-mock-avatar lp-mock-avatar-1">·</span><span className="lp-mock-collab-name">Welcome to Stohr</span><span className="lp-mock-role lp-mock-role-pending">system</span></li>
        <li><span className="lp-mock-avatar lp-mock-avatar-2">A</span><span className="lp-mock-collab-name">Q3 review notes — Alice</span><span className="lp-mock-role lp-mock-role-editor">user</span></li>
        <li><span className="lp-mock-avatar lp-mock-avatar-3">B</span><span className="lp-mock-collab-name">Re: shared folder — Ben</span><span className="lp-mock-role lp-mock-role-viewer">user</span></li>
      </ul>
    </div>,
  },
]
