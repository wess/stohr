import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  Briefcase,
  Calendar,
  Camera,
  Check,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FileArchive,
  FileAudio,
  FileCode,
  File as FileIconBase,
  FileImage,
  FileText,
  FileVideo,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  HelpCircle,
  Inbox,
  KeyRound,
  LayoutGrid,
  Link2,
  List,
  Mail,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  MoreVertical,
  Music,
  PanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  Upload as UploadIcon,
  UserPlus,
  Users,
  UsersRound,
  X,
  Zap,
} from "lucide-react"
import React, { useEffect, useId, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import * as api from "./api.ts"
import { Logo } from "./logo.tsx"
import { getTheme, setTheme as setThemePref, type Theme } from "./theme.ts"

// Rows fetched per listing request. Matches the API's default page size, so a
// short page reliably means "that's everything".
const PAGE_SIZE = 200

type Route =
  | { kind: "root" }
  | { kind: "folder"; id: number; ownerUsername?: string }
  | { kind: "file"; id: number; ownerUsername?: string }
  | { kind: "shared" }
  | { kind: "links" }
  | { kind: "actions" }
  | { kind: "actionEdit"; id: number }
  | { kind: "trash" }
  | { kind: "notifications" }
  | { kind: "messages" }
  | { kind: "messageThread"; threadId: number }
  | { kind: "spaces" }
  | { kind: "space"; id: number }
  | { kind: "settings" }
  | { kind: "admin"; section?: string }
  | { kind: "team"; section?: string }
  | { kind: "share"; token: string }
  | { kind: "publicFolder"; username: string; folderId: number }
  | { kind: "oauthAuthorize"; query: string }
  | { kind: "pair"; query: string }
  | { kind: "passwordForgot" }
  | { kind: "passwordReset"; token: string }
  | { kind: "contact" }

const parseRoute = (loc: { pathname: string; search: string }): Route => {
  const path = loc.pathname
  if (path === "/oauth/authorize") return { kind: "oauthAuthorize", query: loc.search }
  if (path === "/pair") return { kind: "pair", query: loc.search }
  if (path === "/password/forgot") return { kind: "passwordForgot" }
  if (path === "/password/reset") {
    const token = new URLSearchParams(loc.search).get("token") ?? ""
    return { kind: "passwordReset", token }
  }
  if (path === "/contact") return { kind: "contact" }
  const share = path.match(/^\/s\/(.+)$/)
  if (share) return { kind: "share", token: share[1]! }
  const pub = path.match(/^\/p\/([^/]+)\/(\d+)/)
  if (pub) return { kind: "publicFolder", username: pub[1]!, folderId: Number(pub[2]) }
  const f1 = path.match(/^\/app\/u\/([^/]+)\/f\/(\d+)/)
  if (f1) return { kind: "folder", ownerUsername: f1[1], id: Number(f1[2]) }
  const f2 = path.match(/^\/app\/u\/([^/]+)\/file\/(\d+)/)
  if (f2) return { kind: "file", ownerUsername: f2[1], id: Number(f2[2]) }
  const f3 = path.match(/^\/app\/f\/(\d+)/)
  if (f3) return { kind: "folder", id: Number(f3[1]) }
  if (path === "/app/shared") return { kind: "shared" }
  if (path === "/app/links") return { kind: "links" }
  if (path === "/app/trash") return { kind: "trash" }
  if (path === "/app/notifications") return { kind: "notifications" }
  if (path === "/app/messages") return { kind: "messages" }
  const thread = path.match(/^\/app\/messages\/thread\/(\d+)$/)
  if (thread) return { kind: "messageThread", threadId: Number(thread[1]) }
  if (path === "/app/spaces") return { kind: "spaces" }
  const space = path.match(/^\/app\/spaces\/(\d+)$/)
  if (space) return { kind: "space", id: Number(space[1]) }
  if (path === "/app/settings") return { kind: "settings" }
  const admin = path.match(/^\/app\/admin(?:\/([a-z]+))?$/)
  if (admin) return { kind: "admin", section: admin[1] }
  const team = path.match(/^\/app\/team(?:\/([a-z]+))?$/)
  if (team) return { kind: "team", section: team[1] }
  if (path === "/app/actions") return { kind: "actions" }
  const actEdit = path.match(/^\/app\/actions\/(\d+)\/edit/)
  if (actEdit) return { kind: "actionEdit", id: Number(actEdit[1]) }
  return { kind: "root" }
}

const navigate = (path: string) => {
  if (window.location.pathname + window.location.search === path) return
  history.pushState(null, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

// Which tenant this page is on, before there is a session to ask. The web
// server stamps ROOT_DOMAIN into the document (src/web/serve.ts); the host's
// extra label is the team slug. null on the root host or when host routing
// is off. /me gives the real team name once signed in.
const hostTeamSlug = (): string | null => {
  const root = document.querySelector('meta[name="stohr-root-domain"]')?.getAttribute("content")?.toLowerCase()
  if (!root) return null
  const host = window.location.hostname.toLowerCase()
  if (host === root || !host.endsWith(`.${root}`)) return null
  const label = host.slice(0, -(root.length + 1))
  return label && !label.includes(".") ? label : null
}

type Tenant = { slug: string; name: string }

const folderHref = (id: number, ownerUsername?: string) =>
  ownerUsername ? `/app/u/${ownerUsername}/f/${id}` : `/app/f/${id}`

const _fileHref = (id: number, ownerUsername: string) => `/app/u/${ownerUsername}/file/${id}`

type Folder = {
  id: number
  name: string
  parent_id: number | null
  kind?: string
  is_public?: boolean
  created_at: string
}
type FileItem = {
  id: number
  name: string
  mime: string
  size: number
  folder_id: number | null
  version: number
  created_at: string
}
type Crumb = { id: number; name: string }
type Share = {
  id: number
  token: string
  expires_at: string | null
  created_at: string
  name: string
  size: number
  mime: string
  file_id: number
  password_required?: boolean
  burn_on_view?: boolean
}
type TrashedFolder = Folder & { deleted_at: string }
type TrashedFile = FileItem & { deleted_at: string }
type FileVersion = {
  version: number
  mime: string
  size: number
  uploaded_by: number | null
  uploaded_at: string
  is_current: boolean
}

const formatBytes = (b: number) => {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const stampForFilename = (d: Date): string => {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
}

const captureFrame = async (stream: MediaStream): Promise<Blob> => {
  const video = document.createElement("video")
  video.srcObject = stream
  video.muted = true
  await video.play()
  // Give the browser one frame to settle dimensions.
  await new Promise<void>(r => requestAnimationFrame(() => r()))
  const w = video.videoWidth || 1920
  const h = video.videoHeight || 1080
  const canvas = document.createElement("canvas")
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Could not create canvas context")
  ctx.drawImage(video, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Could not encode PNG"))), "image/png")
  })
}

const ensureScreenshotsFolder = async (): Promise<number> => {
  const folders = (await api.listFolders(null)) as Array<{ id: number; name: string; kind?: string }>
  const existing = folders.find(f => f.kind === "screenshots")
  if (existing) return existing.id
  const created = (await api.createFolderTyped("Screenshots", null, { kind: "screenshots" })) as {
    id?: number
    error?: string
  }
  if (!created.id) throw new Error(created.error ?? "Could not create Screenshots folder")
  return created.id
}

const MimeIcon: React.FC<{ mime: string; size?: number }> = ({ mime, size = 28 }) => {
  if (mime.startsWith("image/")) return <FileImage size={size} strokeWidth={1.5} />
  if (mime.startsWith("video/")) return <FileVideo size={size} strokeWidth={1.5} />
  if (mime.startsWith("audio/")) return <FileAudio size={size} strokeWidth={1.5} />
  if (mime.includes("pdf")) return <FileText size={size} strokeWidth={1.5} />
  if (mime.includes("zip") || mime.includes("compressed") || mime.includes("x-tar") || mime.includes("gzip"))
    return <FileArchive size={size} strokeWidth={1.5} />
  if (
    mime.includes("javascript") ||
    mime.includes("typescript") ||
    mime.includes("x-sh") ||
    mime.includes("json") ||
    mime.includes("xml")
  )
    return <FileCode size={size} strokeWidth={1.5} />
  if (mime.startsWith("text/")) return <FileText size={size} strokeWidth={1.5} />
  return <FileIconBase size={size} strokeWidth={1.5} />
}

const FileThumb: React.FC<{ file: FileItem }> = ({ file }) => {
  const fallback = (
    <div className="icon">
      <MimeIcon mime={file.mime} size={32} />
    </div>
  )
  if (!file.mime.startsWith("image/")) return fallback
  return (
    <div className="thumb">
      <AuthedImage src={`/api/files/${file.id}/thumb?v=${file.version}`} alt="" useAuth fallback={fallback} />
    </div>
  )
}

const Auth: React.FC<{
  onLogin: () => void
  initialInvite?: string | null
  needsSetup: boolean
  initialMode?: "login" | "signup"
  oauthNext?: string
  // set on a team host: external login and open signup live on the root only
  tenant?: Tenant | null
}> = ({ onLogin, initialInvite, needsSetup, initialMode, oauthNext, tenant = null }) => {
  const [mode, setMode] = useState<"login" | "signup">(
    initialMode ?? (needsSetup || initialInvite ? "signup" : "login"),
  )
  const [name, setName] = useState("")
  const [username, setUsername] = useState("")
  const [identity, setIdentity] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteToken, setInviteToken] = useState(initialInvite ?? "")
  const [inviteEmailLock, setInviteEmailLock] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState("")
  const [mfaUseBackup, setMfaUseBackup] = useState(false)
  const [mfaBackup, setMfaBackup] = useState("")
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [oidc, setOidc] = useState<{ available: boolean; label: string } | null>(null)
  const [sso, setSso] = useState<{ available: boolean; label: string } | null>(null)
  const [ldap, setLdap] = useState<{ available: boolean } | null>(null)
  const [useLdap, setUseLdap] = useState(false)

  useEffect(() => {
    if (needsSetup) return
    if (mode !== "signup" || !inviteToken) return
    let cancelled = false
    api.checkInvite(inviteToken).then((res: any) => {
      if (cancelled) return
      if (res?.valid === false) {
        setError(res.error ?? "Invalid invite")
        setInviteEmailLock(null)
      } else if (res?.valid && res.email) {
        setEmail(res.email)
        setInviteEmailLock(res.email)
        setError("")
      } else {
        setInviteEmailLock(null)
        setError("")
      }
    })
    return () => {
      cancelled = true
    }
  }, [mode, inviteToken, needsSetup])

  useEffect(() => {
    // the status routes answer "unavailable" on a team host anyway
    if (needsSetup || tenant) return
    let cancelled = false
    Promise.all([api.oidcStatus(), api.ldapStatus(), api.ssoStatus()])
      .then(([o, l, s]) => {
        if (cancelled) return
        setOidc(o)
        setLdap(l)
        setSso(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [needsSetup, tenant])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      setError("")
      if (mode === "signup") {
        const res = await api.signup({
          name,
          username,
          email,
          password,
          inviteToken: needsSetup ? undefined : inviteToken,
        })
        if (res.error) return setError(res.error)
        if (!res.token) return setError("Authentication failed")
        if (window.location.pathname === "/signup") history.replaceState(null, "", "/")
        onLogin()
        return
      }
      if (useLdap) {
        const res = await api.loginLdap(identity, password)
        if (res.error) return setError(res.error)
        if (!res.token) return setError("Authentication failed")
        if (oauthNext) {
          history.replaceState(null, "", oauthNext)
          window.dispatchEvent(new PopStateEvent("popstate"))
        }
        onLogin()
        return
      }
      const res = await api.login(identity, password)
      if (res.error) return setError(res.error)
      if (res.mfa_required && res.mfa_token) {
        setMfaToken(res.mfa_token)
        setMfaCode("")
        return
      }
      if (!res.token) return setError("Authentication failed")
      if (window.location.pathname === "/signup") history.replaceState(null, "", "/")
      if (oauthNext) {
        history.replaceState(null, "", oauthNext)
        window.dispatchEvent(new PopStateEvent("popstate"))
      }
      onLogin()
    } catch {
      setError("Could not sign in. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const submitMfa = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (!mfaToken) return
      setError("")
      const res = await api.loginMfa(mfaToken, mfaUseBackup ? { backupCode: mfaBackup } : { code: mfaCode })
      if (res.error) return setError(res.error)
      if (!res.token) return setError("Authentication failed")
      if (oauthNext) {
        history.replaceState(null, "", oauthNext)
        window.dispatchEvent(new PopStateEvent("popstate"))
      }
      onLogin()
    } catch {
      setError("Could not sign in. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const signInWithPasskey = async () => {
    setError("")
    setPasskeyBusy(true)
    try {
      const SWB: typeof import("@simplewebauthn/browser") = await import("@simplewebauthn/browser")
      const options = await api.beginPasskeyDiscoverableLogin()
      if ((options as any)?.error) {
        setError((options as any).error)
        return
      }
      let assertion: any
      try {
        assertion = await SWB.startAuthentication({ optionsJSON: options })
      } catch (e: any) {
        if (e?.name === "NotAllowedError") setError("Cancelled, or no matching passkey on this device.")
        else setError(e?.message ?? "Passkey sign-in failed.")
        return
      }
      const res = await api.finishPasskeyDiscoverableLogin(assertion)
      if ((res as any).error) {
        setError((res as any).error)
        return
      }
      if (!res.token) {
        setError("Authentication failed")
        return
      }
      if (window.location.pathname === "/signup") history.replaceState(null, "", "/")
      if (oauthNext) {
        history.replaceState(null, "", oauthNext)
        window.dispatchEvent(new PopStateEvent("popstate"))
      }
      onLogin()
    } finally {
      setPasskeyBusy(false)
    }
  }

  const heading = needsSetup
    ? "Set up your Stohr"
    : mode === "login"
      ? tenant
        ? `Sign in to ${tenant.name}`
        : "Sign in to your cloud storage"
      : tenant
        ? `Join ${tenant.name}`
        : "Create your account"

  return (
    <div className="auth">
      <Logo className="auth-logo" />
      {tenant && <div className="auth-team">{tenant.slug}</div>}
      <h2>{heading}</h2>
      {needsSetup && (
        <div
          style={{
            background: "var(--accent-bg)",
            color: "var(--brand)",
            border: "1px solid var(--brand)",
            padding: 10,
            borderRadius: 6,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          No accounts yet. The first user becomes the owner and can invite others.
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {mfaToken ? (
        <>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 8 }}>
            Enter the 6-digit code from your authenticator app.
          </div>
          {mfaUseBackup ? (
            <input
              aria-label="Backup code (xxxxx-xxxxx)"
              placeholder="Backup code (xxxxx-xxxxx)"
              value={mfaBackup}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              onChange={e => setMfaBackup(e.target.value.trim())}
              onKeyDown={e => e.key === "Enter" && submitMfa()}
            />
          ) : (
            <input
              aria-label="Authenticator code"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              value={mfaCode}
              autoFocus
              inputMode="numeric"
              maxLength={6}
              onChange={e => setMfaCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={e => e.key === "Enter" && submitMfa()}
            />
          )}
          <button
            type="button"
            className="primary"
            onClick={submitMfa}
            disabled={busy || !(mfaUseBackup ? mfaBackup.trim() : mfaCode.length === 6)}
          >
            {busy ? "Verifying…" : "Verify"}
          </button>
          <button
            type="button"
            className="toggle"
            onClick={() => {
              setMfaUseBackup(!mfaUseBackup)
              setError("")
            }}
          >
            {mfaUseBackup ? "Use authenticator code instead" : "Use a backup code"}
          </button>
          <button
            type="button"
            className="toggle"
            onClick={() => {
              setMfaToken(null)
              setMfaCode("")
              setMfaBackup("")
              setError("")
            }}
          >
            Cancel
          </button>
        </>
      ) : mode === "signup" ? (
        <>
          <input
            aria-label="Name"
            autoComplete="name"
            placeholder="Name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <input
            aria-label="Username"
            autoComplete="username"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <input
            aria-label="Email"
            autoComplete="email"
            placeholder="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            disabled={!!inviteEmailLock}
          />
          <input
            aria-label="Password, at least 8 characters"
            autoComplete="new-password"
            placeholder="Password (min 8 chars)"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => needsSetup && e.key === "Enter" && submit()}
          />
          {!needsSetup && (
            <input
              aria-label="Invite token"
              placeholder="Invite token"
              value={inviteToken}
              onChange={e => setInviteToken(e.target.value.trim())}
              onKeyDown={e => e.key === "Enter" && submit()}
            />
          )}
        </>
      ) : (
        <>
          {!needsSetup && sso?.available && (
            <>
              <button
                type="button"
                className="passkey-cta"
                onClick={() => {
                  api.markSsoStart()
                  window.location.href = "/auth/sso/login"
                }}
              >
                <ShieldCheck size={16} /> Sign in with {sso.label}
              </button>
              <div className="auth-divider">
                <span>or</span>
              </div>
            </>
          )}
          {!needsSetup && oidc?.available && (
            <>
              <button
                type="button"
                className="passkey-cta"
                onClick={() => {
                  const next = oauthNext ?? window.location.pathname + window.location.search
                  const q = next && next !== "/" ? `?redirect_to=${encodeURIComponent(next)}` : ""
                  api.markSsoStart()
                  window.location.href = `/api/auth/oidc/start${q}`
                }}
              >
                <ShieldCheck size={16} /> {oidc.label}
              </button>
              <div className="auth-divider">
                <span>or</span>
              </div>
            </>
          )}
          {!needsSetup && (
            <>
              <button type="button" className="passkey-cta" onClick={signInWithPasskey} disabled={passkeyBusy}>
                <KeyRound size={16} /> {passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey"}
              </button>
              <div className="auth-divider">
                <span>or</span>
              </div>
            </>
          )}
          <input
            aria-label={useLdap ? "LDAP username" : "Email or username"}
            autoComplete="username"
            placeholder={useLdap ? "LDAP username" : "Email or username"}
            value={identity}
            onChange={e => setIdentity(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <input
            aria-label="Password"
            autoComplete="current-password"
            placeholder="Password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        </>
      )}
      {!mfaToken && (
        <>
          <button type="button" className="primary" onClick={submit} disabled={busy || passkeyBusy}>
            {busy
              ? mode === "login"
                ? "Signing in…"
                : "Creating account…"
              : needsSetup
                ? "Create owner account"
                : mode === "login"
                  ? "Sign in"
                  : "Create account"}
          </button>
          {/* a team's members are made by its admins (or come in through
              an invite link, which lands here in signup mode already) */}
          {!needsSetup && (mode === "signup" || !tenant) && (
            <button type="button" className="toggle" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
              {mode === "login" ? "Have an invite? Create your account" : "Already have an account? Sign in"}
            </button>
          )}
          {!needsSetup && mode === "login" && (
            <button
              type="button"
              className="toggle"
              onClick={() => navigate("/password/forgot")}
              style={{ marginTop: 4 }}
            >
              Forgot your password?
            </button>
          )}
          {!needsSetup && mode === "login" && ldap?.available && (
            <button
              type="button"
              className="toggle"
              onClick={() => {
                setUseLdap(!useLdap)
                setError("")
              }}
              style={{ marginTop: 4 }}
            >
              {useLdap ? "Use a Stohr account instead" : "Sign in with LDAP"}
            </button>
          )}
        </>
      )}
    </div>
  )
}

const ForgotPasswordPage: React.FC = () => {
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle")
  const [error, setError] = useState("")

  const submit = async () => {
    if (status === "submitting") return
    if (!email.trim()) {
      setError("Email is required")
      return
    }
    setStatus("submitting")
    setError("")
    const res = await api.requestPasswordReset(email.trim())
    if (res.error) {
      setError(res.error)
      setStatus("idle")
      return
    }
    setStatus("sent")
  }

  return (
    <div className="auth">
      <Logo className="auth-logo" />
      <h2>Reset your password</h2>
      {status === "sent" ? (
        <>
          <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.5, margin: "0 0 16px" }}>
            If an account exists for <strong style={{ color: "var(--text)" }}>{email}</strong>, we've sent a link to
            reset your password. The link expires in one hour.
          </p>
          <div className="toggle" onClick={() => navigate("/login")}>
            Back to sign in
          </div>
        </>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          <input
            aria-label="Your email"
            type="email"
            placeholder="Your email"
            value={email}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
          <button type="button" className="primary" onClick={submit} disabled={status === "submitting"}>
            {status === "submitting" ? "Sending…" : "Send reset link"}
          </button>
          <div className="toggle" onClick={() => navigate("/login")}>
            Back to sign in
          </div>
        </>
      )}
    </div>
  )
}

const ResetPasswordPage: React.FC<{ token: string }> = ({ token }) => {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle")
  const [error, setError] = useState("")

  const submit = async () => {
    if (status === "submitting") return
    setError("")
    if (!token) {
      setError("Missing reset token")
      return
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters")
      return
    }
    if (password !== confirm) {
      setError("Passwords don't match")
      return
    }
    setStatus("submitting")
    const res = await api.resetPassword(token, password)
    if (res.error) {
      setError(res.error)
      setStatus("idle")
      return
    }
    setStatus("done")
  }

  return (
    <div className="auth">
      <Logo className="auth-logo" />
      <h2>Choose a new password</h2>
      {status === "done" ? (
        <>
          <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.5, margin: "0 0 16px" }}>
            Your password has been updated. All your other sessions have been signed out.
          </p>
          <button type="button" className="primary" onClick={() => navigate("/login")}>
            Sign in
          </button>
        </>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          <input
            aria-label="New password (min 8 chars)"
            type="password"
            placeholder="New password (min 8 chars)"
            value={password}
            autoFocus
            onChange={e => setPassword(e.target.value)}
          />
          <input
            aria-label="Confirm new password"
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
          <button type="button" className="primary" onClick={submit} disabled={status === "submitting"}>
            {status === "submitting" ? "Updating…" : "Update password"}
          </button>
          <div className="toggle" onClick={() => navigate("/login")}>
            Cancel
          </div>
        </>
      )}
    </div>
  )
}

// Shared form body — used by both the standalone /contact page and the
// modal that opens from the landing / developer pages. The honeypot input
// is invisible to humans (CSS hides it offscreen) and silently absorbs
// most form-spam bots.
const ContactForm: React.FC<{
  variant: "page" | "modal"
  onSent?: () => void
}> = ({ variant, onSent }) => {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [hp, setHp] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle")
  const [error, setError] = useState("")

  const submit = async () => {
    if (status === "submitting") return
    if (!name.trim() || !email.trim() || !subject.trim() || !message.trim()) {
      setError("All fields are required")
      return
    }
    setStatus("submitting")
    setError("")
    const res = await api.submitContact({
      name: name.trim(),
      email: email.trim(),
      subject: subject.trim(),
      message: message.trim(),
      hp,
    })
    if (res.error) {
      setError(res.error)
      setStatus("idle")
      return
    }
    setStatus("sent")
    onSent?.()
  }

  if (status === "sent") {
    return (
      <div className="contact-sent">
        <div className="contact-sent-icon">
          <Check size={28} strokeWidth={2} />
        </div>
        <h3>Message sent</h3>
        <p>
          Thanks — we read every one. We'll get back to you at <strong>{email}</strong>.
        </p>
        {variant === "page" && (
          <button type="button" className="primary" onClick={() => navigate("/")}>
            Back home
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="contact-form">
      {error && <div className="error">{error}</div>}
      <div className="contact-row">
        <label>
          <span>Your name</span>
          <input
            type="text"
            value={name}
            autoFocus={variant === "modal"}
            onChange={e => setName(e.target.value)}
            maxLength={200}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={email}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={e => setEmail(e.target.value)}
          />
        </label>
      </div>
      <label>
        <span>Subject</span>
        <input type="text" value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} />
      </label>
      <label>
        <span>Message</span>
        <textarea value={message} onChange={e => setMessage(e.target.value)} rows={6} maxLength={10000} />
      </label>
      {/* Honeypot: real users never see or fill this. */}
      <input
        className="contact-hp"
        type="text"
        name="hp"
        tabIndex={-1}
        autoComplete="off"
        value={hp}
        onChange={e => setHp(e.target.value)}
        aria-hidden="true"
      />
      <button type="button" className="primary" onClick={submit} disabled={status === "submitting"}>
        {status === "submitting" ? "Sending…" : "Send message"}
      </button>
    </div>
  )
}

const ContactPage: React.FC = () => {
  useEffect(() => {
    document.title = "Stohr — Contact"
  }, [])
  return (
    <div className="lp">
      <header className="lp-nav">
        <a href="/" className="lp-brand">
          <Logo />
        </a>
        <nav className="lp-nav-links">
          <a href="/#features">Features</a>
          <a href="/developers">Developers</a>
          <a href="https://github.com/wess/stohr" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <div className="lp-nav-cta">
          <a href="/login" className="lp-link">
            Sign in
          </a>
          <a href="/" className="lp-btn lp-btn-ghost">
            Home
          </a>
        </div>
      </header>

      <section className="contact-page">
        <div className="contact-page-head">
          <p className="lp-eyebrow">Get in touch</p>
          <h1>Contact us.</h1>
          <p className="lp-lede">
            Bug report, feature request, billing question, or just a hello — we read every message.
          </p>
        </div>
        <div className="contact-page-card">
          <ContactForm variant="page" />
        </div>
      </section>
    </div>
  )
}

const UploadPanel: React.FC<{
  uploads: Uploading[]
  onCancel: (id: string) => void
  onDismiss: (id: string) => void
  onClear: () => void
}> = ({ uploads, onCancel, onDismiss, onClear }) => {
  if (uploads.length === 0) return null
  const active = uploads.filter(u => u.status === "uploading").length
  const totalLoaded = uploads.reduce((a, u) => a + u.loaded, 0)
  const totalSize = uploads.reduce((a, u) => a + u.size, 0)

  return (
    <div className="upload-panel">
      <div className="upload-panel-header">
        <div>
          {active > 0 ? (
            <>
              Uploading{" "}
              <span style={{ color: "var(--muted)" }}>
                {active} of {uploads.length}
              </span>{" "}
              · {formatBytes(totalLoaded)} / {formatBytes(totalSize)}
            </>
          ) : (
            <>
              {uploads.length} upload{uploads.length === 1 ? "" : "s"}
            </>
          )}
        </div>
        <button type="button" onClick={onClear}>
          {active > 0 ? "Cancel all" : "Dismiss all"}
        </button>
      </div>
      <div className="upload-list">
        {uploads.map(u => {
          const pct = u.size === 0 ? 100 : Math.min(100, Math.round((u.loaded / u.size) * 100))
          return (
            <div key={u.id} className={`upload-item ${u.status}`}>
              <div className="upload-line">
                <div className="upload-name" title={u.name}>
                  {u.name}
                </div>
                <div className="upload-meta">
                  {u.status === "uploading" && `${pct}% · ${formatBytes(u.loaded)} / ${formatBytes(u.size)}`}
                  {u.status === "done" && `${formatBytes(u.size)}`}
                  {u.status === "error" && (u.error ?? "Failed")}
                </div>
              </div>
              <div className="upload-bar">
                <div className="upload-fill" style={{ width: `${pct}%` }} />
              </div>
              {u.status === "uploading" && (
                <button type="button" className="upload-cancel" onClick={() => onCancel(u.id)} aria-label="Cancel">
                  <X size={12} />
                </button>
              )}
              {u.status !== "uploading" && (
                <button type="button" className="upload-cancel" onClick={() => onDismiss(u.id)} aria-label="Dismiss">
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; size?: "default" | "wide" }> = ({
  title,
  onClose,
  children,
  size = "default",
}) => {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    dialog
      ?.querySelector<HTMLElement>(
        "input:not([disabled]):not([type=hidden]):not([type=checkbox]), textarea:not([disabled]), select:not([disabled])",
      )
      ?.focus()
    return () => {
      dialog?.close()
      previous?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="modal-backdrop"
      aria-labelledby={titleId}
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`modal${size === "wide" ? " modal-wide" : ""}`}>
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

type PaletteFolder = { id: number; name: string; parent_id: number | null }
type PaletteResults = { files: FileItem[]; folders: PaletteFolder[]; content: api.ContentHit[] }

type FolderDetail = {
  id: number
  name: string
  parent_id: number | null
  role: "owner" | "editor" | "viewer"
  owner: { id: number; username: string; name: string } | null
  trail: Crumb[]
}

type Uploading = {
  id: string
  name: string
  size: number
  loaded: number
  status: "uploading" | "done" | "error"
  error?: string
  abort: () => void
}

type KebabItem = {
  label: string
  onClick: () => void
  danger?: boolean
  hidden?: boolean
}

const CardKebab: React.FC<{ items: KebabItem[]; ariaLabel?: string }> = ({ items, ariaLabel = "More" }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const visible = items.filter(i => !i.hidden)

  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLButtonElement>(".kebab-item")?.focus()
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        ref.current?.querySelector<HTMLButtonElement>(".kebab-trigger")?.focus()
      }
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (visible.length === 0) return null

  return (
    <div className={`kebab${open ? " open" : ""}`} ref={ref} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="kebab-trigger"
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={e => {
          e.stopPropagation()
          setOpen(v => !v)
        }}
      >
        <MoreVertical size={16} strokeWidth={2} />
      </button>
      {open && (
        <div
          id={menuId}
          className="kebab-menu"
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={e => {
            const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const key = e.key
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return
            e.preventDefault()
            const next =
              key === "Home"
                ? 0
                : key === "End"
                  ? buttons.length - 1
                  : (index + (key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}
        >
          {visible.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`kebab-item${item.danger ? " danger" : ""}`}
              onClick={() => {
                setOpen(false)
                ref.current?.querySelector<HTMLButtonElement>(".kebab-trigger")?.focus()
                item.onClick()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const Files: React.FC<{
  routeFolderId: number | null
  routeFileId: number | null
  onSpaceChange: (id: number | null) => void
}> = ({ routeFolderId, routeFileId, onSpaceChange }) => {
  const [folders, setFolders] = useState<Folder[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [currentId, setCurrentId] = useState<number | null>(routeFolderId)
  const uploadFolder = useRef(currentId)
  uploadFolder.current = currentId
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const [currentRole, setCurrentRole] = useState<"owner" | "editor" | "viewer">("owner")
  const [currentSpace, setCurrentSpace] = useState<{ id: number; name: string } | null>(null)
  const [currentOwner, setCurrentOwner] = useState<{ id: number; username: string; name: string } | null>(null)
  const [currentKind, setCurrentKind] = useState<string>("standard")
  const [currentIsPublic, setCurrentIsPublic] = useState<boolean>(false)
  const [preferredView, setPreferredView] = useState<"grid" | "list" | "gallery" | null>(() => {
    const saved = localStorage.getItem("stohr_file_view")
    return saved === "grid" || saved === "list" || saved === "gallery" ? saved : null
  })
  const view = preferredView ?? (currentKind === "photos" || currentKind === "screenshots" ? "gallery" : "grid")
  const mediaFiles = files.filter(f => f.mime.startsWith("image/") || f.mime.startsWith("video/"))
  const [showFolderSettings, setShowFolderSettings] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [operationError, setOperationError] = useState("")
  const [busy, setBusy] = useState(false)
  const loadId = useRef(0)
  const [dragOver, setDragOver] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [sharing, setSharing] = useState<{ kind: "file" | "folder"; id: number; name: string } | null>(null)
  const [renaming, setRenaming] = useState<{ kind: "folder" | "file"; id: number; name: string } | null>(null)
  const [previewing, setPreviewing] = useState<FileItem | null>(null)
  const [viewingVersions, setViewingVersions] = useState<FileItem | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const [movingOpen, setMovingOpen] = useState(false)
  const [uploads, setUploads] = useState<Uploading[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const me = api.getUser()
  const canEdit = !loading && !loadError && (currentRole === "owner" || currentRole === "editor")

  useEffect(() => {
    if (routeFolderId !== currentId) setCurrentId(routeFolderId)
  }, [routeFolderId])

  useEffect(() => {
    if (!routeFileId) return
    let aborted = false
    ;(async () => {
      const f = await api.getFile(routeFileId)
      if (aborted || !f || f.error) return
      setCurrentId(f.folder_id ?? null)
      setPreviewing(f)
    })()
    return () => {
      aborted = true
    }
  }, [routeFileId])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState("")
  const [paletteResults, setPaletteResults] = useState<PaletteResults>({ files: [], folders: [], content: [] })
  const [paletteActive, setPaletteActive] = useState(0)
  const [paletteLoading, setPaletteLoading] = useState(false)
  const [paletteError, setPaletteError] = useState("")
  const [paletteRetry, setPaletteRetry] = useState(0)

  const [moreFiles, setMoreFiles] = useState(false)
  const [moreFolders, setMoreFolders] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // Listings are paged. A full page back means there is probably another one;
  // that's the same signal the API reports in x-has-more, without needing the
  // response headers here.
  const load = async () => {
    const requestId = ++loadId.current
    setLoading(true)
    setLoadError("")
    try {
      const [fo, fi, detail] = await Promise.all([
        api.listFolders(currentId, { limit: PAGE_SIZE }),
        api.listFiles(currentId, undefined, { limit: PAGE_SIZE }),
        currentId == null ? Promise.resolve(null) : api.getFolder(currentId),
      ])
      if (requestId !== loadId.current) return
      if (!Array.isArray(fo) || !Array.isArray(fi) || detail?.error) {
        throw new Error(detail?.error ?? fo?.error ?? fi?.error ?? "Could not load files. Try again.")
      }
      const space = detail?.space_id ? await api.getSpace(detail.space_id) : null
      if (requestId !== loadId.current) return
      if ((space as any)?.error) throw new Error((space as any).error)
      setCurrentSpace(space ? { id: space.id, name: space.name } : null)
      onSpaceChange(space?.id ?? null)
      setFolders(fo)
      setFiles(fi)
      setMoreFolders(fo.length >= PAGE_SIZE)
      setMoreFiles(fi.length >= PAGE_SIZE)
      setCrumbs(detail?.trail ?? [])
      setCurrentRole(detail?.role ?? "owner")
      setCurrentOwner(detail?.owner ?? null)
      setCurrentKind(detail?.kind ?? "standard")
      setCurrentIsPublic(!!detail?.is_public)
    } catch (e: any) {
      if (requestId === loadId.current) setLoadError(e?.message ?? "Could not load files. Try again.")
    } finally {
      if (requestId === loadId.current) setLoading(false)
    }
  }

  const loadMore = async () => {
    if (loadingMore || loading) return
    const requestId = loadId.current
    setLoadingMore(true)
    try {
      const [fo, fi] = await Promise.all([
        moreFolders ? api.listFolders(currentId, { limit: PAGE_SIZE, offset: folders.length }) : Promise.resolve([]),
        moreFiles
          ? api.listFiles(currentId, undefined, { limit: PAGE_SIZE, offset: files.length })
          : Promise.resolve([]),
      ])
      if (requestId !== loadId.current) return
      if (!Array.isArray(fo) || !Array.isArray(fi)) throw new Error("Could not load more files. Try again.")
      const foRows = Array.isArray(fo) ? fo : []
      const fiRows = Array.isArray(fi) ? fi : []
      if (moreFolders) {
        setFolders(prev => [...prev, ...foRows])
        setMoreFolders(foRows.length >= PAGE_SIZE)
      }
      if (moreFiles) {
        setFiles(prev => [...prev, ...fiRows])
        setMoreFiles(fiRows.length >= PAGE_SIZE)
      }
    } catch (e: any) {
      setOperationError(e?.message ?? "Could not load more files. Try again.")
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    load()
    return () => {
      loadId.current++
    }
  }, [currentId])
  useEffect(() => {
    setSelected(new Set())
    setLastClicked(null)
    setOperationError("")
  }, [currentId])

  useEffect(() => {
    if (currentId == null) {
      if (window.location.pathname.startsWith("/app/")) navigate("/")
      return
    }
    const ownerSlug =
      !currentSpace && currentOwner && me && currentOwner.id !== me.id ? currentOwner.username : undefined
    const want = folderHref(currentId, ownerSlug)
    if (window.location.pathname !== want) {
      history.replaceState(null, "", want)
    }
  }, [currentId, currentOwner?.id, currentSpace?.id])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setPaletteOpen(true)
        setPaletteQuery("")
        setPaletteResults({ files: [], folders: [], content: [] })
        setPaletteActive(0)
        setPaletteLoading(false)
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [])

  useEffect(() => {
    if (!paletteOpen) return
    setPaletteError("")
    if (!paletteQuery.trim()) {
      setPaletteLoading(false)
      setPaletteResults({ files: [], folders: [], content: [] })
      setPaletteActive(0)
      return
    }
    setPaletteLoading(true)
    setPaletteResults({ files: [], folders: [], content: [] })
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const [nameRes, contentRes] = await Promise.all([
          api.search(paletteQuery, undefined, ctrl.signal),
          api.searchContent(paletteQuery, 10).catch(() => ({ query: "", files: [] as api.ContentHit[] })),
        ])
        if (ctrl.signal.aborted) return
        if (nameRes.error) throw new Error(nameRes.error)
        const results: PaletteResults = {
          folders: Array.isArray((nameRes as any)?.folders) ? (nameRes as any).folders : [],
          files: Array.isArray((nameRes as any)?.files) ? (nameRes as any).files : [],
          content: Array.isArray(contentRes?.files) ? contentRes.files : [],
        }
        setPaletteResults(results)
        setPaletteActive(prev => {
          const total = results.folders.length + results.files.length + results.content.length
          return total === 0 ? 0 : Math.min(prev, total - 1)
        })
      } catch (err) {
        if (ctrl.signal.aborted) return
        setPaletteError("Could not search. Try again.")
        setPaletteResults({ files: [], folders: [], content: [] })
        setPaletteActive(0)
      } finally {
        if (!ctrl.signal.aborted) setPaletteLoading(false)
      }
    }, 150)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [paletteOpen, paletteQuery, paletteRetry])

  const orderedKeys = useMemo(
    () => [...folders.map(f => `fo-${f.id}`), ...files.map(f => `fi-${f.id}`)],
    [folders, files],
  )

  const toggleSelect = (key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const next = new Set(selected)
    if (e.shiftKey && lastClicked) {
      const a = orderedKeys.indexOf(lastClicked)
      const b = orderedKeys.indexOf(key)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        for (let i = lo; i <= hi; i++) next.add(orderedKeys[i]!)
      } else {
        next.has(key) ? next.delete(key) : next.add(key)
      }
    } else {
      next.has(key) ? next.delete(key) : next.add(key)
    }
    setSelected(next)
    setLastClicked(key)
  }

  const clearSelection = () => {
    setSelected(new Set())
    setLastClicked(null)
  }

  const selectAll = () => {
    if (selected.size === orderedKeys.length) clearSelection()
    else setSelected(new Set(orderedKeys))
  }

  const bulkOperation = async (targetFolderId?: number | null) => {
    if (!canEdit || busy) return
    const deleting = targetFolderId === undefined
    if (deleting && !confirm(`Move ${selected.size} item${selected.size === 1 ? "" : "s"} to Trash?`)) return
    setBusy(true)
    setOperationError("")
    const keys = [...selected]
    const results = await Promise.allSettled(
      keys.map(key => {
        const [kind, idStr] = key.split("-")
        const id = Number(idStr)
        if (deleting) return kind === "fo" ? api.deleteFolder(id) : api.deleteFile(id)
        return kind === "fo" ? api.moveFolder(id, targetFolderId) : api.moveFile(id, targetFolderId)
      }),
    )
    const failed = keys.filter((_, i) => {
      const result = results[i]!
      return result.status === "rejected" || result.value?.error
    })
    setBusy(false)
    setMovingOpen(false)
    setSelected(new Set(failed))
    setLastClicked(null)
    if (failed.length)
      setOperationError(
        `${failed.length} item${failed.length === 1 ? "" : "s"} could not be ${deleting ? "moved to Trash" : "moved"}. Check your access and try again.`,
      )
    await load()
  }
  const bulkDelete = () => bulkOperation()
  const bulkMove = (targetFolderId: number | null) => bulkOperation(targetFolderId)

  const upload = async (list: FileList | File[]) => {
    if (!canEdit) return
    const files = Array.from(list)
    if (files.length === 0) return

    const cancelled = new Set<string>()
    const queued: Uploading[] = files.map(f => {
      const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${f.name}`
      return {
        id,
        name: f.name,
        size: f.size,
        loaded: 0,
        status: "uploading",
        abort: () => {
          cancelled.add(id)
        },
      }
    })
    setUploads(prev => [...prev, ...queued])

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      const u = queued[i]!
      if (cancelled.has(u.id)) continue
      const handle = api.uploadFile(f, currentId, loaded => {
        setUploads(prev => prev.map(p => (p.id === u.id ? { ...p, loaded } : p)))
      })
      setUploads(prev => prev.map(p => (p.id === u.id ? { ...p, abort: handle.abort } : p)))
      try {
        await handle.promise
        setUploads(prev => prev.map(p => (p.id === u.id ? { ...p, loaded: f.size, status: "done" } : p)))
      } catch (e: any) {
        setUploads(prev =>
          prev.map(p => (p.id === u.id ? { ...p, status: "error", error: e?.message ?? "Failed" } : p)),
        )
      }
    }

    if (uploadFolder.current === currentId) await load()
  }

  const onDrop: React.DragEventHandler = e => {
    e.preventDefault()
    setDragOver(false)
    if (canEdit && e.dataTransfer.files.length) upload(e.dataTransfer.files)
  }

  const [captureNotice, setCaptureNotice] = useState<string | null>(null)
  const captureScreenshot = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCaptureNotice("Screen capture isn't supported in this browser.")
      return
    }
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" } as any,
        audio: false,
      })
      const blob = await captureFrame(stream)
      const folderId = await ensureScreenshotsFolder()
      const stamp = stampForFilename(new Date())
      const filename = `Screenshot ${stamp}.png`
      const file = new File([blob], filename, { type: "image/png" })
      const handle = api.uploadFile(file, folderId)
      const res = (await handle.promise) as { id?: number; error?: string } | Array<{ id: number }>
      const fileId = Array.isArray(res) ? res[0]?.id : res?.id
      if (!fileId) throw new Error("Upload failed")
      const share = (await api.createShare(fileId, { expiresIn: 30 * 86400 })) as { token?: string; error?: string }
      if (!share.token) throw new Error(share.error ?? "Share failed")
      const url = `${window.location.origin}/s/${share.token}`
      try {
        await navigator.clipboard.writeText(url)
        setCaptureNotice(`Link copied: ${url}`)
      } catch {
        setCaptureNotice(`Screenshot uploaded. Copy this link: ${url}`)
      }
      await load()
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (!/cancel|abort|denied/i.test(msg)) setCaptureNotice(`Screenshot failed: ${msg}`)
    } finally {
      stream?.getTracks().forEach(t => {
        t.stop()
      })
    }
  }

  const createFolder = async () => {
    if (!newFolderName.trim() || !canEdit || busy) return
    setBusy(true)
    setOperationError("")
    try {
      const res = await api.createFolder(newFolderName.trim(), currentId)
      if (res.error) return setOperationError(res.error)
      setNewFolderName("")
      setCreatingFolder(false)
      await load()
    } catch {
      setOperationError("Could not create the folder. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const del = async (kind: "folder" | "file", id: number) => {
    if (!canEdit || !confirm(`Move this ${kind} to Trash? You can restore it later.`)) return
    setOperationError("")
    try {
      const res = kind === "folder" ? await api.deleteFolder(id) : await api.deleteFile(id)
      if (res.error) return setOperationError(res.error)
      await load()
    } catch {
      setOperationError("Could not move the item to Trash. Check your connection and try again.")
    }
  }

  const rename = async () => {
    if (!renaming?.name.trim() || !canEdit || busy) return
    setBusy(true)
    setOperationError("")
    try {
      const res =
        renaming.kind === "folder"
          ? await api.renameFolder(renaming.id, renaming.name.trim())
          : await api.renameFile(renaming.id, renaming.name.trim())
      if (res.error) return setOperationError(res.error)
      setRenaming(null)
      await load()
    } catch {
      setOperationError("Could not rename the item. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const ownerSlug = !currentSpace && currentOwner && me && currentOwner.id !== me.id ? currentOwner.username : undefined

  const pathCrumbs = (
    <div className="crumbs">
      {currentSpace ? (
        <button type="button" className="crumb" onClick={() => navigate(`/app/spaces/${currentSpace.id}`)}>
          {currentSpace.name}
        </button>
      ) : currentRole === "owner" ? (
        <button type="button" className="crumb" onClick={() => navigate("/")}>
          My files
        </button>
      ) : (
        currentOwner && (
          <button type="button" className="crumb" onClick={() => navigate("/app/shared")}>
            Shared with me
          </button>
        )
      )}
      {!currentSpace && currentOwner && currentRole !== "owner" && (
        <>
          <span className="sep">
            <ChevronRight size={14} />
          </span>
          <span style={{ color: "var(--muted)" }}>@{currentOwner.username}</span>
        </>
      )}
      {crumbs.map((c, i) => (
        <React.Fragment key={c.id}>
          <span className="sep">
            <ChevronRight size={14} />
          </span>
          {i === crumbs.length - 1 ? (
            <span className="current">{c.name}</span>
          ) : (
            <button type="button" className="crumb" onClick={() => navigate(folderHref(c.id, ownerSlug))}>
              {c.name}
            </button>
          )}
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <div className="main">
      <div className="toolbar file-toolbar">
        <button
          type="button"
          className="search-launcher"
          onClick={() => {
            setPaletteOpen(true)
            setPaletteQuery("")
          }}
        >
          <Search size={16} />
          <span>Search files, folders, and contents</span>
          <kbd>{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
        <div className="toolbar-actions">
          {canEdit && currentId != null && currentRole === "owner" && (
            <button
              type="button"
              onClick={() => setShowFolderSettings(true)}
              aria-label="Folder settings"
              title="Folder settings"
            >
              <SettingsIcon size={14} />
            </button>
          )}
          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => {
                  setOperationError("")
                  setCreatingFolder(true)
                }}
              >
                <FolderPlus size={14} /> <span>New folder</span>
              </button>
              <button
                type="button"
                className="capture-button"
                onClick={captureScreenshot}
                title="Capture screenshot"
                aria-label="Capture screenshot"
              >
                <Camera size={14} /> <span>Capture</span>
              </button>
              <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
                <UploadIcon size={14} /> <span>Upload files</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={e => {
                  if (e.target.files) upload(e.target.files)
                  e.target.value = ""
                }}
              />
            </>
          )}
        </div>
      </div>
      {captureNotice && (
        <div className="capture-notice">
          <span>{captureNotice}</span>
          <button type="button" onClick={() => setCaptureNotice(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <div
        className="content"
        onDragOver={e => {
          e.preventDefault()
          if (canEdit) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="path-bar">
          {pathCrumbs}
          <div className="view-switch" role="group" aria-label="File view">
            {(
              [
                { value: "grid", label: "Grid", icon: LayoutGrid },
                { value: "list", label: "List", icon: List },
                { value: "gallery", label: "Gallery", icon: FileImage },
              ] as const
            ).map(option => (
              <button
                type="button"
                key={option.value}
                aria-pressed={view === option.value}
                onClick={() => {
                  setPreferredView(option.value)
                  localStorage.setItem("stohr_file_view", option.value)
                }}
              >
                <option.icon size={15} /> {option.label}
              </button>
            ))}
          </div>
        </div>
        {operationError && !creatingFolder && !renaming && (
          <div className="msg err" role="alert">
            {operationError}
          </div>
        )}
        {loading ? (
          <div className="empty" role="status">
            Loading files…
          </div>
        ) : loadError ? (
          <div className="empty">
            <div className="msg err" role="alert">
              {loadError}
            </div>
            <button type="button" onClick={load}>
              Try again
            </button>
          </div>
        ) : (
          <>
            {canEdit ? (
              <div className={`dropzone${dragOver ? " over" : ""}`}>
                Drop files here or use Upload files.
                <span className="dropzone-help">Uploading the same filename here creates a new version.</span>
              </div>
            ) : (
              <div className="permission-notice">You have view-only access. You can preview and download files.</div>
            )}
            {folders.length === 0 && files.length === 0 && (
              <div className="empty">
                <div className="big">
                  <Inbox size={48} strokeWidth={1.25} />
                </div>
                <div>{currentId == null ? "No files yet" : "This folder is empty"}</div>
                <p>
                  {canEdit
                    ? "Upload your first files or create a folder to organize your work."
                    : "Files added to this folder will appear here."}
                </p>
                {canEdit && (
                  <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
                    <UploadIcon size={14} /> Upload files
                  </button>
                )}
              </div>
            )}

            {selected.size > 0 && (
              <div className="selbar">
                <div>{selected.size} selected</div>
                <div className="selbar-actions">
                  <button type="button" onClick={selectAll}>
                    {selected.size === orderedKeys.length ? "Deselect all" : "Select all"}
                  </button>
                  {canEdit && (
                    <button type="button" disabled={busy} onClick={() => setMovingOpen(true)}>
                      Move to…
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className="danger" disabled={busy} onClick={bulkDelete}>
                      <Trash2 size={14} /> <span>Move to Trash</span>
                    </button>
                  )}
                  <button type="button" onClick={clearSelection} aria-label="Clear">
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}

            <div className={view === "list" ? "file-list" : "grid"}>
              {folders.map(f => {
                const key = `fo-${f.id}`
                const sel = selected.has(key)
                return (
                  <article key={key} className={`card${sel ? " selected" : ""}`}>
                    <button
                      type="button"
                      className="card-open"
                      aria-label={`Open folder ${f.name}`}
                      onClick={e => {
                        if (selected.size > 0) return toggleSelect(key, e)
                        const ownerSlug =
                          currentOwner && me && currentOwner.id !== me.id ? currentOwner.username : undefined
                        navigate(folderHref(f.id, ownerSlug))
                      }}
                    />
                    <button
                      type="button"
                      className={`check${sel ? " on" : ""}`}
                      aria-label={`Select ${f.name}`}
                      aria-pressed={sel}
                      onClick={e => toggleSelect(key, e)}
                    >
                      <span className="check-box" />
                    </button>
                    <CardKebab
                      ariaLabel="Folder actions"
                      items={[
                        {
                          label: "Share",
                          onClick: () => setSharing({ kind: "folder", id: f.id, name: f.name }),
                          hidden: currentRole !== "owner",
                        },
                        {
                          label: "Rename",
                          onClick: () => setRenaming({ kind: "folder", id: f.id, name: f.name }),
                          hidden: !canEdit,
                        },
                        { label: "Move to Trash", onClick: () => del("folder", f.id), danger: true, hidden: !canEdit },
                      ]}
                    />
                    <div className="icon">
                      {f.kind === "screenshots" ? (
                        <Camera size={32} strokeWidth={1.5} />
                      ) : (
                        <FolderIcon size={32} strokeWidth={1.5} />
                      )}
                    </div>
                    <div className="name" title={f.name}>
                      {f.name}
                    </div>
                    {view === "list" && <div className="file-date">{new Date(f.created_at).toLocaleDateString()}</div>}
                    <div className="meta">
                      {f.kind === "photos" ? "Photos" : f.kind === "screenshots" ? "Screenshots" : "Folder"}
                    </div>
                  </article>
                )
              })}
              {files
                .filter(f => view !== "gallery" || (!f.mime.startsWith("image/") && !f.mime.startsWith("video/")))
                .map(f => {
                  const key = `fi-${f.id}`
                  const sel = selected.has(key)
                  return (
                    <article key={key} className={`card${sel ? " selected" : ""}`}>
                      <button
                        type="button"
                        className="card-open"
                        aria-label={`Preview ${f.name}`}
                        onClick={e => (selected.size > 0 ? toggleSelect(key, e) : setPreviewing(f))}
                      />
                      <button
                        type="button"
                        className={`check${sel ? " on" : ""}`}
                        aria-label={`Select ${f.name}`}
                        aria-pressed={sel}
                        onClick={e => toggleSelect(key, e)}
                      >
                        <span className="check-box" />
                      </button>
                      <CardKebab
                        ariaLabel="File actions"
                        items={[
                          { label: "Download", onClick: () => downloadFile(f) },
                          {
                            label: "Share",
                            onClick: () => setSharing({ kind: "file", id: f.id, name: f.name }),
                            hidden: currentRole !== "owner",
                          },
                          { label: "Versions", onClick: () => setViewingVersions(f), hidden: f.version <= 1 },
                          {
                            label: "Rename",
                            onClick: () => setRenaming({ kind: "file", id: f.id, name: f.name }),
                            hidden: !canEdit,
                          },
                          { label: "Move to Trash", onClick: () => del("file", f.id), danger: true, hidden: !canEdit },
                        ]}
                      />
                      <FileThumb file={f} />
                      <div className="name" title={f.name}>
                        {f.name}
                      </div>
                      {view === "list" && (
                        <div className="file-date">{new Date(f.created_at).toLocaleDateString()}</div>
                      )}
                      <div className="meta">
                        {formatBytes(f.size)}
                        {f.version > 1 && <span className="badge">v{f.version}</span>}
                      </div>
                    </article>
                  )
                })}
            </div>

            {view === "gallery" && mediaFiles.length > 0 && (
              <section className="gallery-section" aria-label="Images and videos">
                <h3 className="page-title">Images and videos</h3>
                <PhotosGallery
                  files={mediaFiles}
                  thumbUrl={(id, version) => `/api/files/${id}/thumb?v=${version}`}
                  fullUrl={id => `${api.downloadUrl(id)}?inline=1`}
                  authHeader
                />
              </section>
            )}

            {view === "gallery" && mediaFiles.length === 0 && (folders.length > 0 || files.length > 0) && (
              <p className="field-help">No images or videos in this folder. Your other files are shown above.</p>
            )}

            {(moreFiles || moreFolders) && (
              <div className="load-more">
                <button type="button" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {creatingFolder && (
        <Modal title="Create folder" onClose={() => setCreatingFolder(false)}>
          {operationError && (
            <div className="msg err" role="alert">
              {operationError}
            </div>
          )}
          <input
            autoFocus
            aria-label="Folder name"
            placeholder="Folder name"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createFolder()}
          />
          <div className="actions">
            <button type="button" onClick={() => setCreatingFolder(false)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy || !newFolderName.trim()} onClick={createFolder}>
              {busy ? "Creating…" : "Create folder"}
            </button>
          </div>
        </Modal>
      )}

      {sharing && (
        <SharingModal target={sharing} ownerUsername={me?.username ?? null} onClose={() => setSharing(null)} />
      )}

      {renaming && (
        <Modal title={`Rename ${renaming.kind}`} onClose={() => setRenaming(null)}>
          {operationError && (
            <div className="msg err" role="alert">
              {operationError}
            </div>
          )}
          <input
            autoFocus
            aria-label="Name"
            value={renaming.name}
            onChange={e => setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={e => e.key === "Enter" && rename()}
          />
          <div className="actions">
            <button type="button" onClick={() => setRenaming(null)}>
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy || !renaming.name.trim()} onClick={rename}>
              {busy ? "Saving…" : "Rename"}
            </button>
          </div>
        </Modal>
      )}

      {previewing && <PreviewModal file={previewing} onClose={() => setPreviewing(null)} />}

      {showFolderSettings && currentId != null && (
        <FolderSettingsModal
          folderId={currentId}
          folderName={crumbs[crumbs.length - 1]?.name ?? ""}
          ownerUsername={currentOwner?.username ?? me?.username ?? ""}
          initialKind={currentKind}
          initialIsPublic={currentIsPublic}
          onClose={() => setShowFolderSettings(false)}
          onSaved={async () => {
            setShowFolderSettings(false)
            await load()
          }}
        />
      )}

      {viewingVersions && (
        <VersionsModal
          file={viewingVersions}
          canEdit={canEdit}
          onClose={() => setViewingVersions(null)}
          onRestored={async () => {
            setViewingVersions(null)
            await load()
          }}
        />
      )}

      {movingOpen && (
        <FolderPicker
          space={currentSpace}
          rootFolder={!currentSpace && currentRole !== "owner" ? crumbs[0] : undefined}
          allowRoot={!currentSpace || (currentRole === "owner" && ![...selected].some(key => key.startsWith("fi-")))}
          excludeIds={[...selected].filter(k => k.startsWith("fo-")).map(k => Number(k.slice(3)))}
          onClose={() => setMovingOpen(false)}
          onPick={bulkMove}
        />
      )}

      {paletteOpen &&
        (() => {
          const combined: Array<PaletteFolder | FileItem | api.ContentHit> = [
            ...paletteResults.folders,
            ...paletteResults.files,
            ...paletteResults.content,
          ]
          const closePalette = () => {
            setPaletteOpen(false)
            setPaletteQuery("")
            setPaletteResults({ files: [], folders: [], content: [] })
            setPaletteActive(0)
          }
          const activate = (idx: number) => {
            const item = combined[idx]
            if (!item) return
            closePalette()
            if ("mime" in item) {
              setPreviewing(item as FileItem)
            } else {
              navigate(folderHref(item.id))
            }
          }
          const onKeyDown = (e: React.KeyboardEvent) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setPaletteActive(prev => Math.max(0, Math.min(prev + 1, combined.length - 1)))
            } else if (e.key === "ArrowUp") {
              e.preventDefault()
              setPaletteActive(prev => Math.max(prev - 1, 0))
            } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
              e.preventDefault()
              activate(paletteActive)
            } else if (e.key === "Escape") {
              closePalette()
            }
          }
          return (
            <Modal title="Search" onClose={closePalette} size="wide">
              <div onKeyDown={onKeyDown}>
                <input
                  autoFocus
                  className="search"
                  style={{ width: "100%", marginBottom: 8, boxSizing: "border-box" }}
                  aria-label="Search files, folders, and contents"
                  placeholder="Search files, folders, and contents…"
                  value={paletteQuery}
                  onChange={e => {
                    setPaletteQuery(e.target.value)
                    setPaletteActive(0)
                  }}
                />
                {!paletteQuery && (
                  <p className="search-help">Find files by name or contents, or search for a folder.</p>
                )}
                {paletteLoading && <p role="status">Searching…</p>}
                {paletteError && (
                  <div className="msg err" role="alert">
                    {paletteError}{" "}
                    <button type="button" onClick={() => setPaletteRetry(prev => prev + 1)}>
                      Try again
                    </button>
                  </div>
                )}
                {paletteQuery.trim().length > 0 &&
                  !paletteLoading &&
                  !paletteError &&
                  paletteResults.folders.length === 0 &&
                  paletteResults.files.length === 0 &&
                  paletteResults.content.length === 0 && (
                    <div style={{ padding: "12px 0", color: "var(--muted)", textAlign: "center", fontSize: 14 }}>
                      No matches. Try a different name or a shorter search.
                    </div>
                  )}
                {paletteResults.folders.length > 0 && (
                  <>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--muted)",
                        padding: "6px 0 2px",
                      }}
                    >
                      Folders
                    </div>
                    {paletteResults.folders.map((f, i) => (
                      <button
                        type="button"
                        key={`pf-${f.id}`}
                        className={`picker-row${paletteActive === i ? " active" : ""}`}
                        style={{
                          cursor: "pointer",
                          borderRadius: 6,
                          padding: "6px 8px",
                          background: paletteActive === i ? "var(--hover)" : undefined,
                        }}
                        onClick={() => activate(i)}
                        onMouseEnter={() => setPaletteActive(i)}
                      >
                        <FolderIcon size={16} strokeWidth={1.5} />
                        <span style={{ marginLeft: 8 }}>{f.name}</span>
                      </button>
                    ))}
                  </>
                )}
                {paletteResults.files.length > 0 && (
                  <>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--muted)",
                        padding: "6px 0 2px",
                      }}
                    >
                      Files
                    </div>
                    {paletteResults.files.map((f, i) => {
                      const globalIdx = paletteResults.folders.length + i
                      return (
                        <button
                          type="button"
                          key={`pfi-${f.id}`}
                          className={`picker-row${paletteActive === globalIdx ? " active" : ""}`}
                          style={{
                            cursor: "pointer",
                            borderRadius: 6,
                            padding: "6px 8px",
                            background: paletteActive === globalIdx ? "var(--hover)" : undefined,
                          }}
                          onClick={() => activate(globalIdx)}
                          onMouseEnter={() => setPaletteActive(globalIdx)}
                        >
                          <MimeIcon mime={f.mime} size={16} />
                          <span style={{ marginLeft: 8 }}>{f.name}</span>
                        </button>
                      )
                    })}
                  </>
                )}
                {paletteResults.content.length > 0 && (
                  <>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "var(--muted)",
                        padding: "6px 0 2px",
                      }}
                    >
                      Inside files
                    </div>
                    {paletteResults.content.map((f, i) => {
                      const globalIdx = paletteResults.folders.length + paletteResults.files.length + i
                      return (
                        <button
                          type="button"
                          key={`pco-${f.id}`}
                          className={`picker-row${paletteActive === globalIdx ? " active" : ""}`}
                          style={{
                            cursor: "pointer",
                            borderRadius: 6,
                            padding: "6px 8px",
                            background: paletteActive === globalIdx ? "var(--hover)" : undefined,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                          }}
                          onClick={() => activate(globalIdx)}
                          onMouseEnter={() => setPaletteActive(globalIdx)}
                        >
                          <div style={{ display: "flex", alignItems: "center" }}>
                            <MimeIcon mime={f.mime} size={16} />
                            <span style={{ marginLeft: 8 }}>{f.name}</span>
                          </div>
                          {f.snippet && (
                            <div
                              style={{
                                marginLeft: 24,
                                fontSize: 12,
                                color: "var(--muted)",
                                lineHeight: 1.3,
                                marginTop: 2,
                              }}
                              // biome-ignore lint/security/noDangerouslySetInnerHtml: the server HTML-escapes the whole snippet and re-introduces only <mark> around hits (renderSnippet in src/search/content/routes.ts), so nothing from file contents can reach here as markup.
                              dangerouslySetInnerHTML={{ __html: f.snippet }}
                            />
                          )}
                        </button>
                      )
                    })}
                  </>
                )}
              </div>
            </Modal>
          )
        })()}

      <UploadPanel
        uploads={uploads}
        onCancel={id => {
          setUploads(prev => {
            const target = prev.find(p => p.id === id)
            if (target?.abort) target.abort()
            return prev.filter(p => p.id !== id)
          })
        }}
        onDismiss={id => setUploads(prev => prev.filter(p => p.id !== id))}
        onClear={() => {
          setUploads(prev => {
            for (const p of prev) if (p.status === "uploading") p.abort?.()
            return []
          })
        }}
      />
    </div>
  )
}

const FolderPicker: React.FC<{
  space?: { id: number; name: string } | null
  rootFolder?: Crumb
  allowRoot?: boolean
  excludeIds: number[]
  onClose: () => void
  onPick: (folderId: number | null) => void | Promise<void>
}> = ({ space, rootFolder, allowRoot = true, excludeIds, onClose, onPick }) => {
  const [currentId, setCurrentId] = useState<number | null>(rootFolder?.id ?? null)
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const [folders, setFolders] = useState<Array<{ id: number; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [moving, setMoving] = useState(false)

  const load = async () => {
    setLoading(true)
    setError("")
    try {
      const list =
        space && currentId == null ? (await api.listSpaceFolders(space.id)).folders : await api.listFolders(currentId)
      if (!Array.isArray(list)) throw new Error("Could not load destination folders. Try again.")
      const detail = currentId == null ? null : await api.getFolder(currentId)
      if (detail?.error) throw new Error(detail.error)
      setFolders(list)
      const trail = detail?.trail ?? []
      setCrumbs(rootFolder ? trail.filter((crumb: Crumb) => crumb.id !== rootFolder.id) : trail)
    } catch (e: any) {
      setError(e?.message ?? "Could not load destination folders. Try again.")
    } finally {
      setLoading(false)
    }
  }

  const move = async () => {
    if (moving) return
    setMoving(true)
    try {
      await onPick(currentId)
    } finally {
      setMoving(false)
    }
  }

  useEffect(() => {
    load()
  }, [currentId])

  return (
    <Modal title="Move to folder" onClose={onClose}>
      <div className="picker-crumbs">
        <button type="button" className="crumb" onClick={() => setCurrentId(rootFolder?.id ?? null)}>
          {space?.name ?? rootFolder?.name ?? "My files"}
        </button>
        {crumbs.map((c, i) => (
          <React.Fragment key={c.id}>
            <span className="sep">
              <ChevronRight size={14} />
            </span>
            {i === crumbs.length - 1 ? (
              <span className="current">{c.name}</span>
            ) : (
              <button type="button" className="crumb" onClick={() => setCurrentId(c.id)}>
                {c.name}
              </button>
            )}
          </React.Fragment>
        ))}
      </div>
      {error && (
        <div className="msg err" role="alert">
          {error}{" "}
          <button type="button" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {space && currentId == null && !allowRoot && (
        <p className="field-help">Choose a folder in this space. Files stay within their workspace.</p>
      )}
      <div className="picker-list">
        {loading && (
          <div className="picker-empty" role="status">
            Loading folders…
          </div>
        )}
        {!loading && !error && folders.length === 0 && <div className="picker-empty">No subfolders here</div>}
        {!loading &&
          !error &&
          folders.map(f => {
            const disabled = excludeIds.includes(f.id)
            return (
              <button
                type="button"
                key={f.id}
                className={`picker-row${disabled ? " disabled" : ""}`}
                disabled={disabled}
                onClick={() => setCurrentId(f.id)}
              >
                <FolderIcon size={18} strokeWidth={1.5} />
                <span>{f.name}</span>
              </button>
            )
          })}
      </div>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={loading || !!error || moving || (!allowRoot && currentId == null)}
          onClick={move}
        >
          {moving ? "Moving…" : "Move here"}
          {crumbs.length > 0 ? `: ${crumbs[crumbs.length - 1]?.name}` : ""}
        </button>
      </div>
    </Modal>
  )
}

const TEXT_MIMES = [
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
]

const kindFor = (mime: string): "image" | "video" | "audio" | "pdf" | "text" | "other" => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("text/") || TEXT_MIMES.some(t => mime.startsWith(t))) return "text"
  return "other"
}

const PreviewModal: React.FC<{ file: FileItem; onClose: () => void }> = ({ file, onClose }) => {
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const kind = kindFor(file.mime)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let aborted = false
    ;(async () => {
      try {
        if (kind === "other") return
        const res = await fetch(api.downloadUrl(file.id), {
          headers: { authorization: `Bearer ${api.getToken()}` },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (aborted) return
        if (kind === "text") {
          const t = await blob.text()
          if (!aborted) setText(t)
        } else {
          objectUrl = URL.createObjectURL(blob)
          if (!aborted) setUrl(objectUrl)
        }
      } catch (e: any) {
        if (!aborted) setError(e.message ?? "Failed to load preview")
      }
    })()
    return () => {
      aborted = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.id])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      dialog?.close()
      previous?.focus()
    }
  }, [])

  const loading = !error && kind !== "other" && !url && text === null

  return (
    <dialog
      ref={dialogRef}
      className="preview-backdrop"
      aria-label={`Preview ${file.name}`}
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="preview" onClick={e => e.stopPropagation()}>
        <div className="preview-head">
          <div className="preview-title">
            <span className="preview-icon">
              <MimeIcon mime={file.mime} size={28} />
            </span>
            <div>
              <div className="preview-name">{file.name}</div>
              <div className="preview-meta">
                {formatBytes(file.size)} • {file.mime}
              </div>
            </div>
          </div>
          <div className="preview-actions">
            <button type="button" onClick={() => setCommentsOpen(v => !v)} title="Comments">
              <MessageSquare size={16} /> {commentsOpen ? "Hide comments" : "Comments"}
            </button>
            <button type="button" onClick={() => downloadFile(file)}>
              Download
            </button>
            <button type="button" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="preview-body" style={{ display: "flex" }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              justifyContent: kind === "text" ? "flex-start" : "center",
            }}
          >
            {loading && <div className="preview-empty">Loading preview...</div>}
            {error && <div className="preview-empty">Could not load preview: {error}</div>}
            {kind === "image" && url && <img src={url} alt={file.name} />}
            {kind === "video" && url && <video src={url} controls autoPlay />}
            {kind === "audio" && url && (
              <div className="preview-audio">
                <div className="preview-audio-icon">
                  <Music size={72} strokeWidth={1.25} />
                </div>
                <audio src={url} controls autoPlay />
              </div>
            )}
            {kind === "pdf" && url && <iframe src={url} title={file.name} />}
            {kind === "text" && text !== null && <pre className="preview-text">{text}</pre>}
            {kind === "other" && (
              <div className="preview-empty">
                <div className="preview-empty-icon">
                  <MimeIcon mime={file.mime} size={64} />
                </div>
                <div>No inline preview for this file type</div>
                <button type="button" className="primary" style={{ marginTop: 16 }} onClick={() => downloadFile(file)}>
                  Download
                </button>
              </div>
            )}
          </div>
          {commentsOpen && (
            <div className="preview-comments">
              <CommentsPanel kind="file" resourceId={file.id} />
            </div>
          )}
        </div>
      </div>
    </dialog>
  )
}

const CommentsPanel: React.FC<{ kind: "file" | "folder"; resourceId: number }> = ({ kind, resourceId }) => {
  const [items, setItems] = useState<api.CommentRow[]>([])
  const [body, setBody] = useState("")
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [err, setErr] = useState("")

  const refresh = async () => {
    setLoading(true)
    try {
      const data = kind === "file" ? await api.listFileComments(resourceId) : await api.listFolderComments(resourceId)
      setItems(Array.isArray(data.comments) ? data.comments : [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    refresh()
  }, [kind, resourceId])

  const post = async () => {
    const trimmed = body.trim()
    if (!trimmed) return
    setPosting(true)
    setErr("")
    try {
      const res =
        kind === "file"
          ? await api.createFileComment(resourceId, trimmed)
          : await api.createFolderComment(resourceId, trimmed)
      if ((res as any).error) {
        setErr((res as any).error)
        return
      }
      setBody("")
      await refresh()
    } finally {
      setPosting(false)
    }
  }

  const remove = async (id: number) => {
    if (!confirm("Delete this comment?")) return
    await api.deleteComment(id)
    await refresh()
  }

  const me = api.getUser()
  return (
    <div>
      <h4 style={{ marginTop: 0 }}>Comments</h4>
      {loading ? (
        <div style={{ color: "var(--muted)" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>No comments yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 12 }}>
          {items.map(c => (
            <div key={c.id} style={{ padding: 8, borderRadius: 6, background: "var(--hover)", fontSize: 13 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <strong>{c.user.name ?? c.user.username ?? "Someone"}</strong>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{new Date(c.created_at).toLocaleString()}</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>
                {c.deleted_at ? <em style={{ color: "var(--muted)" }}>(deleted)</em> : c.body}
              </div>
              {!c.deleted_at && me?.id === c.user.id && (
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--muted)",
                    fontSize: 11,
                    padding: 0,
                    marginTop: 4,
                    cursor: "pointer",
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <textarea
        aria-label="Add a comment…"
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Add a comment…"
        rows={3}
        style={{ width: "100%", boxSizing: "border-box", marginBottom: 8 }}
      />
      {err && <div className="msg err">{err}</div>}
      <button type="button" className="primary" onClick={post} disabled={posting || !body.trim()}>
        {posting ? "Posting…" : "Post"}
      </button>
    </div>
  )
}

const VersionsModal: React.FC<{ file: FileItem; onClose: () => void; onRestored: () => void; canEdit: boolean }> = ({
  file,
  onClose,
  onRestored,
  canEdit,
}) => {
  const [versions, setVersions] = useState<FileVersion[]>([])
  const [err, setErr] = useState("")

  const load = async () => {
    const data = await api.listVersions(file.id)
    if (Array.isArray(data)) setVersions(data)
    else if (data && Array.isArray((data as { items?: FileVersion[] }).items))
      setVersions((data as { items: FileVersion[] }).items)
    else setErr((data as { error?: string }).error ?? "Failed to load versions")
  }
  useEffect(() => {
    load()
  }, [file.id])

  const downloadVersion = async (v: FileVersion) => {
    const res = await fetch(api.versionDownloadUrl(file.id, v.version), {
      headers: { authorization: `Bearer ${api.getToken()}` },
    })
    if (!res.ok) return alert("Download failed")
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${file.name}.v${v.version}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const restore = async (v: FileVersion) => {
    if (!confirm(`Restore version ${v.version}? The current version will be saved as history.`)) return
    const res = await api.restoreVersion(file.id, v.version)
    if (res.error) return alert(res.error)
    onRestored()
  }

  const remove = async (v: FileVersion) => {
    if (!confirm(`Delete version ${v.version}? This cannot be undone.`)) return
    const res = await api.deleteVersion(file.id, v.version)
    if (res.error) return alert(res.error)
    await load()
  }

  return (
    <Modal title={`Version history — ${file.name}`} onClose={onClose}>
      {err && <div className="msg err">{err}</div>}
      {versions.length === 0 && !err && <div>Loading...</div>}
      <div className="versions">
        {versions.map(v => (
          <div key={v.version} className={`version-row${v.is_current ? " current" : ""}`}>
            <div>
              <div className="version-title">
                v{v.version} {v.is_current && <span className="chip">Current</span>}
              </div>
              <div className="version-meta">
                {formatBytes(v.size)} • {new Date(v.uploaded_at).toLocaleString()}
              </div>
            </div>
            <div className="version-actions">
              <button type="button" onClick={() => downloadVersion(v)}>
                Download
              </button>
              {canEdit && !v.is_current && (
                <button type="button" onClick={() => restore(v)}>
                  Restore
                </button>
              )}
              {canEdit && !v.is_current && (
                <button type="button" className="danger" onClick={() => remove(v)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="actions">
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

const TrashView: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [data, setData] = useState<{ folders: TrashedFolder[]; files: TrashedFile[] }>({ folders: [], files: [] })

  const load = async () => {
    setLoading(true)
    setError("")
    try {
      const res = await api.listTrash()
      if (res?.error) throw new Error(res.error)
      if (res && "folders" in res) setData(res)
      else setData({ folders: [], files: [] })
    } catch (e: any) {
      setError(e?.message ?? "Could not load this page. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const restoreF = async (kind: "file" | "folder", id: number) => {
    const res = kind === "file" ? await api.restoreFile(id) : await api.restoreFolder(id)
    if (res.error) return alert(res.error)
    await load()
  }

  const purge = async (kind: "file" | "folder", id: number) => {
    if (!confirm(`Permanently delete this ${kind}? This cannot be undone.`)) return
    const res = kind === "file" ? await api.purgeFile(id) : await api.purgeFolder(id)
    if (res.error) return alert(res.error)
    await load()
  }

  const emptyAll = async () => {
    if (!confirm("Permanently delete everything in Trash? This cannot be undone.")) return
    const res = await api.emptyTrash()
    if (res.error) return alert(res.error)
    await load()
  }

  const isEmpty = data.folders.length === 0 && data.files.length === 0

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs">
          <span className="current">Trash</span>
        </div>
        {!loading && !error && !isEmpty && (
          <button type="button" className="danger" onClick={emptyAll}>
            Empty trash
          </button>
        )}
      </div>
      <div className="content">
        {loading && (
          <div className="empty" role="status">
            Loading…
          </div>
        )}
        {error && (
          <div className="msg err" role="alert">
            {error}{" "}
            <button type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {!loading && !error && isEmpty && (
          <div className="empty">
            <div className="big">
              <Trash2 size={64} strokeWidth={1.25} />
            </div>
            <div>Trash is empty</div>
          </div>
        )}
        {!loading && !error && !isEmpty && (
          <div className="grid">
            {data.folders.map(f => (
              <div key={`tf-${f.id}`} className="card">
                <div className="icon">
                  <FolderIcon size={32} strokeWidth={1.5} />
                </div>
                <div className="name">{f.name}</div>
                <div className="meta">Deleted {new Date(f.deleted_at).toLocaleDateString()}</div>
                <div className="row">
                  <button type="button" onClick={() => restoreF("folder", f.id)}>
                    Restore
                  </button>
                  <button type="button" className="danger" onClick={() => purge("folder", f.id)}>
                    Delete forever
                  </button>
                </div>
              </div>
            ))}
            {data.files.map(f => (
              <div key={`tfi-${f.id}`} className="card">
                <div className="icon">
                  <MimeIcon mime={f.mime} size={32} />
                </div>
                <div className="name">{f.name}</div>
                <div className="meta">
                  {formatBytes(f.size)} • Deleted {new Date(f.deleted_at).toLocaleDateString()}
                </div>
                <div className="row">
                  <button type="button" onClick={() => restoreF("file", f.id)}>
                    Restore
                  </button>
                  <button type="button" className="danger" onClick={() => purge("file", f.id)}>
                    Delete forever
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const downloadFile = async (f: FileItem) => {
  const res = await fetch(api.downloadUrl(f.id), {
    headers: { authorization: `Bearer ${api.getToken()}` },
  })
  if (!res.ok) return alert("Download failed")
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = f.name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

type CollabRow = {
  id: number
  user_id: number | null
  email: string | null
  role: "viewer" | "editor"
  user: { id: number; username: string; name: string; email?: string } | null
  invite_token?: string
}

const CollaboratorsPanel: React.FC<{ kind: "file" | "folder"; id: number }> = ({ kind, id }) => {
  const [rows, setRows] = useState<CollabRow[]>([])
  const [identity, setIdentity] = useState("")
  const [role, setRole] = useState<"viewer" | "editor">("viewer")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [pendingInvite, setPendingInvite] = useState<{ token: string; email: string } | null>(null)

  const load = async () => {
    const list = kind === "folder" ? await api.listFolderCollabs(id) : await api.listFileCollabs(id)
    setRows(Array.isArray(list) ? list : [])
  }
  useEffect(() => {
    load()
  }, [kind, id])

  const add = async () => {
    if (!identity.trim() || busy) return
    setBusy(true)
    setError("")
    setPendingInvite(null)
    try {
      const fn = kind === "folder" ? api.addFolderCollab : api.addFileCollab
      const res = await fn(id, identity.trim(), role)
      setBusy(false)
      if (res.error) return setError(res.error)
      if (res.invite_token && res.email) {
        setPendingInvite({ token: res.invite_token, email: res.email })
      }
      setIdentity("")
      await load()
    } catch {
      setError("Could not add the collaborator. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (collabId: number) => {
    if (!confirm("Remove this collaborator?")) return
    const fn = kind === "folder" ? api.removeFolderCollab : api.removeFileCollab
    const res = await fn(id, collabId)
    if (res.error) return alert(res.error)
    await load()
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>
        Share with specific people by username or email. New email addresses receive an invite link you can copy.
      </div>
      <div className="inline-form">
        <input
          aria-label="Collaborator username or email"
          placeholder="Username or email"
          value={identity}
          onChange={e => setIdentity(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ flex: 1 }}
        />
        <select
          aria-label="Collaborator access"
          value={role}
          onChange={e => setRole(e.target.value as "viewer" | "editor")}
          style={{
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--panel)",
            color: "var(--text)",
          }}
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button type="button" className="primary" onClick={add} disabled={busy || !identity.trim()}>
          <UserPlus size={14} /> <span>Add</span>
        </button>
      </div>
      <p className="field-help">
        Viewers can preview, download, and comment. Editors can also upload, rename, and delete.
      </p>
      {error && (
        <div className="msg err" role="alert" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
      {pendingInvite && (
        <div className="msg ok" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Invite link for {pendingInvite.email}:</div>
          <div className="share-link" style={{ margin: "4px 0" }}>
            {window.location.origin}/signup?invite={pendingInvite.token}
          </div>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard.writeText(`${window.location.origin}/signup?invite=${pendingInvite.token}`)
            }
          >
            Copy invite link
          </button>
        </div>
      )}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No collaborators yet</div>}
        {rows.map(r => (
          <div
            key={r.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {r.user ? `@${r.user.username}` : r.email}
                {r.user && <span style={{ color: "var(--muted)", marginLeft: 6, fontWeight: 400 }}>{r.user.name}</span>}
                {!r.user && (
                  <span className="badge" style={{ marginLeft: 8 }}>
                    pending
                  </span>
                )}
              </div>
            </div>
            <span style={{ fontSize: 12, color: "var(--muted)", textTransform: "capitalize" }}>{r.role}</span>
            <button
              type="button"
              className="danger"
              onClick={() => remove(r.id)}
              aria-label={`Remove ${r.user?.username ?? r.email}`}
              style={{ padding: "4px 8px", fontSize: 12 }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const SharingModal: React.FC<{
  target: { kind: "file" | "folder"; id: number; name: string }
  ownerUsername: string | null
  onClose: () => void
}> = ({ target, ownerUsername, onClose }) => {
  const directLink = ownerUsername
    ? `${window.location.origin}${target.kind === "folder" ? `/app/u/${ownerUsername}/f/${target.id}` : `/app/u/${ownerUsername}/file/${target.id}`}`
    : null
  const [tab, setTab] = useState<"people" | "link">("people")
  const [publicLink, setPublicLink] = useState<{ url: string; passwordRequired: boolean; burnOnView: boolean } | null>(
    null,
  )
  const [linkExpiry, setLinkExpiry] = useState<number>(86400)
  const [linkPassword, setLinkPassword] = useState("")
  const [linkBurn, setLinkBurn] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkErr, setLinkErr] = useState("")

  const [copied, setCopied] = useState(false)
  const copy = async (url: string) => {
    setCopied(false)
    setLinkErr("")
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setLinkErr("Could not copy the link. Select it and copy it manually.")
    }
  }

  const createPublic = async () => {
    if (target.kind !== "file" || linkBusy) return
    setLinkBusy(true)
    setLinkErr("")
    try {
      const res = await api.createShare(target.id, {
        expiresIn: linkExpiry,
        password: linkPassword.trim() || undefined,
        burnOnView: linkBurn,
      })
      setLinkBusy(false)
      if (res.token) {
        setPublicLink({
          url: `${window.location.origin}/s/${res.token}`,
          passwordRequired: !!res.password_required,
          burnOnView: !!res.burn_on_view,
        })
      } else {
        setLinkErr(res.error ?? "Could not create the link. Try again.")
      }
    } catch {
      setLinkErr("Could not create the link. Check your connection and try again.")
    } finally {
      setLinkBusy(false)
    }
  }

  return (
    <Modal title={`Share "${target.name}"`} onClose={onClose}>
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginBottom: 16 }}>
        <button
          type="button"
          onClick={() => setTab("people")}
          style={{
            border: "none",
            borderRadius: 0,
            background: "transparent",
            padding: "8px 14px",
            borderBottom: `2px solid ${tab === "people" ? "var(--brand)" : "transparent"}`,
            color: tab === "people" ? "var(--brand)" : "var(--muted)",
            fontWeight: 600,
          }}
        >
          <Users size={14} /> <span>People</span>
        </button>
        {target.kind === "file" && (
          <button
            type="button"
            onClick={() => setTab("link")}
            style={{
              border: "none",
              borderRadius: 0,
              background: "transparent",
              padding: "8px 14px",
              borderBottom: `2px solid ${tab === "link" ? "var(--brand)" : "transparent"}`,
              color: tab === "link" ? "var(--brand)" : "var(--muted)",
              fontWeight: 600,
            }}
          >
            <Link2 size={14} /> <span>Public link</span>
          </button>
        )}
      </div>

      {linkErr && (
        <div className="msg err" role="alert">
          {linkErr}
        </div>
      )}
      {copied && (
        <p className="field-help" role="status">
          Link copied to clipboard.
        </p>
      )}
      {tab === "people" && (
        <>
          <CollaboratorsPanel kind={target.kind} id={target.id} />
          {directLink && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                Collaborators with access can open:
              </div>
              <div className="share-link">{directLink}</div>
              <button type="button" onClick={() => copy(directLink)} style={{ marginTop: 6 }}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          )}
        </>
      )}

      {tab === "link" &&
        target.kind === "file" &&
        (publicLink ? (
          <>
            <div style={{ marginBottom: 6 }}>Send this link to anyone:</div>
            <div className="share-link">{publicLink.url}</div>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 13,
                color: "var(--muted)",
              }}
            >
              {publicLink.passwordRequired && <span>· Recipient will need the password you set.</span>}
              {publicLink.burnOnView && <span>· Link expires after the first recipient opens it.</span>}
            </div>
            <div className="actions">
              <button type="button" onClick={() => copy(publicLink.url)}>
                {copied ? "Copied" : "Copy link"}
              </button>
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="field-help">
              Anyone with this link can open the file
              {linkPassword.trim() ? " using the password" : " without signing in"}. Share only with your intended
              recipients.
            </p>
            <label
              htmlFor="share-expiry"
              style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}
            >
              Expires in
            </label>
            <select id="share-expiry" value={linkExpiry} onChange={e => setLinkExpiry(Number(e.target.value))}>
              <option value={3600}>1 hour</option>
              <option value={86400}>1 day</option>
              <option value={604800}>7 days</option>
              <option value={2592000}>30 days</option>
            </select>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginTop: 14, marginBottom: 6 }}>
              Password (optional)
            </label>
            <input
              aria-label="Leave blank for no password"
              type="password"
              autoComplete="new-password"
              value={linkPassword}
              onChange={e => setLinkPassword(e.target.value)}
              placeholder="Leave blank for no password"
            />
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, fontSize: 13 }}>
              <input type="checkbox" checked={linkBurn} onChange={e => setLinkBurn(e.target.checked)} />
              <span>One-time link: expires after the first recipient opens it</span>
            </label>
            <div className="actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={linkBusy} onClick={createPublic}>
                {linkBusy ? "Creating…" : "Create link"}
              </button>
            </div>
          </>
        ))}
    </Modal>
  )
}

type SharedFolder = {
  id: number
  user_id: number
  parent_id: number | null
  name: string
  created_at: string
  role: "viewer" | "editor"
  owner: { id: number; username: string; name: string } | null
}
type SharedFile = FileItem & {
  user_id: number
  role: "viewer" | "editor"
  owner: { id: number; username: string; name: string } | null
}

const SharedView: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [data, setData] = useState<{ folders: SharedFolder[]; files: SharedFile[] }>({ folders: [], files: [] })
  const [previewing, setPreviewing] = useState<FileItem | null>(null)

  const load = async () => {
    setLoading(true)
    setError("")
    try {
      const res = await api.listSharedWithMe()
      if (res?.error) throw new Error(res.error)
      if (res && "folders" in res) setData(res)
      else setData({ folders: [], files: [] })
    } catch (e: any) {
      setError(e?.message ?? "Could not load this page. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const isEmpty = data.folders.length === 0 && data.files.length === 0

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs">
          <span className="current">Shared with me</span>
        </div>
      </div>
      <div className="content">
        {loading && (
          <div className="empty" role="status">
            Loading…
          </div>
        )}
        {error && (
          <div className="msg err" role="alert">
            {error}{" "}
            <button type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {!loading && !error && isEmpty && (
          <div className="empty">
            <div className="big">
              <Users size={64} strokeWidth={1.25} />
            </div>
            <div>Nothing shared with you yet</div>
            <div style={{ marginTop: 8, fontSize: 13 }}>
              When someone adds you as a collaborator, the folder or file will appear here.
            </div>
          </div>
        )}
        {!loading && !error && !isEmpty && (
          <div className="grid">
            {data.folders.map(f => (
              <article key={`sf-${f.id}`} className="card">
                <button
                  type="button"
                  className="card-open"
                  aria-label={`Open folder ${f.name}`}
                  onClick={() => navigate(folderHref(f.id, f.owner?.username))}
                />
                <div className="icon">
                  <FolderIcon size={32} strokeWidth={1.5} />
                </div>
                <div className="name">{f.name}</div>
                <div className="meta">
                  {f.owner && <span>@{f.owner.username}</span>}
                  <span className="badge" style={{ marginLeft: 6 }}>
                    {f.role}
                  </span>
                </div>
              </article>
            ))}
            {data.files.map(f => (
              <article key={`sfi-${f.id}`} className="card">
                <button
                  type="button"
                  className="card-open"
                  aria-label={`Preview ${f.name}`}
                  onClick={() => setPreviewing(f)}
                />
                <FileThumb file={f} />
                <div className="name">{f.name}</div>
                <div className="meta">
                  {formatBytes(f.size)}
                  {f.owner && <span style={{ marginLeft: 8 }}>@{f.owner.username}</span>}
                  <span className="badge" style={{ marginLeft: 6 }}>
                    {f.role}
                  </span>
                </div>
                <div className="row card-actions">
                  <button type="button" onClick={() => downloadFile(f)}>
                    Download
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {previewing && <PreviewModal file={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  )
}

const SharesView: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [shares, setShares] = useState<Share[]>([])

  const load = async () => {
    setLoading(true)
    setError("")
    try {
      const data = await api.listShares()
      if (!Array.isArray(data)) throw new Error(data?.error ?? "Could not load public links.")
      setShares(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e?.message ?? "Could not load this page. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const [copiedId, setCopiedId] = useState<number | null>(null)
  const copy = async (id: number, url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(id)
    } catch {
      setError("Could not copy the link. Select it and copy it manually.")
    }
  }

  const revoke = async (id: number) => {
    if (!confirm("Revoke this public link? Anyone using it will lose access.")) return
    try {
      const res = await api.deleteShare(id)
      if (res.error) return setError(res.error)
      await load()
    } catch {
      setError("Could not revoke the link. Check your connection and try again.")
    }
  }

  if (loading || error || shares.length === 0) {
    return (
      <div className="main">
        <div className="toolbar">
          <div className="crumbs">
            <span className="current">Public links</span>
          </div>
        </div>
        <div className="content">
          {loading && (
            <div className="empty" role="status">
              Loading…
            </div>
          )}
          {error && (
            <div className="msg err" role="alert">
              {error}{" "}
              <button type="button" onClick={load}>
                Try again
              </button>
            </div>
          )}
          {!loading && !error && (
            <div className="empty">
              <div className="big">
                <Link2 size={64} strokeWidth={1.25} />
              </div>
              <div>No public links yet</div>
              <p>Open a file’s Share menu and choose Public link to share it outside your team.</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs">
          <span className="current">Public links</span>
        </div>
      </div>
      <div className="content">
        {loading && (
          <div className="empty" role="status">
            Loading…
          </div>
        )}
        {error && (
          <div className="msg err" role="alert">
            {error}{" "}
            <button type="button" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {copiedId != null && (
          <p className="field-help" role="status">
            Link copied to clipboard.
          </p>
        )}
        <table className="shares-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Link</th>
              <th>Size</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shares.map(s => {
              const url = `${window.location.origin}/s/${s.token}`
              return (
                <tr key={s.id}>
                  <td>
                    <span className="inline-icon">
                      <MimeIcon mime={s.mime} size={16} />
                    </span>{" "}
                    {s.name}
                    {s.password_required && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        password
                      </span>
                    )}
                    {s.burn_on_view && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        one-time
                      </span>
                    )}
                  </td>
                  <td>
                    <a href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  </td>
                  <td>{formatBytes(s.size)}</td>
                  <td>{s.expires_at ? new Date(s.expires_at).toLocaleString() : "Never"}</td>
                  <td>
                    <button type="button" onClick={() => copy(s.id, url)}>
                      {copiedId === s.id ? "Copied" : "Copy link"}
                    </button>
                    <button type="button" className="danger" onClick={() => revoke(s.id)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type GalleryFile = { id: number; name: string; mime: string; size: number; version: number; created_at: string }

const AuthedImage: React.FC<{ src: string; alt: string; useAuth: boolean; fallback?: React.ReactNode }> = ({
  src,
  alt,
  useAuth,
  fallback = <MimeIcon mime="image/" size={32} />,
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const [resolved, setResolved] = useState<string | null>(useAuth ? null : src)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(!useAuth)

  useEffect(() => {
    if (!useAuth) return
    const node = ref.current
    if (!node) return
    const obs = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) {
          setVisible(true)
          obs.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    obs.observe(node)
    return () => obs.disconnect()
  }, [useAuth])

  // Fetch the auth-protected image once `src`/`useAuth`/visibility settles.
  // Cleanup revokes the object URL on src change OR unmount — never on the
  // resolved-state transition itself, which would revoke the URL we just put
  // into the <img>.
  useEffect(() => {
    if (!useAuth || !visible) {
      if (!useAuth) setResolved(src)
      return
    }
    let aborted = false
    let createdUrl: string | null = null
    setResolved(null)
    setLoaded(false)
    setFailed(false)
    ;(async () => {
      try {
        const res = await fetch(src, { headers: { authorization: `Bearer ${api.getToken()}` } })
        if (aborted) return
        if (!res.ok) {
          setFailed(true)
          return
        }
        const blob = await res.blob()
        if (aborted) return
        createdUrl = URL.createObjectURL(blob)
        setResolved(createdUrl)
      } catch {
        if (!aborted) setFailed(true)
      }
    })()
    return () => {
      aborted = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [src, useAuth, visible])

  return (
    <div ref={ref} className="thumb-wrap">
      {failed ? fallback : !loaded && <div className="thumb-spinner" aria-hidden="true" />}
      {resolved && !failed && (
        <img
          src={resolved}
          alt={alt}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={loaded ? "loaded" : ""}
        />
      )}
    </div>
  )
}

const PhotosGallery: React.FC<{
  files: GalleryFile[]
  thumbUrl: (id: number, version: number) => string
  fullUrl: (id: number) => string
  authHeader?: boolean
}> = ({ files, thumbUrl, fullUrl, authHeader }) => {
  const [active, setActive] = useState<number | null>(null)
  const photos = files.filter(f => f.mime.startsWith("image/") || f.mime.startsWith("video/"))

  useEffect(() => {
    if (active === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null)
      else if (e.key === "ArrowRight") setActive(i => (i === null ? 0 : Math.min(i + 1, photos.length - 1)))
      else if (e.key === "ArrowLeft") setActive(i => (i === null ? 0 : Math.max(i - 1, 0)))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [active, photos.length])

  if (photos.length === 0) {
    return (
      <div className="empty">
        <div className="big">
          <FileImage size={64} strokeWidth={1.25} />
        </div>
        <div>No photos yet</div>
      </div>
    )
  }

  return (
    <>
      <div className="gallery">
        {photos.map((p, i) => (
          <button
            type="button"
            key={p.id}
            className="tile"
            aria-label={`Preview ${p.name}`}
            onClick={() => setActive(i)}
          >
            <AuthedImage src={thumbUrl(p.id, p.version)} alt="" useAuth={!!authHeader} />
            <span className="gallery-name">{p.name}</span>
          </button>
        ))}
      </div>
      {active !== null && photos[active] && (
        <LightboxView
          file={photos[active]!}
          fullUrl={fullUrl}
          authHeader={!!authHeader}
          hasPrev={active > 0}
          hasNext={active < photos.length - 1}
          onPrev={() => setActive(i => (i === null ? null : Math.max(0, i - 1)))}
          onNext={() => setActive(i => (i === null ? null : Math.min(photos.length - 1, i + 1)))}
          onClose={() => setActive(null)}
        />
      )}
    </>
  )
}

const LightboxView: React.FC<{
  file: GalleryFile
  fullUrl: (id: number) => string
  authHeader: boolean
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}> = ({ file, fullUrl, authHeader, hasPrev, hasNext, onPrev, onNext, onClose }) => {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let aborted = false
    let objectUrl: string | null = null
    ;(async () => {
      if (!authHeader) {
        setSrc(fullUrl(file.id))
        return
      }
      const res = await fetch(fullUrl(file.id), {
        headers: { authorization: `Bearer ${api.getToken()}` },
      })
      if (!res.ok) {
        setSrc(null)
        return
      }
      const blob = await res.blob()
      if (aborted) return
      objectUrl = URL.createObjectURL(blob)
      setSrc(objectUrl)
    })()
    return () => {
      aborted = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.id])

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-bar" onClick={e => e.stopPropagation()}>
        <div className="lightbox-title">{file.name}</div>
        <button type="button" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="lightbox-stage" onClick={e => e.stopPropagation()}>
        {hasPrev && (
          <button type="button" className="lightbox-nav prev" onClick={onPrev} aria-label="Previous">
            ‹
          </button>
        )}
        {file.mime.startsWith("video/")
          ? src && <video src={src} controls autoPlay />
          : src && <img src={src} alt={file.name} />}
        {hasNext && (
          <button type="button" className="lightbox-nav next" onClick={onNext} aria-label="Next">
            ›
          </button>
        )}
      </div>
    </div>
  )
}

/* ─────────── Recipes (user-facing automations) ───────────
 * Mom doesn't see slugs, events, or schemas. She picks a recipe, fills in
 * one or two readable fields, and we translate to one or more action
 * folder rows behind the scenes.
 */

type RecipeFieldNumber = {
  key: string
  label: string
  type: "number"
  defaultValue: number
  min?: number
  max?: number
  unit?: string
  help?: string
}
type RecipeFieldSelect = {
  key: string
  label: string
  type: "select"
  defaultValue: string
  options: Array<{ value: string; label: string }>
  help?: string
}
type RecipeFieldNumberUnit = {
  key: string // value lives at draft[key]
  unitKey: string // chosen unit lives at draft[unitKey]
  label: string
  type: "number-unit"
  defaultUnit: string
  units: Array<{ value: string; label: string; defaultValue: number; min: number; max: number }>
  help?: string
}
type RecipeField = RecipeFieldNumber | RecipeFieldSelect | RecipeFieldNumberUnit

type RecipeAction = { slug: string; event: api.ActionEventName; config: Record<string, unknown> }

type Recipe = {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  fields: RecipeField[]
  apply: (input: Record<string, unknown>) => RecipeAction[]
  /** does an existing action row look like it came from this recipe? */
  matches: (slug: string, config: Record<string, unknown>) => boolean
  /** short summary of what's currently configured, e.g. "Max width 1024px" */
  summarize?: (config: Record<string, unknown>) => string
}

const RECIPES: Recipe[] = [
  {
    id: "resize-images",
    name: "Make images smaller",
    description:
      "Shrinks every image to a maximum width while keeping its proportions. Great for photo folders that don't need full-size originals.",
    icon: <FileImage size={20} strokeWidth={1.6} />,
    fields: [
      {
        key: "width",
        unitKey: "width_unit",
        label: "Maximum width",
        type: "number-unit",
        defaultUnit: "px",
        units: [
          { value: "px", label: "px", defaultValue: 1024, min: 64, max: 8192 },
          { value: "pct", label: "%", defaultValue: 50, min: 1, max: 100 },
        ],
        help: "Pixels = a fixed maximum. Percent = relative to each image's original width.",
      },
    ],
    apply: v => {
      const unit = (v.width_unit as string) ?? "px"
      const raw = Number(v.width)
      const cfg: Record<string, unknown> = { fit: "inside" }
      if (unit === "pct") {
        const pct = Math.max(1, Math.min(100, Number.isFinite(raw) ? Math.round(raw) : 50))
        cfg.width_pct = pct
      } else {
        const width = Math.max(64, Math.min(8192, Number.isFinite(raw) ? Math.round(raw) : 1024))
        cfg.width = width
      }
      return [
        { slug: "stohr/resize-image", event: "file.created", config: cfg },
        { slug: "stohr/resize-image", event: "file.moved.in", config: cfg },
      ]
    },
    matches: (slug, config) => slug === "stohr/resize-image" && !config.format,
    summarize: config => {
      if (typeof config.width === "number") return `Maximum width ${config.width}px`
      if (typeof config.width_pct === "number") return `${config.width_pct}% of original width`
      return ""
    },
  },
  {
    id: "compress-images",
    name: "Save space (compress images)",
    description:
      "Re-saves images at smaller file sizes with little quality loss. Saves a lot of storage on photo-heavy folders.",
    icon: <Zap size={20} strokeWidth={1.8} />,
    fields: [
      {
        key: "width",
        label: "Maximum width",
        type: "number",
        defaultValue: 2048,
        min: 64,
        max: 8192,
        unit: "px",
      },
      {
        key: "quality",
        label: "Quality",
        type: "select",
        defaultValue: "85",
        options: [
          { value: "70", label: "Good (smallest files)" },
          { value: "85", label: "Great (recommended)" },
          { value: "95", label: "Best (largest files)" },
        ],
      },
    ],
    apply: v => {
      const width = Math.max(64, Math.min(8192, Number(v.width ?? 2048) || 2048))
      const quality = Math.max(1, Math.min(100, Number(v.quality ?? 85) || 85))
      const cfg = { width, quality, format: "webp" }
      return [
        { slug: "stohr/resize-image", event: "file.created", config: cfg },
        { slug: "stohr/resize-image", event: "file.moved.in", config: cfg },
      ]
    },
    matches: (slug, config) => slug === "stohr/resize-image" && config.format === "webp",
    summarize: config => {
      const q = Number(config.quality ?? 85)
      const label = q <= 75 ? "Good" : q >= 95 ? "Best" : "Great"
      return `${label} quality, max ${config.width ?? 2048}px wide`
    },
  },
  {
    id: "organize-by-date",
    name: "Organize by date",
    description: "Sorts every new file into year and month subfolders, so you can find things by when you saved them.",
    icon: <Calendar size={20} strokeWidth={1.6} />,
    fields: [
      {
        key: "depth",
        label: "How detailed?",
        type: "select",
        defaultValue: "month",
        options: [
          { value: "month", label: "Year and month (e.g. 2026 / 04)" },
          { value: "day", label: "Year, month, and day (e.g. 2026 / 04 / 29)" },
        ],
      },
    ],
    apply: v => {
      const pattern = v.depth === "day" ? "YYYY/MM/DD" : "YYYY/MM"
      const cfg = { pattern }
      return [
        { slug: "stohr/organize-by-date", event: "file.created", config: cfg },
        { slug: "stohr/organize-by-date", event: "file.moved.in", config: cfg },
      ]
    },
    matches: slug => slug === "stohr/organize-by-date",
    summarize: config => (config.pattern === "YYYY/MM/DD" ? "By year, month, and day" : "By year and month"),
  },
]

const findRecipe = (slug: string, config: Record<string, unknown>): Recipe | undefined =>
  RECIPES.find(r => r.matches(slug, config))

const FolderAutomationsPanel: React.FC<{ folderId: number }> = ({ folderId }) => {
  const [actions, setActions] = useState<api.FolderActionRow[]>([])
  const [userActions, setUserActions] = useState<api.UserAction[]>([])
  const [adding, setAdding] = useState<Recipe | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const load = async () => {
    const [list, uas] = await Promise.all([api.listFolderActions(folderId), api.listUserActions()])
    setActions(Array.isArray(list) ? list : [])
    setUserActions(Array.isArray(uas) ? uas : [])
  }
  useEffect(() => {
    void load()
  }, [folderId])

  /* Group existing rows so users see one entry per "automation".
   * - Built-in recipes group by recipe id
   * - User actions group by their slug
   * - Anything else groups by raw slug
   */
  const groups = useMemo(() => {
    type Group = {
      key: string
      recipe?: Recipe
      userAction?: api.UserAction
      rows: api.FolderActionRow[]
    }
    const out: Group[] = []
    const seen = new Map<string, number>()
    for (const a of actions) {
      let key: string
      let recipe: Recipe | undefined
      let userAction: api.UserAction | undefined
      if (a.slug.startsWith("u/")) {
        userAction = userActions.find(u => u.slug === a.slug)
        key = `u:${a.slug}`
      } else {
        recipe = findRecipe(a.slug, a.config)
        key = recipe ? `r:${recipe.id}` : `s:${a.slug}`
      }
      if (seen.has(key)) {
        out[seen.get(key)!].rows.push(a)
      } else {
        seen.set(key, out.length)
        out.push({ key, recipe, userAction, rows: [a] })
      }
    }
    return out
  }, [actions, userActions])

  const attachUserAction = async (ua: api.UserAction) => {
    if (ua.triggers.length === 0) {
      setError(`"${ua.name}" has no triggers selected. Open it in Actions to add some.`)
      return
    }
    setBusy(true)
    setError("")
    for (const trigger of ua.triggers) {
      const res = await api.createFolderAction(folderId, { event: trigger, slug: ua.slug })
      if ((res as any).error) {
        setError((res as any).error)
        setBusy(false)
        await load()
        return
      }
    }
    setBusy(false)
    await load()
  }

  const startAdd = (recipe: Recipe) => {
    const init: Record<string, unknown> = {}
    for (const f of recipe.fields) {
      if (f.type === "number-unit") {
        const unit = f.units.find(u => u.value === f.defaultUnit) ?? f.units[0]
        init[f.key] = unit.defaultValue
        init[f.unitKey] = unit.value
      } else {
        init[f.key] = f.defaultValue
      }
    }
    setDraft(init)
    setError("")
    setAdding(recipe)
  }

  const submitAdd = async () => {
    if (!adding) return
    setBusy(true)
    setError("")
    const tuples = adding.apply(draft)
    for (const t of tuples) {
      const res = await api.createFolderAction(folderId, t)
      if ((res as any).error) {
        setError((res as any).error)
        setBusy(false)
        await load()
        return
      }
    }
    setBusy(false)
    setAdding(null)
    await load()
  }

  const togglePause = async (rows: api.FolderActionRow[]) => {
    const allOn = rows.every(r => r.enabled)
    setBusy(true)
    for (const r of rows) {
      await api.updateFolderAction(folderId, r.id, { enabled: !allOn })
    }
    setBusy(false)
    await load()
  }

  const removeGroup = async (label: string, rows: api.FolderActionRow[]) => {
    if (!confirm(`Remove "${label}"?`)) return
    setBusy(true)
    for (const r of rows) {
      await api.deleteFolderAction(folderId, r.id)
    }
    setBusy(false)
    await load()
  }

  return (
    <div className="auto-panel">
      <div className="auto-panel-head">
        <div>
          <div className="auto-panel-title">Automations</div>
          <div className="auto-panel-sub">Run a helpful little task every time files arrive in this folder.</div>
        </div>
      </div>

      {groups.length === 0 && !adding && <div className="auto-empty">Nothing automated yet.</div>}

      {groups.map(g => {
        const label = g.recipe?.name ?? g.userAction?.name ?? "Custom automation"
        const config = g.rows[0]?.config ?? {}
        const summary = g.recipe?.summarize?.(config) ?? g.userAction?.description ?? ""
        const allOn = g.rows.every(r => r.enabled)
        return (
          <div key={g.key} className="auto-row">
            <div className="auto-row-icon">{g.recipe?.icon ?? <Zap size={18} strokeWidth={1.6} />}</div>
            <div className="auto-row-text">
              <div className="auto-row-title">
                {label}
                {g.userAction && <span className="action-pill">Your action</span>}
                {!allOn && <span className="action-pill muted">Paused</span>}
              </div>
              {summary && <div className="auto-row-meta">{summary}</div>}
            </div>
            <div className="auto-row-buttons">
              {g.userAction && (
                <button
                  type="button"
                  onClick={() => navigate(`/app/actions/${g.userAction!.id}/edit`)}
                  disabled={busy}
                  title="Edit in Actions"
                >
                  <Edit3 size={13} />
                </button>
              )}
              <button type="button" onClick={() => togglePause(g.rows)} disabled={busy}>
                {allOn ? "Pause" : "Resume"}
              </button>
              <button type="button" className="danger" onClick={() => removeGroup(label, g.rows)} disabled={busy}>
                Remove
              </button>
            </div>
          </div>
        )
      })}

      {!adding && (
        <div className="auto-recipes">
          <div className="auto-recipes-label">Built-in</div>
          <div className="auto-recipe-grid">
            {RECIPES.map(r => {
              const already = groups.some(g => g.recipe?.id === r.id)
              return (
                <button
                  key={r.id}
                  type="button"
                  className="auto-recipe"
                  onClick={() => startAdd(r)}
                  disabled={already}
                  title={already ? "Already added" : ""}
                >
                  <div className="auto-recipe-icon">{r.icon}</div>
                  <div className="auto-recipe-name">{r.name}</div>
                  <div className="auto-recipe-desc">{r.description}</div>
                  {already && <div className="auto-recipe-flag">Already added</div>}
                </button>
              )
            })}
          </div>

          {userActions.length > 0 && (
            <>
              <div className="auto-recipes-label" style={{ marginTop: 12 }}>
                Your actions
              </div>
              <div className="auto-recipe-grid">
                {userActions.map(ua => {
                  const already = groups.some(g => g.userAction?.slug === ua.slug)
                  return (
                    <button
                      key={ua.slug}
                      type="button"
                      className="auto-recipe"
                      onClick={() => attachUserAction(ua)}
                      disabled={already || busy}
                      title={already ? "Already added" : ""}
                    >
                      <div className="auto-recipe-icon">
                        <Zap size={20} strokeWidth={1.6} />
                      </div>
                      <div className="auto-recipe-name">{ua.name}</div>
                      <div className="auto-recipe-desc">{ua.description ?? ""}</div>
                      {already && <div className="auto-recipe-flag">Already added</div>}
                    </button>
                  )
                })}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                Manage your actions in{" "}
                <a
                  onClick={e => {
                    e.preventDefault()
                    navigate("/app/actions")
                  }}
                  href="/app/actions"
                  style={{ color: "var(--brand)", cursor: "pointer" }}
                >
                  Actions
                </a>
                .
              </div>
            </>
          )}
        </div>
      )}

      {adding && (
        <div className="auto-form">
          <div className="auto-form-head">
            <div className="auto-recipe-icon">{adding.icon}</div>
            <div>
              <div className="auto-form-title">{adding.name}</div>
              <div className="auto-form-desc">{adding.description}</div>
            </div>
          </div>

          <div className="auto-form-fields">
            {adding.fields.map(f => (
              <div key={f.key} className="auto-field">
                <label className="auto-field-label" htmlFor={`auto-${f.key}`}>
                  {f.label}
                </label>
                {f.type === "number" && (
                  <div className="auto-input-row">
                    <input
                      id={`auto-${f.key}`}
                      type="number"
                      min={f.min}
                      max={f.max}
                      value={(draft[f.key] as number | undefined) ?? ""}
                      onChange={e => {
                        const v = e.target.value
                        setDraft({ ...draft, [f.key]: v === "" ? undefined : parseInt(v, 10) })
                      }}
                    />
                    {f.unit && <span className="auto-input-unit">{f.unit}</span>}
                  </div>
                )}
                {f.type === "select" && (
                  <select
                    id={`auto-${f.key}`}
                    value={(draft[f.key] as string | undefined) ?? f.defaultValue}
                    onChange={e => setDraft({ ...draft, [f.key]: e.target.value })}
                  >
                    {f.options.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                )}
                {f.type === "number-unit" &&
                  (() => {
                    const currentUnit = (draft[f.unitKey] as string) ?? f.defaultUnit
                    const unitDef = f.units.find(u => u.value === currentUnit) ?? f.units[0]
                    return (
                      <div className="auto-input-row">
                        <input
                          id={`auto-${f.key}`}
                          type="number"
                          min={unitDef.min}
                          max={unitDef.max}
                          value={(draft[f.key] as number | undefined) ?? ""}
                          onChange={e => {
                            const v = e.target.value
                            setDraft({ ...draft, [f.key]: v === "" ? undefined : parseInt(v, 10) })
                          }}
                        />
                        <div className="auto-unit-toggle" role="group" aria-label="Unit">
                          {f.units.map(u => (
                            <button
                              key={u.value}
                              type="button"
                              className={`auto-unit-option${u.value === currentUnit ? " selected" : ""}`}
                              onClick={() => setDraft({ ...draft, [f.unitKey]: u.value, [f.key]: u.defaultValue })}
                              aria-pressed={u.value === currentUnit}
                            >
                              {u.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })()}
                {f.help && <div className="auto-field-help">{f.help}</div>}
              </div>
            ))}
          </div>

          {error && <div className="msg err">{error}</div>}

          <div className="auto-form-buttons">
            <button type="button" onClick={() => setAdding(null)} disabled={busy}>
              Back
            </button>
            <button type="button" className="primary" onClick={submitAdd} disabled={busy}>
              {busy ? "Saving…" : "Add automation"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const FolderSettingsModal: React.FC<{
  folderId: number
  folderName: string
  ownerUsername: string
  initialKind: string
  initialIsPublic: boolean
  onClose: () => void
  onSaved: () => void
}> = ({ folderId, folderName, ownerUsername, initialKind, initialIsPublic, onClose, onSaved }) => {
  const initialKindSafe: "standard" | "photos" | "screenshots" =
    initialKind === "photos" ? "photos" : initialKind === "screenshots" ? "screenshots" : "standard"
  const [kind, setKind] = useState<"standard" | "photos" | "screenshots">(initialKindSafe)
  const [isPublic, setIsPublic] = useState(initialIsPublic)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const publicUrl = `${window.location.origin}/p/${ownerUsername}/${folderId}`
  const dirty = kind !== initialKindSafe || isPublic !== initialIsPublic

  const save = async () => {
    setBusy(true)
    setError("")
    const res = await api.updateFolder(folderId, {
      kind,
      is_public: isPublic,
    })
    setBusy(false)
    if (res.error) return setError(res.error)
    onSaved()
  }

  const KIND_OPTIONS: Array<{
    value: "standard" | "photos" | "screenshots"
    label: string
    desc: string
    icon: React.ReactNode
  }> = [
    {
      value: "standard",
      label: "Files & folders",
      desc: "The classic. Anything goes.",
      icon: <FolderIcon size={20} strokeWidth={1.6} />,
    },
    {
      value: "photos",
      label: "Photo album",
      desc: "Show as a clean photo grid with lightbox.",
      icon: <FileImage size={20} strokeWidth={1.6} />,
    },
    {
      value: "screenshots",
      label: "Screenshots",
      desc: "Drop captures here from the menu bar.",
      icon: <Camera size={20} strokeWidth={1.6} />,
    },
  ]

  return (
    <Modal title={`Settings — ${folderName}`} onClose={onClose} size="wide">
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* How should this folder look? */}
        <section className="settings-section">
          <div className="settings-section-head">
            <div className="settings-section-title">How should this folder look?</div>
            <div className="settings-section-sub">Pick the layout that fits what's in here.</div>
          </div>
          <div className="kind-cards">
            {KIND_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`kind-card${kind === opt.value ? " selected" : ""}`}
                onClick={() => setKind(opt.value)}
              >
                <div className="kind-card-icon">{opt.icon}</div>
                <div className="kind-card-name">{opt.label}</div>
                <div className="kind-card-desc">{opt.desc}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Sharing */}
        <section className="settings-section">
          <div className="settings-section-head">
            <div className="settings-section-title">Who can see this folder?</div>
            <div className="settings-section-sub">
              Public folders are visible to anyone with the link, no sign-in needed.
            </div>
          </div>
          <label className="settings-toggle">
            <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} />
            <span className="settings-toggle-track" aria-hidden="true">
              <span className="settings-toggle-dot" />
            </span>
            <div>
              <div className="settings-toggle-label">
                {isPublic ? "Public — anyone with the link" : "Private — only people I share with"}
              </div>
              {isPublic && (
                <div className="settings-toggle-help">Share the link below with anyone you want to give access.</div>
              )}
            </div>
          </label>
          {isPublic && (
            <div className="settings-link-row">
              <input
                className="settings-link-input"
                value={publicUrl}
                readOnly
                onFocus={e => e.currentTarget.select()}
              />
              <button type="button" onClick={() => navigator.clipboard.writeText(publicUrl)}>
                <Copy size={14} /> <span>Copy link</span>
              </button>
            </div>
          )}
        </section>

        {/* Automations */}
        <section className="settings-section">
          <FolderAutomationsPanel folderId={folderId} />
        </section>

        {error && <div className="msg err">{error}</div>}
      </div>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  )
}

type OAuthInfo = {
  client?: {
    client_id: string
    name: string
    description: string | null
    icon_url: string | null
    is_official: boolean
  }
  scopes?: string[]
  redirect_uri?: string
  state?: string | null
  error?: string
  error_description?: string
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: "View your files, folders, and account info",
  write: "Create, modify, and delete files and folders",
  share: "Create and revoke public share links",
}

// Only navigate to something a browser opens as a page — never a
// javascript:/data: URL the server might have been talked into returning.
const canFollowRedirect = (url: string): boolean => {
  try {
    const protocol = new URL(url).protocol.toLowerCase()
    return !["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"].includes(protocol)
  } catch {
    return false
  }
}

const OAuthConsent: React.FC<{ query: string }> = ({ query }) => {
  const [info, setInfo] = useState<OAuthInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.oauthAuthorizeInfo(query).then(setInfo)
  }, [query])

  const params = useMemo(() => {
    const out: Record<string, string> = {}
    new URLSearchParams(query).forEach((v, k) => {
      out[k] = v
    })
    return out
  }, [query])

  const decide = async (approve: boolean) => {
    setBusy(true)
    setError(null)
    const res = approve ? await api.oauthAuthorizeApprove(params) : await api.oauthAuthorizeDeny(params)
    setBusy(false)
    if (res.error) {
      setError(res.error_description ?? res.error)
      return
    }
    if (res.redirect_url && canFollowRedirect(res.redirect_url)) {
      window.location.replace(res.redirect_url)
    }
  }

  if (!info) return <div className="share-page">Loading…</div>
  if (info.error || !info.client) {
    return (
      <div className="share-page">
        <div className="file-icon">
          <AlertTriangle size={64} strokeWidth={1.5} />
        </div>
        <div className="filename">Authorization failed</div>
        <div className="filemeta">{info.error_description ?? info.error ?? "Unknown error"}</div>
      </div>
    )
  }

  const me = api.getUser()
  return (
    <div className="oauth-consent">
      <div className="oauth-card">
        <Logo className="oauth-logo" size={96} />
        <h2 className="oauth-title">
          <strong>{info.client.name}</strong> wants to access your Stohr
        </h2>
        {info.client.description && <div className="oauth-desc">{info.client.description}</div>}
        {info.client.is_official && <div className="oauth-official">Official Stohr application</div>}

        <div className="oauth-scopes">
          <div className="oauth-scopes-title">It will be able to:</div>
          {(info.scopes ?? []).map(s => (
            <div key={s} className="oauth-scope-row">
              <code>{s}</code>
              <span>{SCOPE_DESCRIPTIONS[s] ?? "Access your account"}</span>
            </div>
          ))}
        </div>

        {me && (
          <div className="oauth-account">
            Signing in as <strong>@{me.username}</strong>
          </div>
        )}

        {error && <div className="msg err">{error}</div>}

        <div className="oauth-actions">
          <button type="button" onClick={() => decide(false)} disabled={busy}>
            Deny
          </button>
          <button type="button" className="primary" onClick={() => decide(true)} disabled={busy}>
            {busy ? "Working…" : "Authorize"}
          </button>
        </div>
        <div className="oauth-redirect-note">
          You'll be sent to <code>{info.redirect_uri}</code>.
        </div>
      </div>
    </div>
  )
}

type DeviceInfo = {
  client?: {
    client_id: string
    name: string
    description: string | null
    icon_url: string | null
    is_official: boolean
  }
  scopes?: string[]
  user_code?: string
  error?: string
  error_description?: string
}

const DevicePair: React.FC<{ query: string }> = ({ query }) => {
  const initialCode = useMemo(() => {
    const params = new URLSearchParams(query)
    return params.get("code") ?? ""
  }, [query])

  const [code, setCode] = useState(initialCode)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [decided, setDecided] = useState<"approved" | "denied" | null>(null)
  const [lookupErr, setLookupErr] = useState<string | null>(null)

  const fetchInfo = async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    setBusy(true)
    setLookupErr(null)
    const res = (await api.oauthDeviceInfo(trimmed)) as DeviceInfo
    setBusy(false)
    if (res.error) {
      setInfo(null)
      setLookupErr(res.error_description ?? res.error)
      return
    }
    setInfo(res)
  }

  useEffect(() => {
    if (initialCode) void fetchInfo(initialCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode])

  const decide = async (approve: boolean) => {
    if (!info?.user_code) return
    setBusy(true)
    setLookupErr(null)
    const res = approve ? await api.oauthDeviceApprove(info.user_code) : await api.oauthDeviceDeny(info.user_code)
    setBusy(false)
    if (res.error) {
      setLookupErr(res.error_description ?? res.error)
      return
    }
    setDecided(approve ? "approved" : "denied")
  }

  const me = api.getUser()

  if (decided) {
    const ok = decided === "approved"
    return (
      <div className="oauth-consent">
        <div className="oauth-card">
          <Logo className="oauth-logo" size={96} />
          <h2 className="oauth-title">{ok ? "Device connected" : "Request denied"}</h2>
          <div className="oauth-desc">
            {ok
              ? "Head back to your app — it should be signed in within a few seconds."
              : "The app won't get access. You can close this window."}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="oauth-consent">
      <div className="oauth-card">
        <Logo className="oauth-logo" size={96} />
        <h2 className="oauth-title">Pair a device</h2>

        {!info && (
          <>
            <div className="oauth-desc">Enter the code shown by the app you're trying to sign in.</div>
            <input
              aria-label="ABCD-1234"
              autoFocus
              placeholder="ABCD-1234"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => {
                if (e.key === "Enter") void fetchInfo(code)
              }}
              style={{
                marginTop: 12,
                textAlign: "center",
                fontFamily: "ui-monospace, Menlo, monospace",
                fontSize: 18,
                letterSpacing: 2,
              }}
            />
            {lookupErr && (
              <div className="msg err" style={{ marginTop: 10 }}>
                {lookupErr}
              </div>
            )}
            <div className="oauth-actions">
              <button
                type="button"
                className="primary"
                disabled={busy || code.trim().length === 0}
                onClick={() => fetchInfo(code)}
              >
                {busy ? "Looking up…" : "Continue"}
              </button>
            </div>
          </>
        )}

        {info?.client && (
          <>
            <div className="oauth-title" style={{ marginTop: 12 }}>
              <strong>{info.client.name}</strong> wants access
            </div>
            {info.client.is_official && <div className="oauth-official">Official Stohr application</div>}
            <div className="oauth-scopes">
              <div className="oauth-scopes-title">It will be able to:</div>
              {(info.scopes ?? []).map(s => (
                <div key={s} className="oauth-scope-row">
                  <code>{s}</code>
                  <span>{SCOPE_DESCRIPTIONS[s] ?? "Access your account"}</span>
                </div>
              ))}
            </div>
            {me && (
              <div className="oauth-account">
                Signing in as <strong>@{me.username}</strong>
              </div>
            )}
            {lookupErr && <div className="msg err">{lookupErr}</div>}
            <div className="oauth-actions">
              <button type="button" onClick={() => decide(false)} disabled={busy}>
                Deny
              </button>
              <button type="button" className="primary" onClick={() => decide(true)} disabled={busy}>
                {busy ? "Working…" : "Authorize"}
              </button>
            </div>
            <div className="oauth-redirect-note">
              Pairing code: <code>{info.user_code}</code>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const PublicFolderPage: React.FC<{ username: string; folderId: number }> = ({ username, folderId }) => {
  const [data, setData] = useState<
    | {
        folder: { id: number; name: string; kind: string }
        owner: { username: string; name: string }
        files: GalleryFile[]
      }
    | { error: string }
    | null
  >(null)

  useEffect(() => {
    api.getPublicFolder(username, folderId).then(setData)
  }, [username, folderId])

  if (!data) return <div className="share-page">Loading…</div>
  if ("error" in data) {
    return (
      <div className="share-page">
        <div className="file-icon">
          <AlertTriangle size={64} strokeWidth={1.5} />
        </div>
        <div className="filename">Not found</div>
        <div className="filemeta">This folder isn't public, or doesn't exist.</div>
      </div>
    )
  }

  return (
    <div className="public-folder">
      <header className="public-header">
        <div className="public-brand" onClick={() => window.location.assign("/")}>
          <Logo />
        </div>
        <div className="public-meta">
          <div className="public-title">{data.folder.name}</div>
          <div className="public-owner">@{data.owner.username}</div>
        </div>
      </header>
      <div className="public-content">
        <PhotosGallery
          files={data.files}
          thumbUrl={id => api.publicThumbUrl(id)}
          fullUrl={id => api.publicFileInlineUrl(id)}
          authHeader={false}
        />
      </div>
    </div>
  )
}

type ShareMeta = {
  name?: string
  size?: number
  mime?: string
  expires_at?: string | null
  password_required?: boolean
  burn_on_view?: boolean
  error?: string
}

const SharePage: React.FC<{ token: string }> = ({ token }) => {
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [password, setPassword] = useState("")
  const [unlocked, setUnlocked] = useState(false)
  const [content, setContent] = useState<{ blobUrl: string; downloadUrl: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.shareMeta(token).then(setMeta)
  }, [token])

  useEffect(() => {
    return () => {
      if (content) {
        URL.revokeObjectURL(content.blobUrl)
        URL.revokeObjectURL(content.downloadUrl)
      }
    }
  }, [content])

  const reveal = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.fetchShare(token, password || undefined, true)
      if (!res.ok) {
        if (res.status === 401) {
          setUnlocked(false)
          setError("Wrong password")
        } else if (res.status === 410) {
          setError("This link has expired")
        } else if (res.status === 404) {
          setError("This link is no longer available — it may have been viewed already")
        } else {
          setError(`Could not load (HTTP ${res.status})`)
        }
        return
      }
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const downloadUrl = URL.createObjectURL(new Blob([blob], { type: blob.type || "application/octet-stream" }))
      setContent({ blobUrl, downloadUrl })
      setUnlocked(true)
    } catch (e: any) {
      setError(e?.message ?? "Network error")
    } finally {
      setBusy(false)
    }
  }

  const triggerDownload = () => {
    if (!content || !meta?.name) return
    const a = document.createElement("a")
    a.href = content.downloadUrl
    a.download = meta.name
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  if (!meta) return <div className="share-page">Loading…</div>
  if (meta.error) {
    return (
      <div className="share-page">
        <div className="file-icon">
          <AlertTriangle size={64} strokeWidth={1.5} />
        </div>
        <div className="filename">{meta.error}</div>
      </div>
    )
  }

  const kind = meta.mime ? kindFor(meta.mime) : "other"
  const expiresLabel = meta.expires_at ? new Date(meta.expires_at).toLocaleString() : null

  return (
    <div className="public-folder">
      <header className="public-header">
        <div className="public-brand" onClick={() => window.location.assign("/")}>
          <Logo />
        </div>
        <div className="public-meta">
          <div className="public-title">{meta.name}</div>
          <div className="public-owner">
            {formatBytes(meta.size ?? 0)} • {meta.mime}
          </div>
        </div>
        {unlocked && content && (
          <button type="button" className="primary" onClick={triggerDownload}>
            <Download size={14} /> <span>Download</span>
          </button>
        )}
      </header>

      {!unlocked && (
        <div className="public-content share-viewer">
          <div className="share-gate">
            <div className="share-gate-card">
              <div className="share-gate-icon">
                <MimeIcon mime={meta.mime ?? ""} size={48} />
              </div>
              <div className="share-gate-name">{meta.name}</div>
              <div className="share-gate-meta">
                {formatBytes(meta.size ?? 0)} • {meta.mime}
              </div>
              {expiresLabel && <div className="share-gate-warn">Expires {expiresLabel}</div>}
              {meta.burn_on_view && (
                <div className="share-gate-burn">
                  <AlertTriangle size={14} /> One-time view — this link self-destructs after you open it
                </div>
              )}
              {meta.password_required && (
                <input
                  aria-label="Password"
                  type="password"
                  autoComplete="off"
                  placeholder="Password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") reveal()
                  }}
                  style={{ marginTop: 12 }}
                />
              )}
              {error && (
                <div className="msg err" style={{ marginTop: 10 }}>
                  {error}
                </div>
              )}
              <div className="actions" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || (!!meta.password_required && !password)}
                  onClick={reveal}
                >
                  {busy ? "Loading…" : meta.burn_on_view ? "Open & destroy link" : "Open"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {unlocked && content && (
        <div className="public-content share-viewer">
          {kind === "image" && <img className="share-media" src={content.blobUrl} alt={meta.name} />}
          {kind === "video" && <video className="share-media" src={content.blobUrl} controls />}
          {kind === "audio" && (
            <div className="share-audio">
              <div className="preview-audio-icon">
                <Music size={72} strokeWidth={1.25} />
              </div>
              <audio src={content.blobUrl} controls />
            </div>
          )}
          {kind === "pdf" && <iframe className="share-pdf" src={content.blobUrl} title={meta.name} />}
          {kind === "text" && <ShareText blobUrl={content.blobUrl} />}
          {kind === "other" && (
            <div className="empty">
              <div className="big">
                <MimeIcon mime={meta.mime ?? ""} size={64} />
              </div>
              <div>No inline preview for this file type</div>
              <button type="button" className="primary" onClick={triggerDownload} style={{ marginTop: 16 }}>
                Download {meta.name}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ShareText: React.FC<{ blobUrl: string }> = ({ blobUrl }) => {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let aborted = false
    fetch(blobUrl)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then(t => {
        if (!aborted) setText(t)
      })
      .catch(e => {
        if (!aborted) setError(e.message)
      })
    return () => {
      aborted = true
    }
  }, [blobUrl])
  if (error) return <div className="empty">Could not load: {error}</div>
  if (text === null) return <div className="empty">Loading…</div>
  return <pre className="preview-text">{text}</pre>
}

/* Action Builder views */

const TRIGGER_LABELS: Record<api.ActionEventName, string> = {
  "file.created": "A file is uploaded here",
  "file.updated": "A file here is renamed or replaced",
  "file.deleted": "A file here is deleted",
  "file.moved.in": "A file is moved here",
  "file.moved.out": "A file is moved away",
  "folder.created": "A subfolder is created",
  "folder.updated": "A subfolder is renamed",
  "folder.deleted": "A subfolder is deleted",
  "folder.moved.in": "A subfolder is moved here",
  "folder.moved.out": "A subfolder is moved away",
}

const ALL_TRIGGERS: api.ActionEventName[] = [
  "file.created",
  "file.moved.in",
  "file.updated",
  "file.deleted",
  "file.moved.out",
  "folder.created",
  "folder.moved.in",
  "folder.updated",
  "folder.deleted",
  "folder.moved.out",
]

type RegistryAction = {
  slug: string
  name: string
  description: string
  icon?: string | null
  is_builtin?: boolean
  editable?: boolean
  forked_from?: string | null
}

const ActionsListView: React.FC = () => {
  const [registry, setRegistry] = useState<RegistryAction[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const load = async () => {
    const reg = await jsonFetch("/api/actions/registry")
    setRegistry(reg.actions ?? [])
  }
  useEffect(() => {
    void load()
  }, [])

  const builtins = registry.filter(r => r.is_builtin)
  const userActions = registry.filter(r => !r.is_builtin)

  const cloneBuiltin = async (slug: string) => {
    setBusy(true)
    setError("")
    const res = await api.cloneBuiltin(slug)
    setBusy(false)
    if (res.error) return setError(res.error)
    navigate(`/app/actions/${res.id}/edit`)
  }

  const createBlank = async () => {
    setBusy(true)
    setError("")
    const res = await api.createUserAction({
      name: "New action",
      description: "",
      icon: "Zap",
      triggers: ["file.created"],
      steps: [],
    })
    setBusy(false)
    if (res.error) return setError(res.error)
    navigate(`/app/actions/${res.id}/edit`)
  }

  const remove = async (id: number, name: string) => {
    if (!confirm(`Remove "${name}"? This will also detach it from any folders.`)) return
    setBusy(true)
    await api.deleteUserAction(id)
    setBusy(false)
    await load()
  }

  return (
    <div className="main">
      <div className="toolbar">
        <div className="toolbar-actions">
          <button type="button" className="primary" onClick={createBlank} disabled={busy}>
            <Plus size={14} /> <span>New action</span>
          </button>
        </div>
      </div>

      <div className="content">
        <div className="path-bar">
          <div className="crumbs">
            <span className="current">Actions</span>
          </div>
        </div>

        {error && <div className="msg err">{error}</div>}

        <section className="actions-section">
          <div className="actions-section-head">
            <div>
              <div className="actions-section-title">Built-in</div>
              <div className="actions-section-sub">Read-only. Use them as-is, or save a copy and customize.</div>
            </div>
          </div>
          <div className="actions-grid">
            {builtins.length === 0 && <div className="actions-empty">No built-in actions.</div>}
            {builtins.map(a => (
              <div key={a.slug} className="action-tile builtin">
                <div className="action-tile-icon">
                  <Zap size={20} strokeWidth={1.6} />
                </div>
                <div className="action-tile-name">
                  {a.name} <span className="action-tile-badge">Built-in</span>
                </div>
                <div className="action-tile-desc">{a.description}</div>
                <div className="action-tile-buttons">
                  <button type="button" onClick={() => cloneBuiltin(a.slug)} disabled={busy}>
                    Save a copy
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="actions-section">
          <div className="actions-section-head">
            <div>
              <div className="actions-section-title">Your actions</div>
              <div className="actions-section-sub">Build, edit, and reuse your own automations.</div>
            </div>
          </div>
          <div className="actions-grid">
            {userActions.length === 0 && (
              <div className="actions-empty">
                Nothing yet. Save a copy of a built-in or click <strong>New action</strong> to start from scratch.
              </div>
            )}
            {userActions.map(a => (
              <div key={a.slug} className="action-tile">
                <div className="action-tile-icon">
                  <Zap size={20} strokeWidth={1.6} />
                </div>
                <div className="action-tile-name">{a.name}</div>
                {a.description && <div className="action-tile-desc">{a.description}</div>}
                {a.forked_from && <div className="action-tile-sub">Based on {a.forked_from}</div>}
                <div className="action-tile-buttons">
                  <button
                    type="button"
                    onClick={() => navigate(`/app/actions/${(a as any).id ?? Number(a.slug.replace(/^u\//, ""))}/edit`)}
                  >
                    <Edit3 size={13} /> <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => remove((a as any).id ?? Number(a.slug.replace(/^u\//, "")), a.name)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

const ActionEditView: React.FC<{ id: number }> = ({ id }) => {
  const [draft, setDraft] = useState<api.UserAction | null>(null)
  const [primitives, setPrimitives] = useState<api.PrimitiveDescriptor[]>([])
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    void (async () => {
      const [a, p] = await Promise.all([api.getUserAction(id), api.listPrimitives()])
      if ((a as any).error) {
        setError((a as any).error)
        return
      }
      setDraft(a as api.UserAction)
      setPrimitives(p.primitives ?? [])
    })()
  }, [id])

  const update = (patch: Partial<api.UserAction>) => {
    if (!draft) return
    setDraft({ ...draft, ...patch })
    setDirty(true)
  }

  const updateStep = (i: number, config: Record<string, unknown>) => {
    if (!draft) return
    const steps = draft.steps.map((s, idx) => (idx === i ? { ...s, config } : s))
    update({ steps })
  }

  const removeStep = (i: number) => {
    if (!draft) return
    update({ steps: draft.steps.filter((_, idx) => idx !== i) })
  }

  const moveStep = (i: number, delta: -1 | 1) => {
    if (!draft) return
    const next = [...draft.steps]
    const j = i + delta
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    update({ steps: next })
  }

  const initialConfigFor = (prim: api.PrimitiveDescriptor): Record<string, unknown> => {
    const props = ((prim.config_schema as any)?.properties ?? {}) as Record<string, any>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      if (v?.default !== undefined) out[k] = v.default
    }
    return out
  }

  const addStep = (prim: api.PrimitiveDescriptor) => {
    if (!draft) return
    update({ steps: [...draft.steps, { kind: prim.kind, config: initialConfigFor(prim) }] })
    setPicking(false)
  }

  const toggleTrigger = (t: api.ActionEventName) => {
    if (!draft) return
    const has = draft.triggers.includes(t)
    update({ triggers: has ? draft.triggers.filter(x => x !== t) : [...draft.triggers, t] })
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError("")
    const res = await api.updateUserAction(draft.id, {
      name: draft.name,
      description: draft.description,
      icon: draft.icon,
      triggers: draft.triggers,
      steps: draft.steps,
      enabled: draft.enabled,
    })
    setBusy(false)
    if ((res as any).error) return setError((res as any).error)
    setDraft(res as api.UserAction)
    setDirty(false)
  }

  if (!draft) {
    return (
      <div className="main">
        <div className="content">{error ? <div className="msg err">{error}</div> : "Loading…"}</div>
      </div>
    )
  }

  const groups = {
    filter: primitives.filter(p => p.category === "filter"),
    transform: primitives.filter(p => p.category === "transform"),
    route: primitives.filter(p => p.category === "route"),
  }

  return (
    <div className="main">
      <div className="toolbar">
        <div className="toolbar-actions">
          <button type="button" onClick={() => navigate("/app/actions")}>
            ← Back
          </button>
          <button type="button" className="primary" onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="content">
        <div className="path-bar">
          <div className="crumbs">
            <span className="crumb" onClick={() => navigate("/app/actions")}>
              Actions
            </span>
            <span className="sep">
              <ChevronRight size={14} />
            </span>
            <span className="current">{draft.name}</span>
          </div>
        </div>

        <div className="action-edit">
          <section className="action-edit-section">
            <label className="action-edit-field">
              <span>Name</span>
              <input type="text" value={draft.name} onChange={e => update({ name: e.target.value })} />
            </label>
            <label className="action-edit-field">
              <span>Description</span>
              <textarea
                rows={2}
                value={draft.description ?? ""}
                onChange={e => update({ description: e.target.value })}
              />
            </label>
          </section>

          <section className="action-edit-section">
            <div className="action-edit-section-title">When this action runs</div>
            <div className="action-edit-section-sub">Pick one or more events. The action runs on each one.</div>
            <div className="trigger-grid">
              {ALL_TRIGGERS.map(t => {
                const on = draft.triggers.includes(t)
                return (
                  <label key={t} className={`trigger-card${on ? " on" : ""}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleTrigger(t)} />
                    <span>{TRIGGER_LABELS[t]}</span>
                  </label>
                )
              })}
            </div>
            {draft.triggers.length === 0 && (
              <div className="msg warn">This action won't run until you check at least one event.</div>
            )}
          </section>

          <section className="action-edit-section">
            <div className="action-edit-section-title">Steps to run, in order</div>
            <div className="action-edit-section-sub">
              Each step happens to the file in turn. Filters can stop the chain.
            </div>

            {draft.steps.length === 0 && !picking && <div className="actions-empty">No steps yet. Add one below.</div>}

            {draft.steps.map((step, i) => {
              const prim = primitives.find(p => p.kind === step.kind)
              return (
                <div key={i} className={`step-card category-${prim?.category ?? "other"}`}>
                  <div className="step-card-head">
                    <div>
                      <div className="step-card-title">{prim?.name ?? step.kind}</div>
                      <div className="step-card-cat">{prim?.category ?? "step"}</div>
                    </div>
                    <div className="step-card-buttons">
                      <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} title="Move up">
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveStep(i, 1)}
                        disabled={i === draft.steps.length - 1}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button type="button" className="danger" onClick={() => removeStep(i)} title="Remove">
                        ×
                      </button>
                    </div>
                  </div>
                  {prim && <PrimitiveConfigForm prim={prim} value={step.config} onChange={cfg => updateStep(i, cfg)} />}
                </div>
              )
            })}

            {picking ? (
              <div className="step-picker">
                <div className="step-picker-head">
                  <div className="step-picker-title">Add a step</div>
                  <button type="button" onClick={() => setPicking(false)}>
                    Cancel
                  </button>
                </div>
                {(["filter", "transform", "route"] as const).map(
                  cat =>
                    groups[cat].length > 0 && (
                      <div key={cat} className="step-picker-group">
                        <div className="step-picker-group-title">{cat}</div>
                        <div className="step-picker-grid">
                          {groups[cat].map(p => (
                            <button key={p.kind} type="button" className="step-picker-card" onClick={() => addStep(p)}>
                              <div className="step-picker-card-name">{p.name}</div>
                              <div className="step-picker-card-desc">{p.description}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    ),
                )}
              </div>
            ) : (
              <button type="button" className="step-add" onClick={() => setPicking(true)}>
                <Plus size={14} /> <span>Add step</span>
              </button>
            )}
          </section>

          {error && <div className="msg err">{error}</div>}
        </div>
      </div>
    </div>
  )
}

const PrimitiveConfigForm: React.FC<{
  prim: api.PrimitiveDescriptor
  value: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
}> = ({ prim, value, onChange }) => {
  const schema = (prim.config_schema as any) ?? {}
  const props = (schema.properties ?? {}) as Record<string, any>
  const required = (schema.required ?? []) as string[]
  const entries = Object.entries(props)
  if (entries.length === 0) return null

  return (
    <div className="step-config">
      {entries.map(([key, prop]) => {
        const val = value[key]
        const label = prop.title ?? key
        const help = prop.description
        const isRequired = required.includes(key)

        if (Array.isArray(prop.enum) && prop.type === "string") {
          return (
            <label key={key} className="step-config-field">
              <span>
                {label}
                {isRequired && <em className="req"> *</em>}
              </span>
              <select value={(val as string) ?? ""} onChange={e => onChange({ ...value, [key]: e.target.value })}>
                {!isRequired && !prop.default && <option value="">— choose —</option>}
                {prop.enum.map((opt: string) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              {help && <span className="step-config-help">{help}</span>}
            </label>
          )
        }
        if (prop.type === "integer" || prop.type === "number") {
          return (
            <label key={key} className="step-config-field">
              <span>
                {label}
                {isRequired && <em className="req"> *</em>}
              </span>
              <input
                type="number"
                min={prop.minimum}
                max={prop.maximum}
                value={val === undefined || val === null ? "" : String(val)}
                onChange={e => {
                  const v = e.target.value
                  onChange({
                    ...value,
                    [key]: v === "" ? undefined : prop.type === "integer" ? parseInt(v, 10) : parseFloat(v),
                  })
                }}
              />
              {help && <span className="step-config-help">{help}</span>}
            </label>
          )
        }
        if (prop.type === "boolean") {
          return (
            <label key={key} className="step-config-field step-config-row">
              <input type="checkbox" checked={!!val} onChange={e => onChange({ ...value, [key]: e.target.checked })} />
              <span>
                {label}
                {isRequired && <em className="req"> *</em>}
              </span>
              {help && <span className="step-config-help">{help}</span>}
            </label>
          )
        }
        if (prop.type === "array" && prop.items?.enum) {
          const arr = Array.isArray(val) ? (val as string[]) : []
          const items = prop.items.enum as string[]
          return (
            <div key={key} className="step-config-field">
              <span>
                {label}
                {isRequired && <em className="req"> *</em>}
              </span>
              <div className="step-config-chips">
                {items.map(item => {
                  const on = arr.includes(item)
                  return (
                    <button
                      key={item}
                      type="button"
                      className={`chip${on ? " on" : ""}`}
                      onClick={() => onChange({ ...value, [key]: on ? arr.filter(x => x !== item) : [...arr, item] })}
                    >
                      {item}
                    </button>
                  )
                })}
              </div>
              {help && <span className="step-config-help">{help}</span>}
            </div>
          )
        }
        return (
          <label key={key} className="step-config-field">
            <span>
              {label}
              {isRequired && <em className="req"> *</em>}
            </span>
            <input
              type="text"
              value={(val as string) ?? ""}
              onChange={e => onChange({ ...value, [key]: e.target.value })}
            />
            {help && <span className="step-config-help">{help}</span>}
          </label>
        )
      })}
    </div>
  )
}

const jsonFetch = async (path: string) => {
  const res = await fetch(path, {
    headers: api.getToken() ? { authorization: `Bearer ${api.getToken()}` } : {},
  })
  return res.json()
}

const SIDEBAR_COLLAPSED_KEY = "stohr_sidebar_collapsed"

const summarizeNotification = (n: api.NotificationRow): string => {
  switch (n.kind) {
    case "comment.created":
      return "New comment"
    case "comment.reply":
      return "New reply"
    case "collab.invited":
      return n.payload?.role ? `Shared with you (${n.payload.role})` : "Shared with you"
    case "share.created":
      return "Public link created"
    case "file.added":
      return "File added"
    case "file.changed":
      return "File updated"
    case "file.moved":
      return "File moved"
    case "folder.added":
      return "Folder added"
    default:
      return n.kind
  }
}

const notificationHref = (n: api.NotificationRow): string | null => {
  if (n.resource_type === "file" && n.resource_id) return `/app/u/me/file/${n.resource_id}`
  if (n.resource_type === "folder" && n.resource_id) return `/app/f/${n.resource_id}`
  return null
}

const NotificationsView: React.FC<{ onChange: () => void }> = ({ onChange }) => {
  const [items, setItems] = useState<api.NotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [filter, setFilter] = useState<"all" | "unread">("all")

  const refresh = async () => {
    setLoading(true)
    setError("")
    try {
      const res = await api.listNotifications(filter === "unread")
      if ((res as any).error) throw new Error((res as any).error)
      setItems(Array.isArray(res.notifications) ? res.notifications : [])
      setUnread(res.unread)
    } catch (e: any) {
      setError(e?.message ?? "Could not load this page. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    refresh()
  }, [filter])

  const markRead = async (n: api.NotificationRow) => {
    if (n.read_at) return
    await api.markNotificationRead(n.id)
    setItems(prev => prev.map(x => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)))
    setUnread(u => Math.max(0, u - 1))
    onChange()
  }
  const markAll = async () => {
    await api.markAllNotificationsRead()
    setItems(prev => prev.map(x => (x.read_at ? x : { ...x, read_at: new Date().toISOString() })))
    setUnread(0)
    onChange()
  }
  const remove = async (n: api.NotificationRow) => {
    await api.deleteNotification(n.id)
    setItems(prev => prev.filter(x => x.id !== n.id))
    if (!n.read_at) setUnread(u => Math.max(0, u - 1))
    onChange()
  }

  return (
    <div className="main">
      <div className="toolbar page-toolbar">
        <h2 className="page-title">Notifications</h2>
        <div className="toolbar-actions">
          <button type="button" onClick={() => setFilter("all")} className={filter === "all" ? "primary" : undefined}>
            All
          </button>
          <button
            type="button"
            onClick={() => setFilter("unread")}
            className={filter === "unread" ? "primary" : undefined}
          >
            Unread{unread > 0 ? ` (${unread})` : ""}
          </button>
          {unread > 0 && (
            <button type="button" onClick={markAll}>
              Mark all read
            </button>
          )}
        </div>
      </div>
      <div className="content">
        {error && (
          <div className="msg err" role="alert">
            {error}{" "}
            <button type="button" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {error ? null : loading && items.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: "24px 0", color: "var(--muted)" }}>
            {filter === "unread" ? "You're all caught up." : "No notifications yet."}
          </div>
        ) : (
          <div>
            {items.map(n => {
              const href = notificationHref(n)
              return (
                <article
                  className="message-row"
                  key={n.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderRadius: 6,
                    marginBottom: 4,
                    background: n.read_at ? "transparent" : "var(--accent-bg)",
                    cursor: href ? "pointer" : "default",
                  }}
                >
                  <button
                    type="button"
                    className="row-open"
                    aria-label={summarizeNotification(n)}
                    onClick={() => {
                      markRead(n)
                      if (href) navigate(href)
                    }}
                  />
                  <Bell
                    size={16}
                    strokeWidth={1.75}
                    style={{ marginRight: 12, color: n.read_at ? "var(--muted)" : "var(--brand)" }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14 }}>{summarizeNotification(n)}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{new Date(n.created_at).toLocaleString()}</div>
                  </div>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      remove(n)
                    }}
                    style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer" }}
                    aria-label="Dismiss"
                  >
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const formatSender = (m: api.Message): string => {
  if (m.kind === "system" || !m.from) return "Stohr (system)"
  return m.from.name ?? m.from.username ?? "Someone"
}

const MessagesView: React.FC<{ onChange: () => void }> = ({ onChange }) => {
  const [box, setBox] = useState<"inbox" | "sent" | "archived">("inbox")
  const [items, setItems] = useState<api.Message[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [sending, setSending] = useState(false)
  const [composing, setComposing] = useState(false)
  const [composeTo, setComposeTo] = useState("")
  const [composeSubject, setComposeSubject] = useState("")
  const [composeBody, setComposeBody] = useState("")
  const [composeErr, setComposeErr] = useState("")

  const refresh = async () => {
    setLoading(true)
    setError("")
    try {
      const data = await api.listMessages(box)
      if ((data as any).error) throw new Error((data as any).error)
      setItems(Array.isArray(data.messages) ? data.messages : [])
    } catch (e: any) {
      setError(e?.message ?? "Could not load this page. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
    onChange()
  }
  useEffect(() => {
    refresh()
  }, [box])

  const send = async () => {
    if (sending) return
    setComposeErr("")
    if (!composeTo.trim() || !composeSubject.trim() || !composeBody.trim()) {
      setComposeErr("Recipient, subject, and message are all required.")
      return
    }
    const to = composeTo.trim()
    const input = to.includes("@")
      ? { email: to, subject: composeSubject.trim(), body: composeBody.trim() }
      : { username: to.toLowerCase(), subject: composeSubject.trim(), body: composeBody.trim() }
    setSending(true)
    try {
      const res = await api.sendMessage(input)
      if ((res as any).error) {
        setComposeErr((res as any).error)
        return
      }
      setComposing(false)
      setComposeTo("")
      setComposeSubject("")
      setComposeBody("")
      if (box === "sent") refresh()
    } catch {
      setComposeErr("Could not send your message. Check your connection and try again.")
    } finally {
      setSending(false)
    }
  }

  const markRead = async (m: api.Message) => {
    if (m.read_at) return
    await api.markMessageRead(m.id)
    setItems(prev => prev.map(x => (x.id === m.id ? { ...x, read_at: new Date().toISOString() } : x)))
    onChange()
  }
  const archive = async (m: api.Message) => {
    await api.archiveMessage(m.id)
    refresh()
  }
  const unarchive = async (m: api.Message) => {
    await api.unarchiveMessage(m.id)
    refresh()
  }
  const remove = async (m: api.Message) => {
    if (!confirm("Delete this message?")) return
    await api.deleteMessage(m.id)
    refresh()
  }

  return (
    <div className="main">
      <div className="toolbar page-toolbar">
        <h2 className="page-title">Messages</h2>
        <div className="toolbar-actions">
          <button type="button" onClick={() => setBox("inbox")} className={box === "inbox" ? "primary" : undefined}>
            Inbox
          </button>
          <button type="button" onClick={() => setBox("sent")} className={box === "sent" ? "primary" : undefined}>
            Sent
          </button>
          <button
            type="button"
            onClick={() => setBox("archived")}
            className={box === "archived" ? "primary" : undefined}
          >
            Archived
          </button>
          <button type="button" onClick={() => setComposing(true)}>
            <Plus size={14} strokeWidth={1.75} /> New message
          </button>
        </div>
      </div>
      <div className="content">
        {error && (
          <div className="msg err" role="alert">
            {error}{" "}
            <button type="button" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {error ? null : loading ? (
          <div style={{ color: "var(--muted)" }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: "32px 0", color: "var(--muted)", textAlign: "center" }}>
            {box === "inbox" ? "Inbox is empty." : box === "sent" ? "Nothing sent." : "No archived messages."}
          </div>
        ) : (
          <div>
            {items.map(m => {
              const unread = !m.read_at && box === "inbox"
              const partyLabel = box === "sent" ? `to @${m.to.username ?? "?"}` : `from ${formatSender(m)}`
              return (
                <article
                  className="message-row"
                  key={m.id}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 6,
                    marginBottom: 4,
                    display: "flex",
                    alignItems: "center",
                    background: unread ? "var(--accent-bg)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <button
                    type="button"
                    className="row-open"
                    aria-label={`Open message ${m.subject}`}
                    onClick={() => {
                      markRead(m)
                      navigate(`/app/messages/thread/${m.thread_id}`)
                    }}
                  />
                  <Mail
                    size={16}
                    strokeWidth={1.75}
                    style={{ marginRight: 12, color: unread ? "var(--brand)" : "var(--muted)" }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: unread ? 600 : 400,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.subject}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      {partyLabel} · {new Date(m.created_at).toLocaleString()}
                    </div>
                  </div>
                  {box === "inbox" && (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation()
                        archive(m)
                      }}
                      title="Archive"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--muted)",
                        cursor: "pointer",
                        marginRight: 4,
                      }}
                    >
                      <Inbox size={14} strokeWidth={1.75} />
                    </button>
                  )}
                  {box === "archived" && (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation()
                        unarchive(m)
                      }}
                      title="Unarchive"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--muted)",
                        cursor: "pointer",
                        marginRight: 4,
                      }}
                    >
                      <ArrowRight size={14} strokeWidth={1.75} />
                    </button>
                  )}
                  {box !== "sent" && (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation()
                        remove(m)
                      }}
                      title="Delete"
                      style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer" }}
                    >
                      <X size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </article>
              )
            })}
          </div>
        )}

        {composing && (
          <Modal title="New message" onClose={() => setComposing(false)}>
            {composeErr && <div className="msg err">{composeErr}</div>}
            <input
              aria-label="To (username or email)"
              placeholder="To (username or email)"
              value={composeTo}
              onChange={e => setComposeTo(e.target.value)}
              autoFocus
            />
            <input
              aria-label="Subject"
              placeholder="Subject"
              value={composeSubject}
              onChange={e => setComposeSubject(e.target.value)}
            />
            <textarea
              aria-label="Message"
              placeholder="Message"
              rows={8}
              value={composeBody}
              onChange={e => setComposeBody(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setComposing(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={sending || !composeTo.trim() || !composeSubject.trim() || !composeBody.trim()}
                onClick={send}
              >
                {sending ? "Sending…" : "Send message"}
              </button>
            </div>
          </Modal>
        )}
      </div>
    </div>
  )
}

const MessageThreadView: React.FC<{ threadId: number; onChange: () => void }> = ({ threadId, onChange }) => {
  const [items, setItems] = useState<api.Message[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState("")
  const [replyBody, setReplyBody] = useState("")
  const [sending, setSending] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setErr("")
    try {
      const data = await api.messageThread(threadId)
      if ((data as any).error) {
        setErr((data as any).error)
        return
      }
      setItems(Array.isArray(data.messages) ? data.messages : [])
    } finally {
      setLoading(false)
    }
    onChange()
  }
  useEffect(() => {
    refresh()
  }, [threadId])

  const reply = async () => {
    const last = items[items.length - 1]
    if (!last || !replyBody.trim()) return
    setSending(true)
    try {
      const res = await api.replyMessage(last.id, replyBody.trim())
      if ((res as any).error) {
        setErr((res as any).error)
        return
      }
      setReplyBody("")
      await refresh()
    } finally {
      setSending(false)
    }
  }

  const last = items[items.length - 1]
  const canReply = last && last.kind !== "system" && !!last.from

  if (err)
    return (
      <div className="main">
        <div className="content">
          <div className="msg err">{err}</div>
        </div>
      </div>
    )
  if (loading && items.length === 0)
    return (
      <div className="main">
        <div className="content">
          <div style={{ color: "var(--muted)" }}>Loading…</div>
        </div>
      </div>
    )
  if (items.length === 0)
    return (
      <div className="main">
        <div className="content">
          <div style={{ color: "var(--muted)" }}>Thread is empty or unavailable.</div>
        </div>
      </div>
    )

  return (
    <div className="main">
      <div className="content">
        <div style={{ marginBottom: 8 }}>
          <button type="button" className="crumb" onClick={() => navigate("/app/messages")}>
            <ArrowLeft size={14} /> Messages
          </button>
        </div>
        <h2 style={{ margin: "0 0 16px" }}>{items[0]!.subject}</h2>
        <div>
          {items.map(m => (
            <div
              key={m.id}
              style={{
                padding: 12,
                borderRadius: 6,
                marginBottom: 8,
                background: "var(--panel-elev)",
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <strong>{formatSender(m)}</strong>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{new Date(m.created_at).toLocaleString()}</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
            </div>
          ))}
        </div>
        {canReply ? (
          <div style={{ marginTop: 16 }}>
            <textarea
              aria-label="Reply…"
              placeholder="Reply…"
              rows={4}
              value={replyBody}
              onChange={e => setReplyBody(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <button type="button" className="primary" onClick={reply} disabled={sending || !replyBody.trim()}>
              {sending ? "Sending…" : "Reply"}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 16, color: "var(--muted)", fontSize: 13 }}>Cannot reply to a system message.</div>
        )}
      </div>
    </div>
  )
}

const SpacesListView: React.FC = () => {
  const [spaces, setSpaces] = useState<api.Space[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [err, setErr] = useState("")

  const refresh = async () => {
    setLoading(true)
    try {
      const data = await api.listSpaces()
      if ((data as any).error) throw new Error((data as any).error)
      setSpaces(Array.isArray(data.spaces) ? data.spaces : [])
      setErr("")
    } catch (e: any) {
      setErr(e?.message ?? "Could not load spaces. Try again.")
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    refresh()
  }, [])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setErr("")
    try {
      const res = await api.createSpace({ name: trimmed, description: description.trim() || undefined })
      if ((res as any).error) return setErr((res as any).error)
      setName("")
      setDescription("")
      setCreating(false)
      await refresh()
    } catch {
      setErr("Could not create the space. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="main">
      <div className="toolbar page-toolbar">
        <h2 className="page-title">Spaces</h2>
        <button
          type="button"
          className="primary"
          onClick={() => {
            setErr("")
            setCreating(true)
          }}
        >
          <Plus size={14} strokeWidth={1.75} /> New space
        </button>
      </div>
      <div className="content">
        <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
          Create a shared workspace for a project, department, or campaign. Members get access to its folders and files.
        </div>
        {err && !creating && (
          <div className="msg err" role="alert">
            {err}{" "}
            <button type="button" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {loading ? (
          <div style={{ color: "var(--muted)" }}>Loading…</div>
        ) : err ? null : spaces.length === 0 ? (
          <div style={{ padding: "32px 0", color: "var(--muted)", textAlign: "center" }}>
            No spaces yet. Create one for your team’s shared files.
          </div>
        ) : (
          <div className="spaces-grid">
            {spaces.map(s => (
              <button type="button" key={s.id} className="space-card" onClick={() => navigate(`/app/spaces/${s.id}`)}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  <Briefcase size={14} strokeWidth={1.75} style={{ marginRight: 6, verticalAlign: -2 }} />
                  {s.name}
                </div>
                {s.description && (
                  <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>{s.description}</div>
                )}
                <div className="space-role">
                  {s.my_role === "admin" ? "Space admin" : s.my_role === "editor" ? "Can edit" : "View only"}
                </div>
              </button>
            ))}
          </div>
        )}

        {creating && (
          <Modal title="Create a space" onClose={() => setCreating(false)}>
            {err && (
              <div className="msg err" role="alert">
                {err}
              </div>
            )}
            <input
              aria-label="Space name"
              placeholder="Space name"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
            <textarea
              aria-label="Description (optional)"
              placeholder="Description (optional)"
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={create} disabled={busy || !name.trim()}>
                {busy ? "Creating…" : "Create space"}
              </button>
            </div>
          </Modal>
        )}
      </div>
    </div>
  )
}

const SpaceView: React.FC<{ id: number }> = ({ id }) => {
  const [space, setSpace] = useState<api.Space | null>(null)
  const [folders, setFolders] = useState<Array<{ id: number; name: string; created_at: string }>>([])
  const [members, setMembers] = useState<api.SpaceMember[]>([])
  const [tab, setTab] = useState<"folders" | "members">("folders")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [addingMember, setAddingMember] = useState(false)
  const [memberIdentity, setMemberIdentity] = useState("")
  const [memberRole, setMemberRole] = useState<api.SpaceRole>("editor")

  const refresh = async () => {
    setErr("")
    try {
      const [s, f, m] = await Promise.all([api.getSpace(id), api.listSpaceFolders(id), api.listSpaceMembers(id)])
      if ((s as any).error) {
        setErr((s as any).error)
        return
      }
      setSpace(s)
      setFolders(Array.isArray(f.folders) ? f.folders : [])
      setMembers(Array.isArray(m.members) ? m.members : [])
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load space")
    }
  }
  useEffect(() => {
    refresh()
  }, [id])

  if (err && !space)
    return (
      <div className="main">
        <div className="content">
          <div className="msg err" role="alert">
            {err}
          </div>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      </div>
    )
  if (!space)
    return (
      <div className="main">
        <div className="content">
          <div style={{ color: "var(--muted)" }}>Loading…</div>
        </div>
      </div>
    )

  const isAdmin = space.my_role === "admin"
  const canEdit = isAdmin || space.my_role === "editor"

  const createFolder = async () => {
    if (busy) return
    setBusy(true)
    setErr("")
    try {
      const trimmed = newFolderName.trim()
      if (!trimmed) return
      const res = await api.createSpaceFolder(id, trimmed)
      if ((res as any).error) {
        setErr((res as any).error)
        return
      }
      setNewFolderName("")
      setCreatingFolder(false)
      await refresh()
    } catch {
      setErr("Could not create the folder. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const addMember = async () => {
    if (busy) return
    setBusy(true)
    setErr("")
    try {
      const ident = memberIdentity.trim()
      if (!ident) return
      const input = ident.includes("@")
        ? { email: ident, role: memberRole }
        : { username: ident.toLowerCase(), role: memberRole }
      const res = await api.addSpaceMember(id, input)
      if ((res as any).error) {
        setErr((res as any).error)
        return
      }
      setMemberIdentity("")
      setAddingMember(false)
      await refresh()
    } catch {
      setErr("Could not add the member. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (m: api.SpaceMember) => {
    if (busy) return
    setBusy(true)
    setErr("")
    try {
      if (!confirm(`Remove ${m.user.name ?? m.user.username} from this space?`)) return
      const res = await api.removeSpaceMember(id, m.id)
      if (res.error) return setErr(res.error)
      await refresh()
    } catch {
      setErr("Could not remove the member. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (m: api.SpaceMember, role: api.SpaceRole) => {
    if (busy) return
    setBusy(true)
    setErr("")
    try {
      const res = await api.updateSpaceMember(id, m.id, role)
      if (res.error) return setErr(res.error)
      await refresh()
    } catch {
      setErr("Could not update access. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="main">
      <div className="toolbar">
        <h2 className="page-title">{space.name}</h2>
      </div>
      <div className="content">
        {err && (
          <div className="msg err" role="alert">
            {err}
          </div>
        )}
        <div style={{ marginBottom: 8 }}>
          <button type="button" className="crumb" onClick={() => navigate("/app/spaces")}>
            <ArrowLeft size={14} /> Spaces
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            {space.description && <div style={{ color: "var(--muted)", marginTop: 4 }}>{space.description}</div>}
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              {space.my_role === "admin" ? "Space admin" : space.my_role === "editor" ? "Can edit" : "View-only access"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, borderBottom: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={() => setTab("folders")}
            style={{
              background: "transparent",
              border: "none",
              padding: "8px 12px",
              borderBottom: tab === "folders" ? "2px solid var(--brand)" : "2px solid transparent",
              cursor: "pointer",
              color: tab === "folders" ? "var(--brand)" : "var(--text)",
            }}
          >
            Folders
          </button>
          <button
            type="button"
            onClick={() => setTab("members")}
            style={{
              background: "transparent",
              border: "none",
              padding: "8px 12px",
              borderBottom: tab === "members" ? "2px solid var(--brand)" : "2px solid transparent",
              cursor: "pointer",
              color: tab === "members" ? "var(--brand)" : "var(--text)",
            }}
          >
            Members ({members.length})
          </button>
        </div>

        {tab === "folders" && (
          <>
            {canEdit && (
              <div style={{ marginBottom: 12 }}>
                {creatingFolder ? (
                  <div className="inline-form">
                    <input
                      aria-label="Folder name"
                      autoFocus
                      placeholder="Folder name"
                      value={newFolderName}
                      onChange={e => setNewFolderName(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && createFolder()}
                    />
                    <button
                      type="button"
                      className="primary"
                      onClick={createFolder}
                      disabled={busy || !newFolderName.trim()}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCreatingFolder(false)
                        setNewFolderName("")
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setCreatingFolder(true)}>
                    <FolderPlus size={14} strokeWidth={1.75} /> New folder
                  </button>
                )}
              </div>
            )}
            {folders.length === 0 ? (
              <div style={{ padding: "24px 0", color: "var(--muted)" }}>
                {canEdit
                  ? "No folders yet. Create a folder to start organizing shared files."
                  : "No folders yet. A space editor can add folders here."}
              </div>
            ) : (
              <div>
                {folders.map(f => (
                  <button
                    type="button"
                    key={f.id}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 6,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                    }}
                    className="picker-row"
                    aria-label={`Open folder ${f.name}`}
                    onClick={() => navigate(`/app/f/${f.id}`)}
                  >
                    <FolderIcon size={16} strokeWidth={1.5} />
                    <span style={{ marginLeft: 8 }}>{f.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "members" && (
          <>
            {isAdmin && (
              <div style={{ marginBottom: 12 }}>
                {addingMember ? (
                  <div className="inline-form">
                    <input
                      aria-label="username or email"
                      autoFocus
                      placeholder="username or email"
                      value={memberIdentity}
                      onChange={e => setMemberIdentity(e.target.value)}
                    />
                    <select
                      aria-label="New member access"
                      value={memberRole}
                      onChange={e => setMemberRole(e.target.value as api.SpaceRole)}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      type="button"
                      className="primary"
                      onClick={addMember}
                      disabled={busy || !memberIdentity.trim()}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingMember(false)
                        setMemberIdentity("")
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setAddingMember(true)}>
                    <UserPlus size={14} strokeWidth={1.75} /> Add member
                  </button>
                )}
              </div>
            )}
            <div>
              {members.map(m => (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "8px 12px",
                    borderRadius: 6,
                    marginBottom: 4,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div>{m.user.name ?? m.user.username}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>
                      @{m.user.username} · {m.user.email}
                    </div>
                  </div>
                  {isAdmin && m.user.id !== space.owner_id ? (
                    <>
                      <select
                        aria-label={`Access for ${m.user.name ?? m.user.username}`}
                        disabled={busy}
                        value={m.role}
                        onChange={e => changeRole(m, e.target.value as api.SpaceRole)}
                        style={{ marginRight: 8 }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeMember(m)}
                        aria-label={`Remove ${m.user.name ?? m.user.username}`}
                        style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer" }}
                      >
                        <X size={14} strokeWidth={1.75} />
                      </button>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>
                      {m.user.id === space.owner_id ? "owner" : m.role}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const Shell: React.FC<{ onLogout: () => void; route: Route }> = ({ onLogout, route }) => {
  const [folderSpaceId, setFolderSpaceId] = useState<number | null>(null)
  const [userSnapshot, setUserSnapshot] = useState(api.getUser())
  // the login response has no team fields; /me does
  useEffect(() => {
    api.refreshMe().then(u => {
      if (u) setUserSnapshot(u)
    })
  }, [])
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"
    } catch {
      return false
    }
  })
  const [helpOpen, setHelpOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const helpRef = useRef<HTMLDivElement>(null)

  // The off-canvas nav drawer closes on any route change (covers nav taps,
  // breadcrumb jumps, and browser back) and on Escape.
  useEffect(() => {
    setMobileNavOpen(false)
  }, [route])
  useEffect(() => {
    if (!mobileNavOpen) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false)
    }
    document.addEventListener("keydown", onEsc)
    return () => document.removeEventListener("keydown", onEsc)
  }, [mobileNavOpen])

  useEffect(() => {
    if (!helpOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!helpRef.current) return
      if (!helpRef.current.contains(e.target as Node)) setHelpOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("mousedown", onDocClick)
      document.removeEventListener("keydown", onEsc)
    }
  }, [helpOpen])

  const toggleCollapsed = () => {
    setCollapsed(v => {
      const next = !v
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0")
      } catch {}
      return next
    })
  }

  const activeTab:
    | "files"
    | "shared"
    | "links"
    | "actions"
    | "trash"
    | "notifications"
    | "messages"
    | "spaces"
    | "settings"
    | "team"
    | "admin" = (() => {
    if (route.kind === "shared") return "shared"
    if (route.kind === "links") return "links"
    if (route.kind === "actions" || route.kind === "actionEdit") return "actions"
    if (route.kind === "trash") return "trash"
    if (route.kind === "notifications") return "notifications"
    if (route.kind === "messages" || route.kind === "messageThread") return "messages"
    if (route.kind === "spaces" || route.kind === "space") return "spaces"
    if (route.kind === "settings") return "settings"
    if (route.kind === "team") return "team"
    if (route.kind === "admin") return "admin"
    return "files"
  })()

  const [unreadNotif, setUnreadNotif] = useState(0)
  const [unreadMsg, setUnreadMsg] = useState(0)
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      api
        .unreadNotificationCount()
        .then(r => {
          if (!cancelled) setUnreadNotif(r.unread)
        })
        .catch(() => {})
      api
        .unreadMessageCount()
        .then(r => {
          if (!cancelled) setUnreadMsg(r.unread)
        })
        .catch(() => {})
    }
    refresh()
    const t = setInterval(refresh, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [activeTab])

  const initial = (userSnapshot?.name?.[0] ?? userSnapshot?.username?.[0] ?? "?").toUpperCase()

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}${mobileNavOpen ? " mobile-open" : ""}`}>
      <button
        type="button"
        className="mobile-nav-toggle"
        onClick={() => setMobileNavOpen(v => !v)}
        aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={mobileNavOpen}
        aria-controls="stohr-navigation"
      >
        {mobileNavOpen ? <X size={20} strokeWidth={1.75} /> : <Menu size={20} strokeWidth={1.75} />}
      </button>
      <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
      <aside id="stohr-navigation" className="sidebar" aria-label="Main navigation">
        <div className="sidebar-head">
          <div className="brand">
            <Logo />
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <PanelLeft size={16} strokeWidth={1.75} />
          </button>
        </div>
        {/* only on a team host: the root team is just "Stohr" */}
        {userSnapshot?.team && userSnapshot.is_root === false && (
          <div className="sidebar-team" title={`Team ${userSnapshot.team.slug}`}>
            <UsersRound size={14} strokeWidth={1.75} />
            <span className="nav-label">{userSnapshot.team.name}</span>
          </div>
        )}
        <button
          type="button"
          className={`nav${activeTab === "files" && !folderSpaceId ? " active" : ""}`}
          aria-current={activeTab === "files" && !folderSpaceId ? "page" : undefined}
          onClick={() => navigate("/")}
          title="My files"
        >
          <FolderOpen size={18} strokeWidth={1.75} /> <span className="nav-label">My files</span>
        </button>
        <button
          type="button"
          className={`nav${activeTab === "shared" ? " active" : ""}`}
          aria-current={activeTab === "shared" ? "page" : undefined}
          onClick={() => navigate("/app/shared")}
          title="Shared with me"
        >
          <Users size={18} strokeWidth={1.75} /> <span className="nav-label">Shared with me</span>
        </button>
        <button
          type="button"
          className={`nav${activeTab === "spaces" || (activeTab === "files" && folderSpaceId != null) ? " active" : ""}`}
          aria-current={activeTab === "spaces" || (activeTab === "files" && folderSpaceId != null) ? "page" : undefined}
          onClick={() => navigate("/app/spaces")}
          title="Spaces"
        >
          <Briefcase size={18} strokeWidth={1.75} /> <span className="nav-label">Spaces</span>
        </button>
        <button
          type="button"
          className={`nav${activeTab === "links" ? " active" : ""}`}
          aria-current={activeTab === "links" ? "page" : undefined}
          onClick={() => navigate("/app/links")}
          title="Public links"
        >
          <Link2 size={18} strokeWidth={1.75} /> <span className="nav-label">Public links</span>
        </button>
        <button
          type="button"
          className={`nav${activeTab === "actions" ? " active" : ""}`}
          aria-current={activeTab === "actions" ? "page" : undefined}
          onClick={() => navigate("/app/actions")}
          title="Automations"
        >
          <Zap size={18} strokeWidth={1.75} /> <span className="nav-label">Automations</span>
        </button>
        <button
          type="button"
          className={`nav${activeTab === "trash" ? " active" : ""}`}
          aria-current={activeTab === "trash" ? "page" : undefined}
          onClick={() => navigate("/app/trash")}
          title="Trash"
        >
          <Trash2 size={18} strokeWidth={1.75} /> <span className="nav-label">Trash</span>
        </button>
        <button
          type="button"
          className={`nav${activeTab === "notifications" ? " active" : ""}`}
          aria-current={activeTab === "notifications" ? "page" : undefined}
          onClick={() => navigate("/app/notifications")}
          title="Notifications"
        >
          <Bell size={18} strokeWidth={1.75} /> <span className="nav-label">Notifications</span>
          {unreadNotif > 0 && (
            <span
              style={{
                marginLeft: "auto",
                background: "var(--brand)",
                color: "var(--brand-fg)",
                borderRadius: 10,
                fontSize: 11,
                padding: "0 6px",
                minWidth: 18,
                textAlign: "center",
              }}
            >
              {unreadNotif > 99 ? "99+" : unreadNotif}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`nav${activeTab === "messages" ? " active" : ""}`}
          aria-current={activeTab === "messages" ? "page" : undefined}
          onClick={() => navigate("/app/messages")}
          title="Messages"
        >
          <Mail size={18} strokeWidth={1.75} /> <span className="nav-label">Messages</span>
          {unreadMsg > 0 && (
            <span
              style={{
                marginLeft: "auto",
                background: "var(--brand)",
                color: "var(--brand-fg)",
                borderRadius: 10,
                fontSize: 11,
                padding: "0 6px",
                minWidth: 18,
                textAlign: "center",
              }}
            >
              {unreadMsg > 99 ? "99+" : unreadMsg}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`nav${activeTab === "settings" ? " active" : ""}`}
          aria-current={activeTab === "settings" ? "page" : undefined}
          onClick={() => navigate("/app/settings")}
          title="Settings"
        >
          <SettingsIcon size={18} strokeWidth={1.75} /> <span className="nav-label">Settings</span>
        </button>
        {/* the owner already has all of this under Admin */}
        {userSnapshot?.team_admin && !userSnapshot.is_owner && (
          <button
            type="button"
            className={`nav${activeTab === "team" ? " active" : ""}`}
            aria-current={activeTab === "team" ? "page" : undefined}
            onClick={() => navigate("/app/team")}
            title="Team"
          >
            <ShieldCheck size={18} strokeWidth={1.75} /> <span className="nav-label">Team</span>
          </button>
        )}
        {userSnapshot?.is_owner && (
          <button
            type="button"
            className={`nav${activeTab === "admin" ? " active" : ""}`}
            aria-current={activeTab === "admin" ? "page" : undefined}
            onClick={() => navigate("/app/admin")}
            title="Admin"
          >
            <AlertTriangle size={18} strokeWidth={1.75} /> <span className="nav-label">Admin</span>
          </button>
        )}
        <div className="help-wrap" ref={helpRef}>
          <button
            type="button"
            className={`nav${helpOpen ? " active" : ""}`}
            onClick={() => setHelpOpen(v => !v)}
            title="Help & resources"
            aria-haspopup="menu"
            aria-expanded={helpOpen}
          >
            <HelpCircle size={18} strokeWidth={1.75} /> <span className="nav-label">Help</span>
          </button>
          {helpOpen && (
            <div className="help-menu" role="menu">
              <a href="https://github.com/wess/stohr/tree/main/docs" target="_blank" rel="noreferrer" role="menuitem">
                <BookOpen size={14} strokeWidth={1.75} />
                <div className="help-menu-text">
                  <div className="help-menu-title">Documentation</div>
                  <div className="help-menu-sub">Architecture, deploy, OAuth, actions</div>
                </div>
                <ExternalLink size={12} strokeWidth={1.75} className="help-menu-ext" />
              </a>
              {/* the contact form is reviewed on the root host only */}
              {userSnapshot?.is_root !== false && (
                <a href="/contact" target="_blank" rel="noreferrer" role="menuitem">
                  <MessageSquare size={14} strokeWidth={1.75} />
                  <div className="help-menu-text">
                    <div className="help-menu-title">Contact us</div>
                    <div className="help-menu-sub">Bugs, feature requests, questions</div>
                  </div>
                  <ExternalLink size={12} strokeWidth={1.75} className="help-menu-ext" />
                </a>
              )}
              <a href="https://github.com/wess/stohr" target="_blank" rel="noreferrer" role="menuitem">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.33.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.59.23 2.76.11 3.05.74.8 1.18 1.82 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
                </svg>
                <div className="help-menu-text">
                  <div className="help-menu-title">GitHub</div>
                  <div className="help-menu-sub">Source, issues, releases</div>
                </div>
                <ExternalLink size={12} strokeWidth={1.75} className="help-menu-ext" />
              </a>
            </div>
          )}
        </div>
        <div className="user-footer">
          <div className="user-avatar" aria-hidden="true">
            {initial}
          </div>
          <div className="user-meta">
            <div className="who">{userSnapshot?.name ?? ""}</div>
            <div className="who muted">@{userSnapshot?.username ?? ""}</div>
            <button type="button" className="logout" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
      {activeTab === "files" && (
        <Files
          onSpaceChange={setFolderSpaceId}
          routeFolderId={route.kind === "folder" ? route.id : null}
          routeFileId={route.kind === "file" ? route.id : null}
        />
      )}
      {activeTab === "shared" && <SharedView />}
      {activeTab === "links" && <SharesView />}
      {activeTab === "actions" && route.kind === "actions" && <ActionsListView />}
      {activeTab === "actions" && route.kind === "actionEdit" && <ActionEditView id={route.id} />}
      {activeTab === "trash" && <TrashView />}
      {activeTab === "notifications" && (
        <NotificationsView
          onChange={() =>
            api
              .unreadNotificationCount()
              .then(r => setUnreadNotif(r.unread))
              .catch(() => {})
          }
        />
      )}
      {activeTab === "spaces" && route.kind === "spaces" && <SpacesListView />}
      {activeTab === "spaces" && route.kind === "space" && <SpaceView id={route.id} />}
      {activeTab === "messages" && route.kind === "messages" && (
        <MessagesView
          onChange={() =>
            api
              .unreadMessageCount()
              .then(r => setUnreadMsg(r.unread))
              .catch(() => {})
          }
        />
      )}
      {activeTab === "messages" && route.kind === "messageThread" && (
        <MessageThreadView
          threadId={route.threadId}
          onChange={() =>
            api
              .unreadMessageCount()
              .then(r => setUnreadMsg(r.unread))
              .catch(() => {})
          }
        />
      )}
      {activeTab === "settings" && (
        <Settings onProfileUpdate={() => setUserSnapshot(api.getUser())} onAccountDeleted={onLogout} />
      )}
      {activeTab === "team" && route.kind === "team" && <TeamView section={route.section} />}
      {activeTab === "admin" && route.kind === "admin" && <AdminView section={route.section} />}
    </div>
  )
}

type Usage = {
  quota_bytes: number
  used_bytes: number
  active_bytes: number
  trash_bytes: number
  version_bytes: number
}

const UsagePanel: React.FC = () => {
  const [usage, setUsage] = useState<Usage | null>(null)

  const load = async () => {
    const data = await api.getMyUsage()
    if (!data.error) setUsage(data)
  }
  useEffect(() => {
    load()
  }, [])

  if (!usage) {
    return (
      <section className="settings-card">
        <h3>Storage</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>Loading…</div>
      </section>
    )
  }

  const unlimited = usage.quota_bytes <= 0
  const pct = unlimited ? 0 : Math.min(100, (usage.used_bytes / usage.quota_bytes) * 100)

  return (
    <section className="settings-card">
      <h3>Storage</h3>
      <div className="sub-current">
        <div className="sub-tier-row">
          <div>
            <div className="sub-tier">{unlimited ? "No storage cap" : "Storage cap"}</div>
            <div className="sub-status">
              {unlimited ? "Bounded only by the server's disk." : "Cap set by the instance owner."}
            </div>
          </div>
          <div className="sub-usage-text">
            {formatBytes(usage.used_bytes)}
            <span style={{ color: "var(--muted)" }}>
              {unlimited ? " used" : ` of ${formatBytes(usage.quota_bytes)}`}
            </span>
          </div>
        </div>
        {!unlimited && (
          <div className="sub-bar">
            <div
              className="sub-fill"
              style={{ width: `${pct}%`, background: pct > 90 ? "var(--danger)" : "var(--brand)" }}
            />
          </div>
        )}
        <div className="sub-breakdown">
          <span>
            Active <strong>{formatBytes(usage.active_bytes)}</strong>
          </span>
          <span>
            Trash <strong>{formatBytes(usage.trash_bytes)}</strong>
          </span>
          <span>
            Versions <strong>{formatBytes(usage.version_bytes)}</strong>
          </span>
        </div>
      </div>
    </section>
  )
}

type S3Key = {
  id: number
  access_key: string
  secret_key?: string
  name: string | null
  created_at: string
  last_used_at: string | null
}

type App = {
  id: number
  name: string
  description: string | null
  token?: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
}

const S3KeysSection: React.FC = () => {
  const [keys, setKeys] = useState<S3Key[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  const [justCreated, setJustCreated] = useState<S3Key | null>(null)
  const [error, setError] = useState("")

  const load = async () => {
    const data = await api.listS3Keys()
    setKeys(Array.isArray(data) ? data : [])
  }
  useEffect(() => {
    load()
  }, [])

  const create = async () => {
    setBusy(true)
    setError("")
    const res = await api.createS3Key(newName.trim() || undefined)
    setBusy(false)
    if (res.error) return setError(res.error)
    setJustCreated(res as S3Key)
    setNewName("")
    setCreating(false)
    await load()
  }

  const revoke = async (id: number) => {
    if (!confirm("Revoke this access key? Anything using it will stop working immediately.")) return
    const res = await api.revokeS3Key(id)
    if (res.error) return alert(res.error)
    await load()
  }

  const me = api.getUser()
  const endpoint = window.location.origin + "/s3"

  return (
    <div className="devp-section">
      <h4>S3 access keys</h4>
      <div className="devp-section-desc">
        S3-compatible credentials for <code>aws-cli</code>, <code>boto3</code>, or any AWS SDK.
      </div>

      <div className="dev-config">
        <div className="dev-config-row">
          <span>Endpoint</span>
          <code>{endpoint}</code>
        </div>
        <div className="dev-config-row">
          <span>Bucket</span>
          <code>{me?.username ?? "—"}</code>
          <span className="dev-config-note">your username</span>
        </div>
        <div className="dev-config-row">
          <span>Region</span>
          <code>us-east-1</code>
          <span className="dev-config-note">any value works</span>
        </div>
      </div>

      {justCreated && (
        <div className="msg ok" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            New access key — save the secret now, it won't be shown again
          </div>
          <div className="dev-secret">
            <label>Access key</label>
            <div className="dev-secret-row">
              <code>{justCreated.access_key}</code>
              <button type="button" onClick={() => navigator.clipboard.writeText(justCreated.access_key)}>
                Copy
              </button>
            </div>
            <label>Secret key</label>
            <div className="dev-secret-row">
              <code>{justCreated.secret_key}</code>
              <button type="button" onClick={() => navigator.clipboard.writeText(justCreated.secret_key ?? "")}>
                Copy
              </button>
            </div>
          </div>
          <button type="button" onClick={() => setJustCreated(null)} style={{ marginTop: 8 }}>
            I've saved it
          </button>
        </div>
      )}

      {creating && !justCreated && (
        <div className="dev-create">
          <label htmlFor="s3keyssection-name">
            Name <span className="lp-field-opt">(optional, e.g. "laptop")</span>
          </label>
          <input
            id="s3keyssection-name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="What's this key for?"
            autoFocus
          />
          {error && (
            <div className="msg err" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
          <div className="settings-actions">
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setNewName("")
              }}
            >
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy} onClick={create}>
              {busy ? "Creating…" : "Create key"}
            </button>
          </div>
        </div>
      )}

      {!creating && !justCreated && (
        <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <UserPlus size={14} /> <span>New access key</span>
          </button>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="dev-empty">No access keys yet.</div>
      ) : (
        <div className="dev-list">
          {keys.map(k => (
            <div key={k.id} className="dev-row">
              <div className="dev-row-main">
                <div className="dev-row-line">
                  <code>{k.access_key}</code>
                  {k.name && <span className="dev-row-name">{k.name}</span>}
                </div>
                <div className="dev-row-meta">
                  Created {new Date(k.created_at).toLocaleDateString()}
                  {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}` : " · never used"}
                </div>
              </div>
              <button type="button" className="danger" onClick={() => revoke(k.id)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const AppsSection: React.FC = () => {
  const [apps, setApps] = useState<App[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDesc, setNewDesc] = useState("")
  const [busy, setBusy] = useState(false)
  const [justCreated, setJustCreated] = useState<App | null>(null)
  const [error, setError] = useState("")

  const load = async () => {
    const data = await api.listApps()
    setApps(Array.isArray(data) ? data : [])
  }
  useEffect(() => {
    load()
  }, [])

  const create = async () => {
    if (!newName.trim()) return setError("Name is required")
    setBusy(true)
    setError("")
    const res = await api.createApp(newName.trim(), newDesc.trim() || undefined)
    setBusy(false)
    if (res.error) return setError(res.error)
    setJustCreated(res as App)
    setNewName("")
    setNewDesc("")
    setCreating(false)
    await load()
  }

  const revoke = async (id: number) => {
    if (!confirm("Revoke this app token? Anything using it will stop working immediately.")) return
    const res = await api.revokeApp(id)
    if (res.error) return alert(res.error)
    await load()
  }

  return (
    <div className="devp-section">
      <h4>Apps</h4>
      <div className="devp-section-desc">
        Personal access tokens for SDKs, mobile apps, and scripts. Use <code>Authorization: Bearer &lt;token&gt;</code>{" "}
        against any API endpoint.
      </div>

      {justCreated?.token && (
        <div className="msg ok" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>New app token — save it now, it won't be shown again</div>
          <div className="dev-secret">
            <label>{justCreated.name}</label>
            <div className="dev-secret-row">
              <code>{justCreated.token}</code>
              <button type="button" onClick={() => navigator.clipboard.writeText(justCreated.token ?? "")}>
                Copy
              </button>
            </div>
          </div>
          <button type="button" onClick={() => setJustCreated(null)} style={{ marginTop: 8 }}>
            I've saved it
          </button>
        </div>
      )}

      {creating && !justCreated && (
        <div className="dev-create">
          <label htmlFor="appssection-name">Name</label>
          <input
            id="appssection-name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="e.g. Flutter app, CI bot"
            autoFocus
          />
          <label htmlFor="appssection-description" style={{ marginTop: 8 }}>
            Description <span className="lp-field-opt">(optional)</span>
          </label>
          <input
            id="appssection-description"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            placeholder="What's this app for?"
          />
          {error && (
            <div className="msg err" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
          <div className="settings-actions">
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setNewName("")
                setNewDesc("")
                setError("")
              }}
            >
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy} onClick={create}>
              {busy ? "Creating…" : "Create app"}
            </button>
          </div>
        </div>
      )}

      {!creating && !justCreated && (
        <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <Smartphone size={14} /> <span>Register new app</span>
          </button>
        </div>
      )}

      {apps.length === 0 ? (
        <div className="dev-empty">No apps yet.</div>
      ) : (
        <div className="dev-list">
          {apps.map(a => (
            <div key={a.id} className="dev-row">
              <div className="dev-row-main">
                <div className="dev-row-line">
                  <span className="dev-row-name">{a.name}</span>
                  <code>{a.token_prefix}…</code>
                </div>
                {a.description && <div className="dev-row-desc">{a.description}</div>}
                <div className="dev-row-meta">
                  Created {new Date(a.created_at).toLocaleDateString()}
                  {a.last_used_at ? ` · last used ${new Date(a.last_used_at).toLocaleDateString()}` : " · never used"}
                </div>
              </div>
              <button type="button" className="danger" onClick={() => revoke(a.id)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const DeveloperPanel: React.FC = () => {
  const me = api.getUser()
  return (
    <section className="settings-card">
      <h3>Developer</h3>
      <S3KeysSection />
      <AppsSection />
      <WebdavSection />
      {/* oauth client registration is an instance-level surface: root host only */}
      {me?.is_owner && me.is_root !== false && <OAuthClientsSection />}
    </section>
  )
}

const WebdavSection: React.FC = () => {
  const [status, setStatus] = useState<api.WebdavStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justMinted, setJustMinted] = useState<string | null>(null)
  const [instanceDisabled, setInstanceDisabled] = useState(false)

  const load = async () => {
    setError(null)
    try {
      const s = await api.getWebdav()
      setStatus(s)
      setInstanceDisabled(false)
    } catch (e: any) {
      const msg = e?.message ?? "Failed to load WebDAV settings"
      // 503 from the gate ⇒ owner has WebDAV turned off on this instance
      if (/disabled on this instance/i.test(msg)) setInstanceDisabled(true)
      else setError(msg)
      setStatus(null)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const mint = async () => {
    if (
      status?.enabled &&
      !confirm("Generate a new WebDAV password? Any client using the current one will stop working until reconfigured.")
    )
      return
    setBusy(true)
    setError(null)
    try {
      const res = await api.enableWebdav()
      if (res.password) setJustMinted(res.password)
      await load()
    } catch (e: any) {
      setError(e?.message ?? "Failed to mint WebDAV password")
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (!confirm("Disable WebDAV for your account? Clients using your current password will stop working immediately."))
      return
    setBusy(true)
    setError(null)
    try {
      await api.disableWebdav()
      setJustMinted(null)
      await load()
    } catch (e: any) {
      setError(e?.message ?? "Failed to disable WebDAV")
    } finally {
      setBusy(false)
    }
  }

  // Build a sensible default mount URL. The web SPA is on `WEB_PORT` but
  // WebDAV is served by the API directly. Heuristically, the public URL
  // users mount is the same origin they're hitting the SPA on (the SPA
  // proxies /webdav through to the API).
  const me = api.getUser()
  const mountUrl = (() => {
    if (typeof window === "undefined") return "https://your-stohr.example.com/webdav"
    return `${window.location.origin}/webdav`
  })()

  return (
    <div className="devp-section">
      <h4>WebDAV</h4>
      <div className="devp-section-desc">
        Mount your Stohr account as a network drive from macOS Finder, Windows Explorer, GNOME Files, or{" "}
        <code>rclone</code>. The password below is separate from your account password and can be revoked any time.
      </div>

      {instanceDisabled && (
        <div className="msg err" style={{ marginTop: 12 }}>
          The instance owner has WebDAV turned off on this server. Ask them to enable it in{" "}
          <strong>Admin → Settings</strong>.
        </div>
      )}

      {!instanceDisabled && justMinted && (
        <div className="msg ok" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Your new WebDAV password — save it now, it won't be shown again
          </div>
          <div className="dev-secret">
            <label>Password</label>
            <div className="dev-secret-row">
              <code>{justMinted}</code>
              <button type="button" onClick={() => navigator.clipboard.writeText(justMinted)}>
                Copy
              </button>
            </div>
          </div>
          <button type="button" onClick={() => setJustMinted(null)} style={{ marginTop: 8 }}>
            I've saved it
          </button>
        </div>
      )}

      {!instanceDisabled && status && (
        <>
          <div className="webdav-status">
            <div className="webdav-status-row">
              <span className="webdav-status-label">Status</span>
              <span className={status.enabled ? "webdav-status-on" : "webdav-status-off"}>
                {status.enabled ? "Enabled" : "Not enabled"}
              </span>
            </div>
            {status.last_used_at && (
              <div className="webdav-status-row">
                <span className="webdav-status-label">Last used</span>
                <span>{new Date(status.last_used_at).toLocaleString()}</span>
              </div>
            )}
            {status.updated_at && (
              <div className="webdav-status-row">
                <span className="webdav-status-label">Last password change</span>
                <span>{new Date(status.updated_at).toLocaleString()}</span>
              </div>
            )}
          </div>

          {error && (
            <div className="msg err" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}

          <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12, gap: 8 }}>
            <button type="button" className="primary" disabled={busy} onClick={mint}>
              {status.enabled ? "Regenerate password" : "Enable WebDAV"}
            </button>
            {status.enabled && (
              <button type="button" disabled={busy} onClick={disable}>
                Disable
              </button>
            )}
          </div>

          {status.enabled && (
            <div className="webdav-howto">
              <div className="webdav-howto-title">Connect from macOS Finder</div>
              <ol>
                <li>
                  Open Finder, press <kbd>⌘K</kbd> (or <strong>Go → Connect to Server…</strong>).
                </li>
                <li>
                  Enter the server URL: <code>{mountUrl}</code>
                </li>
                <li>
                  Click <strong>Connect</strong>. When prompted, choose <strong>Registered User</strong>.
                </li>
                <li>
                  Username: <code>{me?.username ?? "<your-username>"}</code>
                </li>
                <li>
                  Password: the <code>stohr_dav_…</code> token above (use <strong>Regenerate password</strong> if you've
                  lost it).
                </li>
                <li>
                  Optional: check <strong>Remember this password in my keychain</strong>.
                </li>
              </ol>
              <div className="webdav-howto-foot">
                Other clients (Windows Explorer, GNOME Files, <code>rclone</code>) are covered in{" "}
                <a href="/docs/webdav" target="_blank" rel="noreferrer">
                  the WebDAV docs
                </a>
                .
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Federation

const formatGB = (bytes: number | string): string => {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return "0 GB"
  return `${(n / (1024 * 1024 * 1024)).toFixed(n < 1024 * 1024 * 1024 ? 2 : 1)} GB`
}

const GB_TO_BYTES = 1024 * 1024 * 1024

const FederationPanel: React.FC = () => {
  const [feds, setFeds] = useState<api.FederationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [disabled, setDisabled] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showAccept, setShowAccept] = useState(false)
  const [instance, setInstance] = useState<api.InstanceKeys | null>(null)

  // jsonReq doesn't throw on non-2xx — 503 responses come back as
  // `{ error: "..." }`. So a successful federation list is specifically an
  // array; anything else means the owner has the feature off (or some other
  // failure), and the tab should fall through to the disabled-state UI
  // rather than try to render keys/members we don't have.
  const isDisabledError = (payload: any): boolean =>
    payload &&
    typeof payload === "object" &&
    typeof payload.error === "string" &&
    /disabled on this instance/i.test(payload.error)

  const load = async () => {
    setError(null)
    try {
      const list = (await api.listFederations()) as unknown
      if (Array.isArray(list)) {
        setFeds(list as api.FederationSummary[])
        setDisabled(false)
        // Only fetch instance keys once we know the feature is on. The
        // /me/federations/instance/keys endpoint shares the same gate, so
        // calling it while disabled returns `{ error: "..." }` instead of
        // the real shape — which used to crash the render.
        try {
          const keys = (await api.getInstanceKeys()) as unknown as Partial<api.InstanceKeys> & { error?: string }
          if (keys && typeof keys === "object" && typeof keys.ed25519_pubkey === "string") {
            setInstance(keys as api.InstanceKeys)
          } else {
            setInstance(null)
          }
        } catch {
          setInstance(null)
        }
      } else if (isDisabledError(list)) {
        setDisabled(true)
        setFeds(null)
        setInstance(null)
      } else {
        setError((list as any)?.error ?? "Failed to load federations")
        setFeds(null)
        setInstance(null)
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load federations")
      setFeds(null)
      setInstance(null)
    }
  }

  useEffect(() => {
    load()
  }, [])

  if (disabled) {
    return (
      <div className="settings-card">
        <h3>Federation</h3>
        <p style={{ color: "var(--muted)", fontSize: 13.5, margin: "8px 0 0", lineHeight: 1.55 }}>
          Federation is turned off on this instance. Ask the owner to enable it in{" "}
          <strong>Admin → Settings → Federation</strong>.
        </p>
      </div>
    )
  }

  if (!feds) {
    return (
      <div className="settings-card">
        <h3>Federation</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>{error ?? "Loading…"}</div>
      </div>
    )
  }

  if (selected) {
    return (
      <FederationDetailView
        id={selected}
        onBack={() => {
          setSelected(null)
          load()
        }}
      />
    )
  }

  return (
    <div className="settings-card">
      <h3>Federation</h3>
      <p style={{ color: "var(--muted)", fontSize: 13.5, margin: "0 0 14px", lineHeight: 1.55 }}>
        Pair this Stohr instance with others in an invite-gated network. Members pool storage and (in content-sharing
        mode) can browse each other's files. See{" "}
        <a href="/docs/federation" target="_blank" rel="noreferrer">
          the docs
        </a>{" "}
        for the full model.
      </p>

      {instance && (
        <div className="fed-instance">
          <div className="fed-instance-row">
            <span className="fed-instance-label">This instance's pubkey</span>
            <code>{instance.ed25519_pubkey.slice(0, 16)}…</code>
          </div>
          <div className="fed-instance-hint">
            Share this fingerprint out-of-band with someone before they invite you, so they can verify you're the right
            peer.
          </div>
        </div>
      )}

      {error && (
        <div className="msg err" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="settings-actions" style={{ justifyContent: "flex-start", gap: 8, marginBottom: 16 }}>
        <button type="button" className="primary" onClick={() => setShowCreate(true)}>
          Create federation
        </button>
        <button type="button" onClick={() => setShowAccept(true)}>
          Accept invite
        </button>
      </div>

      {showCreate && (
        <CreateFederationForm
          onCancel={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            load()
          }}
        />
      )}

      {showAccept && (
        <AcceptInviteForm
          onCancel={() => setShowAccept(false)}
          onAccepted={() => {
            setShowAccept(false)
            load()
          }}
        />
      )}

      {feds.length === 0 ? (
        <div className="dev-empty">You're not a member of any federation yet.</div>
      ) : (
        <div className="fed-list">
          {feds.map(f => (
            <button type="button" key={f.id} className="fed-row" onClick={() => setSelected(f.id)}>
              <div className="fed-row-main">
                <div className="fed-row-name">
                  {f.name}
                  {f.local_member.is_admin && <span className="fed-pill fed-pill-admin">Admin</span>}
                  <span className={`fed-pill fed-pill-${f.type === "content-sharing" ? "csh" : "spo"}`}>
                    {f.type === "content-sharing" ? "Content-sharing" : "Space-offering"}
                  </span>
                  {f.local_member.status !== "active" && (
                    <span className="fed-pill fed-pill-warn">{f.local_member.status}</span>
                  )}
                </div>
                <div className="fed-row-meta">
                  <code>{f.slug}</code>
                  <span>·</span>
                  <span>Contributing {formatGB(f.local_member.contributed_bytes)}</span>
                  <span>·</span>
                  <span>Used {formatGB(f.local_member.used_bytes)}</span>
                </div>
              </div>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const CreateFederationForm: React.FC<{ onCancel: () => void; onCreated: () => void }> = ({ onCancel, onCreated }) => {
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [type, setType] = useState<api.FederationType>("content-sharing")
  const [replication, setReplication] = useState(3)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      const res: any = await api.createFederation({
        slug: slug.trim().toLowerCase(),
        name: name.trim(),
        description: description.trim() || undefined,
        type,
        replication_factor: replication,
      })
      if (res?.error) {
        setError(res.error)
        return
      }
      onCreated()
    } catch (e: any) {
      setError(e?.message ?? "Failed to create federation")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fed-form">
      <label htmlFor="createfederationform-slug">Slug</label>
      <input
        id="createfederationform-slug"
        value={slug}
        onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        placeholder="my-friends"
        autoCapitalize="off"
      />
      <div className="fed-form-hint">
        Lowercase letters, numbers, hyphens. Used internally to identify the federation across peers — can't change
        later.
      </div>

      <label htmlFor="createfederationform-name" style={{ marginTop: 10 }}>
        Name
      </label>
      <input
        id="createfederationform-name"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="My friends"
      />

      <label htmlFor="createfederationform-description" style={{ marginTop: 10 }}>
        Description <span className="lp-field-opt">(optional)</span>
      </label>
      <input
        id="createfederationform-description"
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="What's this federation for?"
      />

      <label style={{ marginTop: 10 }}>Type</label>
      <div className="fed-type-choice">
        <label className={type === "content-sharing" ? "active" : ""}>
          <input
            type="radio"
            name="fedtype"
            checked={type === "content-sharing"}
            onChange={() => setType("content-sharing")}
          />
          <div>
            <div className="fed-type-name">Content-sharing</div>
            <div className="fed-type-desc">
              Members can browse and copy each other's files. Encrypted at rest with a shared group key; full
              replication on N peers.
            </div>
          </div>
        </label>
        <label className={type === "space-offering" ? "active" : ""}>
          <input
            type="radio"
            name="fedtype"
            checked={type === "space-offering"}
            onChange={() => setType("space-offering")}
          />
          <div>
            <div className="fed-type-name">Space-offering</div>
            <div className="fed-type-desc">
              Pure capacity pooling. Peers host encrypted shards they can't read; only you can decrypt your own files.
            </div>
          </div>
        </label>
      </div>

      <label htmlFor="createfederationform-replication-factor" style={{ marginTop: 10 }}>
        Replication factor
      </label>
      <input
        id="createfederationform-replication-factor"
        type="number"
        min={1}
        max={16}
        value={replication}
        onChange={e => setReplication(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
      />
      <div className="fed-form-hint">
        How many peers hold each blob/shard. Higher = more durable, more storage cost. Default 3.
      </div>

      {error && (
        <div className="msg err" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <div className="settings-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={submit} disabled={busy || !slug || !name}>
          {busy ? "Creating…" : "Create federation"}
        </button>
      </div>
    </div>
  )
}

const AcceptInviteForm: React.FC<{ onCancel: () => void; onAccepted: () => void }> = ({ onCancel, onAccepted }) => {
  const [token, setToken] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      const res: any = await api.acceptFederationInvite(token.trim(), displayName.trim() || undefined)
      if (res?.error) {
        setError(res.error)
        return
      }
      onAccepted()
    } catch (e: any) {
      setError(e?.message ?? "Failed to accept invite")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fed-form">
      <label htmlFor="acceptinviteform-invite-token">Invite token</label>
      <textarea
        id="acceptinviteform-invite-token"
        value={token}
        onChange={e => setToken(e.target.value)}
        placeholder="Paste the invite token someone sent you (starts with eyJ…)"
        rows={4}
      />
      <label htmlFor="acceptinviteform-display-name" style={{ marginTop: 10 }}>
        Display name <span className="lp-field-opt">(optional)</span>
      </label>
      <input
        id="acceptinviteform-display-name"
        value={displayName}
        onChange={e => setDisplayName(e.target.value)}
        placeholder="How other members see you (e.g. wess@home)"
      />
      <div className="fed-form-hint">
        Accepting reaches out to the introducer (the URL embedded in the token), exchanges keys, and registers this
        instance as a member.
      </div>
      {error && (
        <div className="msg err" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
      <div className="settings-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={submit} disabled={busy || !token.trim()}>
          {busy ? "Pairing…" : "Accept invite"}
        </button>
      </div>
    </div>
  )
}

const FederationDetailView: React.FC<{ id: number; onBack: () => void }> = ({ id, onBack }) => {
  const [fed, setFed] = useState<api.FederationDetail | null>(null)
  const [members, setMembers] = useState<api.FederationMember[] | null>(null)
  const [invites, setInvites] = useState<api.FederationInvite[] | null>(null)
  const [usage, setUsage] = useState<api.FederationUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [justMintedInvite, setJustMintedInvite] = useState<string | null>(null)
  const [showContrib, setShowContrib] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const [d, m, u] = await Promise.all([
        api.getFederation(id),
        api.listFederationMembers(id),
        api.getFederationUsage(id),
      ])
      setFed(d)
      setMembers(m)
      setUsage(u)
      if (d.is_admin) {
        try {
          setInvites(await api.listFederationInvites(id))
        } catch {
          setInvites(null)
        }
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load federation")
    }
  }

  useEffect(() => {
    load()
  }, [id])

  const mintInvite = async () => {
    setBusy(true)
    setError(null)
    try {
      const res: any = await api.mintFederationInvite(id, 168)
      if (res?.error) {
        setError(res.error)
        return
      }
      setJustMintedInvite(res.token)
      const list = await api.listFederationInvites(id).catch(() => null)
      if (list) setInvites(list)
    } catch (e: any) {
      setError(e?.message ?? "Failed to mint invite")
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    if (
      !confirm(
        `Leave ${fed?.name ?? "this federation"}? You'll enter drain mode — your hosted blobs are re-replicated off this instance before disconnect.`,
      )
    )
      return
    setBusy(true)
    try {
      await api.leaveFederation(id)
      onBack()
    } catch (e: any) {
      setError(e?.message ?? "Failed to leave")
      setBusy(false)
    }
  }

  if (!fed || !members || !usage) {
    return (
      <div className="settings-card">
        <button type="button" className="fed-back" onClick={onBack}>
          ← Federations
        </button>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>{error ?? "Loading…"}</div>
      </div>
    )
  }

  return (
    <div className="settings-card">
      <button type="button" className="fed-back" onClick={onBack}>
        ← Federations
      </button>
      <h3 style={{ marginTop: 12 }}>
        {fed.name}
        {fed.is_admin && <span className="fed-pill fed-pill-admin">Admin</span>}
        <span className={`fed-pill fed-pill-${fed.type === "content-sharing" ? "csh" : "spo"}`}>
          {fed.type === "content-sharing" ? "Content-sharing" : "Space-offering"}
        </span>
        {fed.status !== "active" && <span className="fed-pill fed-pill-warn">{fed.status}</span>}
      </h3>
      <div className="fed-row-meta" style={{ marginTop: 4 }}>
        <code>{fed.slug}</code>
        <span>·</span>
        <span>Replication × {fed.replication_factor}</span>
        {fed.erasure_k && fed.erasure_m && (
          <>
            <span>·</span>
            <span>
              Erasure {fed.erasure_k}-of-{fed.erasure_m}
            </span>
          </>
        )}
      </div>
      {fed.description && (
        <p style={{ color: "var(--text-soft)", fontSize: 13.5, margin: "12px 0 0", lineHeight: 1.55 }}>
          {fed.description}
        </p>
      )}

      {error && (
        <div className="msg err" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {/* Usage */}
      <div className="fed-usage">
        <div className="fed-usage-row">
          <span>Your contribution</span>
          <strong>{formatGB(usage.contributed_bytes)}</strong>
        </div>
        <div className="fed-usage-row">
          <span>Used</span>
          <strong>{formatGB(usage.used_bytes)}</strong>
        </div>
        <div className="fed-usage-row">
          <span>Your allowance</span>
          <strong>
            {formatGB(usage.allowance_bytes)}
            {usage.quota_multiplier !== 1 && <span className="fed-usage-mult"> (×{usage.quota_multiplier})</span>}
          </strong>
        </div>
        <div className="fed-usage-row">
          <span>Available</span>
          <strong>{formatGB(usage.available_bytes)}</strong>
        </div>
      </div>

      {/* Contribution folder */}
      <div className="fed-block">
        <div className="fed-block-title">Contribution folder</div>
        {usage.contributed_bytes > 0 ? (
          <div className="fed-block-body" style={{ color: "var(--text-soft)", fontSize: 13 }}>
            You're contributing {formatGB(usage.contributed_bytes)}. Adjust or release from{" "}
            <a
              href="/app"
              onClick={e => {
                e.preventDefault()
                alert("Find your federation folder in the files view; the row picker is shipping next.")
              }}
            >
              the files view
            </a>
            .
          </div>
        ) : (
          <>
            <div className="fed-block-body" style={{ color: "var(--text-soft)", fontSize: 13 }}>
              You haven't designated a folder yet. Pick an existing folder and a quota cap — that folder becomes the
              local mount-point for federation data.
            </div>
            {!showContrib && (
              <button type="button" className="primary" style={{ marginTop: 10 }} onClick={() => setShowContrib(true)}>
                Designate folder
              </button>
            )}
            {showContrib && (
              <ContributeForm
                federationId={id}
                onDone={() => {
                  setShowContrib(false)
                  load()
                }}
                onCancel={() => setShowContrib(false)}
              />
            )}
          </>
        )}
      </div>

      {/* Members */}
      <div className="fed-block">
        <div className="fed-block-title">Members ({members.length})</div>
        <ul className="fed-member-list">
          {members.map(m => (
            <li key={m.id} className={m.status !== "active" ? "fed-member-inactive" : undefined}>
              <div className="fed-member-pubkey">
                <code>{m.peer_pubkey.slice(0, 16)}…</code>
                {m.is_local && <span className="fed-pill fed-pill-csh">You</span>}
                {m.is_admin && <span className="fed-pill fed-pill-admin">Admin</span>}
                {m.status !== "active" && <span className="fed-pill fed-pill-warn">{m.status}</span>}
              </div>
              <div className="fed-member-meta">
                {m.display_name && <span>{m.display_name} · </span>}
                {m.peer_base_url}
              </div>
              <div className="fed-member-meta">
                Contributing {formatGB(m.contributed_bytes)} · Used {formatGB(m.used_bytes)}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Invites — admin only */}
      {fed.is_admin && (
        <div className="fed-block">
          <div className="fed-block-title">Invite tokens</div>
          {justMintedInvite && (
            <div className="msg ok" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                Invite token — send to the joiner, won't be shown again
              </div>
              <div className="dev-secret">
                <div className="dev-secret-row">
                  <code style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>{justMintedInvite}</code>
                  <button type="button" onClick={() => navigator.clipboard.writeText(justMintedInvite)}>
                    Copy
                  </button>
                </div>
              </div>
              <button type="button" onClick={() => setJustMintedInvite(null)} style={{ marginTop: 8 }}>
                I've sent it
              </button>
            </div>
          )}
          <button type="button" className="primary" disabled={busy} onClick={mintInvite}>
            {busy ? "Minting…" : "Mint new invite (7 days)"}
          </button>
          {invites && invites.length > 0 && (
            <ul className="fed-invite-list">
              {invites.map(inv => {
                const used = !!inv.used_at
                const expired = !used && new Date(inv.expires_at) < new Date()
                return (
                  <li key={inv.id}>
                    <span className={used ? "fed-invite-used" : expired ? "fed-invite-expired" : "fed-invite-active"}>
                      {used ? "Used" : expired ? "Expired" : "Active"}
                    </span>
                    <span> · expires {new Date(inv.expires_at).toLocaleString()}</span>
                    {used && inv.used_by_pubkey && (
                      <>
                        {" "}
                        · used by <code>{inv.used_by_pubkey.slice(0, 16)}…</code>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* Danger zone */}
      <div className="fed-block">
        <div className="fed-block-title">Leave federation</div>
        <div className="fed-block-body" style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
          Marks this instance as draining. The background sweep re-replicates blobs/shards you host onto other peers,
          then removes the membership.
        </div>
        <button type="button" onClick={leave} disabled={busy || fed.status !== "active"}>
          {fed.status === "draining" ? "Already draining…" : fed.status === "left" ? "Left" : "Leave federation"}
        </button>
      </div>
    </div>
  )
}

type RootFolderRow = { id: number; name: string; federation_id: number | null; federation_role: string | null }

const ContributeForm: React.FC<{ federationId: number; onDone: () => void; onCancel: () => void }> = ({
  federationId,
  onDone,
  onCancel,
}) => {
  const [folders, setFolders] = useState<RootFolderRow[] | null>(null)
  const [folderId, setFolderId] = useState<number | null>(null)
  const [quotaGB, setQuotaGB] = useState(50)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")

  useEffect(() => {
    api
      .listFolders(null)
      .then((rs: any) => {
        const eligible = (rs as RootFolderRow[]).filter(f => !f.federation_role)
        setFolders(eligible)
      })
      .catch(e => setError(e?.message ?? "Couldn't list folders"))
  }, [])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      let targetId = folderId
      if (!targetId && newFolderName.trim()) {
        const created: any = await api.createFolder(newFolderName.trim(), null)
        if (created?.error) {
          setError(created.error)
          return
        }
        targetId = created.id
      }
      if (!targetId) {
        setError("Pick an existing folder or create a new one")
        return
      }
      const quotaBytes = Math.floor(quotaGB * GB_TO_BYTES)
      const res: any = await api.setFederationContribution(federationId, targetId, quotaBytes)
      if (res?.error) {
        setError(res.error)
        return
      }
      onDone()
    } catch (e: any) {
      setError(e?.message ?? "Failed to designate folder")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fed-form" style={{ marginTop: 10 }}>
      <label htmlFor="contributeform-quota-gb">Quota (GB)</label>
      <input
        id="contributeform-quota-gb"
        type="number"
        min={1}
        value={quotaGB}
        onChange={e => setQuotaGB(Math.max(1, Number(e.target.value) || 1))}
      />
      <div className="fed-form-hint">
        How much disk space this instance is offering to the federation. Floor is 0.1 GB.
      </div>

      <label htmlFor="contributeform-existing-folder" style={{ marginTop: 10 }}>
        Existing folder
      </label>
      <select
        id="contributeform-existing-folder"
        value={folderId ?? ""}
        onChange={e => setFolderId(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— pick a folder —</option>
        {(folders ?? []).map(f => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <div className="fed-form-hint">
        Only root-level folders that aren't already tied to a federation are eligible.
      </div>

      <label htmlFor="contributeform-or-create-a-new-dedicated-folder" style={{ marginTop: 10 }}>
        Or create a new dedicated folder
      </label>
      <input
        id="contributeform-or-create-a-new-dedicated-folder"
        value={newFolderName}
        onChange={e => setNewFolderName(e.target.value)}
        placeholder="e.g. Federation: friends"
      />

      {error && (
        <div className="msg err" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      <div className="settings-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={submit}
          disabled={busy || (!folderId && !newFolderName.trim())}
        >
          {busy ? "Saving…" : "Designate folder"}
        </button>
      </div>
    </div>
  )
}

type OAuthClient = {
  id: number
  client_id: string
  client_secret?: string
  name: string
  description: string | null
  icon_url: string | null
  redirect_uris: string[]
  allowed_scopes: string[]
  is_official: boolean
  is_public_client: boolean
  created_at: string
  revoked_at: string | null
}

const OAuthClientsSection: React.FC = () => {
  const [clients, setClients] = useState<OAuthClient[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [redirectsRaw, setRedirectsRaw] = useState("")
  const [scopeRead, setScopeRead] = useState(true)
  const [scopeWrite, setScopeWrite] = useState(true)
  const [scopeShare, setScopeShare] = useState(true)
  const [isOfficial, setIsOfficial] = useState(false)
  const [confidential, setConfidential] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [justCreated, setJustCreated] = useState<OAuthClient | null>(null)

  const load = async () => {
    const data = await api.adminListOAuthClients()
    setClients(Array.isArray(data) ? data : [])
  }
  useEffect(() => {
    load()
  }, [])

  const reset = () => {
    setName("")
    setDescription("")
    setRedirectsRaw("")
    setScopeRead(true)
    setScopeWrite(true)
    setScopeShare(true)
    setIsOfficial(false)
    setConfidential(false)
    setError("")
  }

  const create = async () => {
    if (!name.trim()) return setError("Name is required")
    const redirect_uris = redirectsRaw
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (redirect_uris.length === 0) return setError("At least one redirect URI is required")
    const allowed_scopes = [
      ...(scopeRead ? ["read"] : []),
      ...(scopeWrite ? ["write"] : []),
      ...(scopeShare ? ["share"] : []),
    ]
    if (allowed_scopes.length === 0) return setError("At least one scope is required")

    setBusy(true)
    setError("")
    const res = await api.adminCreateOAuthClient({
      name: name.trim(),
      description: description.trim() || undefined,
      redirect_uris,
      allowed_scopes,
      is_official: isOfficial,
      is_public_client: !confidential,
    })
    setBusy(false)
    if (res.error) return setError(res.error)
    setJustCreated(res as OAuthClient)
    setCreating(false)
    reset()
    await load()
  }

  const revoke = async (id: number) => {
    if (
      !confirm(
        "Revoke this OAuth client? Existing access tokens will continue to work until they expire (1h), but no new tokens can be issued.",
      )
    )
      return
    const res = await api.adminRevokeOAuthClient(id)
    if (res.error) return alert(res.error)
    await load()
  }

  const rotateSecret = async (id: number, name: string) => {
    if (
      !confirm(
        `Rotate the client_secret for "${name}"? Every existing refresh token for this client will be invalidated and connected apps will need to re-authenticate.`,
      )
    )
      return
    const res = (await api.adminRotateOAuthClientSecret(id)) as {
      client_id?: string
      client_secret?: string
      error?: string
    }
    if (res.error) return alert(res.error)
    if (!res.client_secret) return alert("Rotation succeeded but no secret was returned")
    setJustCreated({
      ...(clients.find(c => c.id === id) as OAuthClient),
      client_secret: res.client_secret,
    })
    await load()
  }

  return (
    <div className="devp-section">
      <h4>OAuth applications</h4>
      <div className="devp-section-desc">
        Register apps that authenticate users via OAuth 2.0 + PKCE. Use for native/desktop/mobile clients (Butter, etc.)
        or third-party integrations.
      </div>

      {justCreated && (
        <div className="msg ok" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Client created — copy these now</div>
          <div className="dev-secret">
            <label>Client ID</label>
            <div className="dev-secret-row">
              <code>{justCreated.client_id}</code>
              <button type="button" onClick={() => navigator.clipboard.writeText(justCreated.client_id)}>
                Copy
              </button>
            </div>
            {justCreated.client_secret && (
              <>
                <label>
                  Client secret <span style={{ color: "var(--muted)", fontWeight: 400 }}>(only shown once)</span>
                </label>
                <div className="dev-secret-row">
                  <code>{justCreated.client_secret}</code>
                  <button type="button" onClick={() => navigator.clipboard.writeText(justCreated.client_secret ?? "")}>
                    Copy
                  </button>
                </div>
              </>
            )}
          </div>
          <button type="button" onClick={() => setJustCreated(null)} style={{ marginTop: 8 }}>
            I've saved it
          </button>
        </div>
      )}

      {creating && !justCreated && (
        <div className="dev-create">
          <label htmlFor="oauthclientssection-name">Name</label>
          <input
            id="oauthclientssection-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Butter"
            autoFocus
          />
          <label htmlFor="oauthclientssection-description" style={{ marginTop: 10 }}>
            Description <span className="lp-field-opt">(optional)</span>
          </label>
          <input
            id="oauthclientssection-description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Desktop screenshot uploader"
          />
          <label htmlFor="oauthclientssection-redirect-uris" style={{ marginTop: 10 }}>
            Redirect URIs <span className="lp-field-opt">(one per line, exact match)</span>
          </label>
          <textarea
            id="oauthclientssection-redirect-uris"
            value={redirectsRaw}
            onChange={e => setRedirectsRaw(e.target.value)}
            placeholder={"stohrshot://oauth/callback\nhttp://localhost:5173/callback"}
            rows={3}
            style={{ width: "100%", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
            <strong>Common values:</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              <li>
                Stohrshot desktop app: <code>stohrshot://oauth/callback</code>{" "}
                <button
                  type="button"
                  onClick={() => {
                    const uri = "stohrshot://oauth/callback"
                    setRedirectsRaw(prev => {
                      const lines = prev
                        .split(/\r?\n/)
                        .map(s => s.trim())
                        .filter(Boolean)
                      return lines.includes(uri) ? prev : [...lines, uri].join("\n")
                    })
                  }}
                  style={{ marginLeft: 4, padding: "1px 8px", fontSize: 11 }}
                >
                  Use this
                </button>
              </li>
              <li>
                iOS/Android mobile app: a custom scheme like <code>stohrapp://oauth/callback</code>
              </li>
              <li>
                SPA / web app: <code>https://yourapp.example.com/callback</code>
              </li>
            </ul>
          </div>
          <label style={{ marginTop: 14 }}>Scopes</label>
          <div className="scope-grid">
            <label className="scope-check">
              <input type="checkbox" checked={scopeRead} onChange={e => setScopeRead(e.target.checked)} />
              <span>read</span>
            </label>
            <label className="scope-check">
              <input type="checkbox" checked={scopeWrite} onChange={e => setScopeWrite(e.target.checked)} />
              <span>write</span>
            </label>
            <label className="scope-check">
              <input type="checkbox" checked={scopeShare} onChange={e => setScopeShare(e.target.checked)} />
              <span>share</span>
            </label>
          </div>
          <label className="scope-check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={isOfficial} onChange={e => setIsOfficial(e.target.checked)} />
            <span>First-party app (skips consent screen)</span>
          </label>
          <label className="scope-check" style={{ marginTop: 4 }}>
            <input type="checkbox" checked={confidential} onChange={e => setConfidential(e.target.checked)} />
            <span>
              Confidential client (issues a client_secret — for server-side apps only; native apps must stay public)
            </span>
          </label>
          {error && (
            <div className="msg err" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
          <div className="settings-actions">
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                reset()
              }}
            >
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy} onClick={create}>
              {busy ? "Creating…" : "Create client"}
            </button>
          </div>
        </div>
      )}

      {!creating && !justCreated && (
        <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Register new OAuth client
          </button>
        </div>
      )}

      {clients.length === 0 ? (
        <div className="dev-empty">No OAuth clients registered yet.</div>
      ) : (
        <div className="dev-list">
          {clients.map(c => (
            <div key={c.id} className="dev-row" style={{ opacity: c.revoked_at ? 0.5 : 1 }}>
              <div className="dev-row-main">
                <div className="dev-row-line">
                  <span className="dev-row-name">{c.name}</span>
                  {c.is_official && (
                    <span className="badge" style={{ background: "var(--brand)", color: "white" }}>
                      official
                    </span>
                  )}
                  {c.revoked_at && (
                    <span className="badge" style={{ background: "var(--muted)" }}>
                      revoked
                    </span>
                  )}
                </div>
                {c.description && <div className="dev-row-desc">{c.description}</div>}
                <div
                  className="dev-row-meta"
                  style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}
                >
                  <span style={{ color: "var(--muted)" }}>client_id</span>
                  <code
                    style={{
                      background: "var(--bg)",
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      fontSize: 11,
                    }}
                  >
                    {c.client_id}
                  </code>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(c.client_id)}
                    style={{ padding: "2px 8px", fontSize: 11 }}
                  >
                    Copy
                  </button>
                  {!c.is_public_client && (
                    <span className="badge" style={{ background: "var(--muted)", marginLeft: 4 }}>
                      has secret
                    </span>
                  )}
                </div>
                <div className="dev-row-meta">
                  Scopes: {c.allowed_scopes.join(", ")} · Redirects: {c.redirect_uris.length}
                  {c.is_public_client ? " · public (PKCE)" : " · confidential"}
                </div>
              </div>
              {!c.revoked_at && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {!c.is_public_client && (
                    <button type="button" onClick={() => rotateSecret(c.id, c.name)}>
                      Rotate secret
                    </button>
                  )}
                  <button type="button" className="danger" onClick={() => revoke(c.id)}>
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type MfaStatus = { enabled: boolean; enabled_at: string | null; backup_codes_remaining: number }

const SecurityPanel: React.FC = () => {
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string; qr: string } | null>(null)
  const [enableCode, setEnableCode] = useState("")
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [disablePw, setDisablePw] = useState("")
  const [disableCode, setDisableCode] = useState("")
  const [showDisable, setShowDisable] = useState(false)
  const [showRegen, setShowRegen] = useState(false)
  const [regenPw, setRegenPw] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const reload = async () => {
    const s = (await api.getMfaStatus()) as MfaStatus
    setStatus(s)
  }
  useEffect(() => {
    reload()
  }, [])

  const start = async () => {
    setBusy(true)
    setError("")
    try {
      const res = (await api.startMfaSetup()) as { secret: string; otpauth_url: string; error?: string }
      if (res.error) {
        setError(res.error)
        return
      }
      const QR: typeof import("qrcode") = await import("qrcode")
      const qr = await QR.toDataURL(res.otpauth_url, { margin: 1, width: 200 })
      setSetup({ secret: res.secret, otpauth_url: res.otpauth_url, qr })
    } finally {
      setBusy(false)
    }
  }

  const enable = async () => {
    setBusy(true)
    setError("")
    try {
      const res = (await api.enableMfa(enableCode.trim())) as { ok?: boolean; backup_codes?: string[]; error?: string }
      if (res.error) {
        setError(res.error)
        return
      }
      setBackupCodes(res.backup_codes ?? [])
      setSetup(null)
      setEnableCode("")
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setError("")
    try {
      const res = (await api.disableMfa(disablePw, disableCode.trim())) as { ok?: boolean; error?: string }
      if (res.error) {
        setError(res.error)
        return
      }
      setShowDisable(false)
      setDisablePw("")
      setDisableCode("")
      setBackupCodes(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const regen = async () => {
    setBusy(true)
    setError("")
    try {
      const res = (await api.regenerateBackupCodes(regenPw)) as { backup_codes?: string[]; error?: string }
      if (res.error) {
        setError(res.error)
        return
      }
      setBackupCodes(res.backup_codes ?? [])
      setShowRegen(false)
      setRegenPw("")
      await reload()
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  return (
    <section className="settings-card">
      <h3>Security</h3>
      <h4 style={{ margin: "4px 0 6px", fontSize: 14 }}>Two-factor authentication</h4>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
        TOTP code from your authenticator app on top of your password.
      </div>

      {!status.enabled && !setup && (
        <div className="settings-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="primary" disabled={busy} onClick={start}>
            Set up authenticator
          </button>
        </div>
      )}

      {setup && (
        <div className="dev-create">
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            Scan with Google Authenticator, 1Password, Authy, or any TOTP app — then enter the 6-digit code below.
          </div>
          <img
            src={setup.qr}
            alt="QR code"
            style={{ width: 180, height: 180, background: "#fff", padding: 8, borderRadius: 8 }}
          />
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>Or enter this secret manually:</div>
          <code
            style={{
              display: "block",
              marginTop: 4,
              padding: 6,
              background: "var(--panel)",
              borderRadius: 4,
              fontSize: 12,
              wordBreak: "break-all",
            }}
          >
            {setup.secret}
          </code>
          <label htmlFor="securitypanel-6-digit-code-from-your-app" style={{ marginTop: 14 }}>
            6-digit code from your app
          </label>
          <input
            id="securitypanel-6-digit-code-from-your-app"
            inputMode="numeric"
            maxLength={6}
            value={enableCode}
            onChange={e => setEnableCode(e.target.value.replace(/\D/g, ""))}
          />
          {error && (
            <div className="msg err" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
          <div className="settings-actions">
            <button
              type="button"
              onClick={() => {
                setSetup(null)
                setEnableCode("")
                setError("")
              }}
            >
              Cancel
            </button>
            <button type="button" className="primary" disabled={busy || enableCode.length !== 6} onClick={enable}>
              Enable MFA
            </button>
          </div>
        </div>
      )}

      {backupCodes && (
        <div className="msg ok" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Save your backup codes — these won't be shown again</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 4,
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 13,
              marginBottom: 8,
            }}
          >
            {backupCodes.map(c => (
              <div key={c}>{c}</div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => navigator.clipboard.writeText(backupCodes.join("\n"))}>
              Copy all
            </button>
            <button type="button" onClick={() => setBackupCodes(null)}>
              I've saved them
            </button>
          </div>
        </div>
      )}

      {status.enabled && !setup && !backupCodes && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span className="badge" style={{ background: "var(--brand)", color: "white" }}>
              Enabled
            </span>
            {status.enabled_at && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                since {new Date(status.enabled_at).toLocaleDateString()}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
            {status.backup_codes_remaining} backup code{status.backup_codes_remaining === 1 ? "" : "s"} remaining
          </div>

          {!showDisable && !showRegen && (
            <div className="settings-actions" style={{ justifyContent: "flex-start" }}>
              <button
                type="button"
                onClick={() => {
                  setShowRegen(true)
                  setError("")
                }}
              >
                Regenerate backup codes
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setShowDisable(true)
                  setError("")
                }}
              >
                Disable MFA
              </button>
            </div>
          )}

          {showRegen && (
            <div className="dev-create">
              <label htmlFor="securitypanel-confirm-with-your-password">Confirm with your password</label>
              <input
                id="securitypanel-confirm-with-your-password"
                type="password"
                value={regenPw}
                onChange={e => setRegenPw(e.target.value)}
              />
              {error && (
                <div className="msg err" style={{ marginTop: 8 }}>
                  {error}
                </div>
              )}
              <div className="settings-actions">
                <button
                  type="button"
                  onClick={() => {
                    setShowRegen(false)
                    setRegenPw("")
                    setError("")
                  }}
                >
                  Cancel
                </button>
                <button type="button" className="primary" disabled={busy || !regenPw} onClick={regen}>
                  Regenerate
                </button>
              </div>
            </div>
          )}

          {showDisable && (
            <div className="dev-create">
              <label htmlFor="securitypanel-password">Password</label>
              <input
                id="securitypanel-password"
                type="password"
                value={disablePw}
                onChange={e => setDisablePw(e.target.value)}
              />
              <label htmlFor="securitypanel-6-digit-code-from-your-app-2" style={{ marginTop: 10 }}>
                6-digit code from your app
              </label>
              <input
                id="securitypanel-6-digit-code-from-your-app-2"
                inputMode="numeric"
                maxLength={6}
                value={disableCode}
                onChange={e => setDisableCode(e.target.value.replace(/\D/g, ""))}
              />
              {error && (
                <div className="msg err" style={{ marginTop: 8 }}>
                  {error}
                </div>
              )}
              <div className="settings-actions">
                <button
                  type="button"
                  onClick={() => {
                    setShowDisable(false)
                    setDisablePw("")
                    setDisableCode("")
                    setError("")
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || !disablePw || disableCode.length !== 6}
                  onClick={disable}
                >
                  Disable MFA
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <PasskeysSection />

      <SessionsSection />
    </section>
  )
}

const PasskeysSection: React.FC = () => {
  const [rows, setRows] = useState<api.Passkey[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const load = async () => {
    const list = await api.listPasskeys()
    setRows(Array.isArray(list) ? list : [])
  }
  useEffect(() => {
    void load()
  }, [])

  const beginAdd = () => {
    setDraftName("")
    setError("")
    setNaming(true)
  }

  const addPasskey = async () => {
    setBusy(true)
    setError("")
    try {
      const SWB: typeof import("@simplewebauthn/browser") = await import("@simplewebauthn/browser")
      const options = await api.beginPasskeyRegistration()
      if (options?.error) {
        setError(options.error)
        return
      }
      let regResponse: any
      try {
        regResponse = await SWB.startRegistration({ optionsJSON: options })
      } catch (e: any) {
        // User cancelled or device unsupported
        if (e?.name === "InvalidStateError") {
          setError("This device already has a passkey for your account.")
        } else if (e?.name === "NotAllowedError") {
          setError("Passkey registration was cancelled.")
        } else {
          setError(e?.message ?? "Couldn't add passkey.")
        }
        return
      }
      const finalName = draftName.trim() || null
      const finishRes = await api.finishPasskeyRegistration({ name: finalName ?? undefined, response: regResponse })
      if ((finishRes as any).error) {
        setError((finishRes as any).error)
        return
      }
      setNaming(false)
      setDraftName("")
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: api.Passkey) => {
    if (!confirm(`Remove "${p.name || "this passkey"}"? You'll need to set up a new one to use it again.`)) return
    setBusy(true)
    await api.deletePasskey(p.id)
    setBusy(false)
    await load()
  }

  const startRename = (p: api.Passkey) => {
    setRenamingId(p.id)
    setRenameValue(p.name ?? "")
  }
  const saveRename = async () => {
    if (renamingId === null) return
    setBusy(true)
    await api.renamePasskey(renamingId, renameValue.trim() || null)
    setBusy(false)
    setRenamingId(null)
    setRenameValue("")
    await load()
  }

  return (
    <>
      <h4 style={{ margin: "20px 0 6px", fontSize: 14 }}>Passkeys</h4>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
        Use your phone, laptop, or hardware key to sign in. Works with Apple Face ID/Touch ID and Android biometrics.
      </div>

      {error && (
        <div className="msg err" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)", padding: "10px 0" }}>No passkeys yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          {rows.map(p => (
            <div key={p.id} className="passkey-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                {renamingId === p.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && saveRename()}
                  />
                ) : (
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name || "Untitled passkey"}</div>
                )}
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Added {new Date(p.created_at).toLocaleDateString()}
                  {p.last_used_at && ` · last used ${new Date(p.last_used_at).toLocaleDateString()}`}
                </div>
              </div>
              {renamingId === p.id ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(null)
                      setRenameValue("")
                    }}
                  >
                    Cancel
                  </button>
                  <button type="button" className="primary" onClick={saveRename} disabled={busy}>
                    Save
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" onClick={() => startRename(p)} disabled={busy}>
                    Rename
                  </button>
                  <button type="button" className="danger" onClick={() => remove(p)} disabled={busy}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {naming ? (
        <div className="passkey-form">
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>
            Give this passkey a name so you can tell it apart from others later (e.g. "iPhone", "Work laptop").
          </div>
          <input
            aria-label="Passkey name"
            autoFocus
            placeholder="Passkey name"
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addPasskey()}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
            <button
              type="button"
              onClick={() => {
                setNaming(false)
                setDraftName("")
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="button" className="primary" onClick={addPasskey} disabled={busy}>
              {busy ? "Waiting…" : "Continue"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={beginAdd} disabled={busy}>
          <Plus size={14} /> <span>Add a passkey</span>
        </button>
      )}
    </>
  )
}

type SessionRow = {
  id: string
  ip: string | null
  user_agent: string | null
  expires_at: string
  last_used_at: string
  created_at: string
  current: boolean
}

const SessionsSection: React.FC = () => {
  const [rows, setRows] = useState<SessionRow[]>([])
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const data = await api.listSessions()
    setRows(Array.isArray(data) ? data : [])
  }
  useEffect(() => {
    load()
  }, [])

  const revoke = async (id: string) => {
    if (!confirm("Sign this session out?")) return
    setBusy(true)
    await api.revokeSession(id)
    setBusy(false)
    await load()
  }

  const revokeOthers = async () => {
    if (!confirm("Sign out everywhere else? Other browsers/devices will be logged out immediately.")) return
    setBusy(true)
    await api.revokeOtherSessions()
    setBusy(false)
    await load()
  }

  const summarize = (ua: string | null): string => {
    if (!ua) return "Unknown device"
    if (/iPhone|iPad/.test(ua)) return "iOS"
    if (/Android/.test(ua)) return "Android"
    if (/Macintosh/.test(ua)) return "macOS"
    if (/Windows/.test(ua)) return "Windows"
    if (/Linux/.test(ua)) return "Linux"
    if (/Dart\//.test(ua)) return "Mobile app"
    return ua.slice(0, 60)
  }

  return (
    <div className="devp-section">
      <h4>Active sessions</h4>
      <div className="devp-section-desc">
        Where you're currently signed in. Revoke any session to force a fresh sign-in.
      </div>
      {rows.length === 0 ? (
        <div className="dev-empty">No active sessions</div>
      ) : (
        <>
          <div className="dev-list">
            {rows.map(s => (
              <div key={s.id} className="dev-row">
                <div className="dev-row-main">
                  <div className="dev-row-line">
                    <span className="dev-row-name">{summarize(s.user_agent)}</span>
                    {s.current && (
                      <span className="badge" style={{ background: "var(--brand)", color: "white" }}>
                        this session
                      </span>
                    )}
                  </div>
                  <div className="dev-row-meta">
                    {s.ip ?? "Unknown IP"} · last used {new Date(s.last_used_at).toLocaleString()}
                  </div>
                </div>
                {!s.current && (
                  <button type="button" className="danger" disabled={busy} onClick={() => revoke(s.id)}>
                    Sign out
                  </button>
                )}
              </div>
            ))}
          </div>
          {rows.some(s => !s.current) && (
            <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
              <button type="button" className="danger" disabled={busy} onClick={revokeOthers}>
                Sign out all other sessions
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

type Invite = { id: number; email: string | null; used_at: string | null; used_by: number | null; created_at: string }

const InvitesPanel: React.FC = () => {
  const [invites, setInvites] = useState<Invite[]>([])
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  // The invite token is only returned once, at creation time. We keep it in
  // memory so the user can copy the link before navigating away — the server
  // stores only its hash and cannot show it again.
  const [justCreated, setJustCreated] = useState<{ id: number; token: string } | null>(null)

  const load = async () => {
    const list = await api.listInvites()
    setInvites(Array.isArray(list) ? list : [])
  }
  useEffect(() => {
    load()
  }, [])

  const create = async () => {
    setError("")
    const res = await api.createInvite(email.trim() || undefined)
    if (res.error) return setError(res.error)
    if (res.token && res.id) setJustCreated({ id: res.id, token: res.token })
    setEmail("")
    await load()
  }

  const revoke = async (id: number) => {
    if (!confirm("Revoke this invite?")) return
    const res = await api.revokeInvite(id)
    if (res.error) return alert(res.error)
    if (justCreated?.id === id) setJustCreated(null)
    await load()
  }

  const copyLink = (token: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/signup?invite=${token}`)
  }

  return (
    <section className="settings-card">
      <h3>Invites</h3>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
        Stohr is invite-only. Mint an invite to bring someone in.
      </div>
      <label htmlFor="invitespanel-email-optional-locks-the-invite-to-this-address">
        Email (optional, locks the invite to this address)
      </label>
      <input
        id="invitespanel-email-optional-locks-the-invite-to-this-address"
        type="email"
        placeholder="alice@example.com"
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      {error && <div className="msg err">{error}</div>}
      <div className="settings-actions">
        <button type="button" className="primary" onClick={create}>
          <Mail size={14} /> <span>Create invite</span>
        </button>
      </div>
      {justCreated && (
        <div className="msg" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>Copy this link now — we don't store it.</div>
          <div className="share-link" style={{ fontSize: 11, wordBreak: "break-all" }}>
            {`${window.location.origin}/signup?invite=${justCreated.token}`}
          </div>
          <div style={{ marginTop: 6 }}>
            <button type="button" onClick={() => copyLink(justCreated.token)}>
              Copy link
            </button>
          </div>
        </div>
      )}
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {invites.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No invites yet</div>}
        {invites.map(inv => (
          <div key={inv.id} style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ flex: 1, fontWeight: 500 }}>
                {inv.email ?? "Open invite"}
                {inv.used_at && (
                  <span className="badge" style={{ marginLeft: 8, background: "var(--muted)" }}>
                    used
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {new Date(inv.created_at).toLocaleDateString()}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {!inv.used_at && (
                <button type="button" className="danger" onClick={() => revoke(inv.id)} style={{ marginLeft: "auto" }}>
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

type SettingsTab = "profile" | "storage" | "security" | "developer" | "federation" | "invites" | "account"

const Settings: React.FC<{ onProfileUpdate: () => void; onAccountDeleted: () => void }> = ({
  onProfileUpdate,
  onAccountDeleted,
}) => {
  const current = api.getUser()
  const [tab, setTab] = useState<SettingsTab>("profile")
  const [name, setName] = useState(current?.name ?? "")
  const [username, setUsername] = useState(current?.username ?? "")
  const [email, setEmail] = useState(current?.email ?? "")
  const [profilePw, setProfilePw] = useState("")
  const [profileMsg, setProfileMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  // email and username are login identities; the API wants the current
  // password before it changes either
  const identityEdited = email.trim() !== (current?.email ?? "") || username.trim() !== (current?.username ?? "")

  const [currentPw, setCurrentPw] = useState("")
  const [newPw, setNewPw] = useState("")
  const [confirmPw, setConfirmPw] = useState("")
  const [pwMsg, setPwMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deletePw, setDeletePw] = useState("")
  const [deleteErr, setDeleteErr] = useState("")

  const [theme, setTheme] = useState<Theme>(getTheme())
  const chooseTheme = (t: Theme) => {
    setTheme(t)
    setThemePref(t)
  }

  // Probe owner-controlled feature toggles once on mount. Hides the
  // Federation tab when the owner has the feature off (per user request)
  // rather than showing it with a "feature unavailable" message. If the
  // probe itself fails we err on the side of hiding — clicking into a
  // disabled tab would only show the same "ask the owner" copy anyway.
  const [federationOn, setFederationOn] = useState<boolean>(false)
  useEffect(() => {
    // federation exists on the root host only; a team host 404s the probe
    if (api.getUser()?.is_root === false) return
    api
      .federationAvailable()
      .then(setFederationOn)
      .catch(() => setFederationOn(false))
  }, [])

  // If a user lands on Federation but the owner has since disabled it,
  // bounce them back to Profile so they don't sit on an empty tab.
  useEffect(() => {
    if (tab === "federation" && !federationOn) setTab("profile")
  }, [tab, federationOn])

  const saveProfile = async () => {
    setProfileMsg(null)
    const patch: { name?: string; email?: string; username?: string; current_password?: string } = {}
    if (name.trim() && name.trim() !== current?.name) patch.name = name.trim()
    if (email.trim() && email.trim() !== current?.email) patch.email = email.trim()
    if (username.trim() && username.trim() !== current?.username) patch.username = username.trim()
    if (!patch.name && !patch.email && !patch.username) {
      setProfileMsg({ kind: "err", text: "Nothing changed" })
      return
    }
    if (patch.email || patch.username) {
      if (!profilePw) {
        return setProfileMsg({ kind: "err", text: "Enter your current password to change email or username" })
      }
      patch.current_password = profilePw
    }
    const res = await api.updateProfile(patch)
    if (res.error) return setProfileMsg({ kind: "err", text: res.error })
    setProfilePw("")
    setProfileMsg({ kind: "ok", text: "Profile updated" })
    onProfileUpdate()
  }

  const savePassword = async () => {
    setPwMsg(null)
    if (!currentPw || !newPw) return setPwMsg({ kind: "err", text: "Fill in all fields" })
    if (newPw.length < 8) return setPwMsg({ kind: "err", text: "New password must be at least 8 characters" })
    if (newPw !== confirmPw) return setPwMsg({ kind: "err", text: "New passwords don't match" })
    const res = await api.changePassword(currentPw, newPw)
    if (res.error) return setPwMsg({ kind: "err", text: res.error })
    setPwMsg({ kind: "ok", text: "Password changed" })
    setCurrentPw("")
    setNewPw("")
    setConfirmPw("")
  }

  const deleteAccount = async () => {
    setDeleteErr("")
    if (!deletePw) return setDeleteErr("Enter your password to confirm")
    const res = await api.deleteAccount(deletePw)
    if (res.error) return setDeleteErr(res.error)
    onAccountDeleted()
  }

  // on a tenant host only team admins mint invites; root members still can
  const canInvite = current?.is_root !== false || !!current?.team_admin
  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "profile", label: "Profile" },
    { id: "storage", label: "Storage" },
    { id: "security", label: "Security" },
    { id: "developer", label: "Developer" },
    ...(federationOn ? [{ id: "federation" as const, label: "Federation" }] : []),
    ...(canInvite ? [{ id: "invites" as const, label: "Invites" }] : []),
    { id: "account", label: "Account" },
  ]

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs">
          <span className="current">Settings</span>
        </div>
      </div>
      <div className="content">
        <div className="settings">
          {/* A tablist is not a navigation landmark — <nav role="tablist">
              announces the region twice and conflictingly to screen readers. */}
          <div className="settings-tabs" role="tablist">
            {tabs.map(t => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "profile" && (
            <>
              <section className="settings-card">
                <h3>Profile</h3>
                <label htmlFor="settings-name">Name</label>
                <input id="settings-name" value={name} onChange={e => setName(e.target.value)} />
                <label htmlFor="settings-username">Username</label>
                <input
                  id="settings-username"
                  value={username}
                  onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <label htmlFor="settings-email">Email</label>
                <input id="settings-email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
                {identityEdited && (
                  <>
                    <label>Current password</label>
                    <input
                      type="password"
                      value={profilePw}
                      onChange={e => setProfilePw(e.target.value)}
                      autoComplete="current-password"
                    />
                  </>
                )}
                {profileMsg && <div className={`msg ${profileMsg.kind}`}>{profileMsg.text}</div>}
                <div className="settings-actions">
                  <button type="button" className="primary" onClick={saveProfile}>
                    Save changes
                  </button>
                </div>
              </section>

              <section className="settings-card">
                <h3>Appearance</h3>
                <label>Theme</label>
                <div className="theme-group">
                  <button
                    type="button"
                    className={theme === "light" ? "active" : ""}
                    onClick={() => chooseTheme("light")}
                  >
                    <Sun size={14} /> <span>Light</span>
                  </button>
                  <button
                    type="button"
                    className={theme === "dark" ? "active" : ""}
                    onClick={() => chooseTheme("dark")}
                  >
                    <Moon size={14} /> <span>Dark</span>
                  </button>
                  <button
                    type="button"
                    className={theme === "system" ? "active" : ""}
                    onClick={() => chooseTheme("system")}
                  >
                    <Monitor size={14} /> <span>System</span>
                  </button>
                </div>
              </section>
            </>
          )}

          {tab === "storage" && <UsagePanel />}

          {tab === "security" && (
            <>
              <SecurityPanel />
              <section className="settings-card">
                <h3>Change password</h3>
                <label htmlFor="settings-current-password">Current password</label>
                <input
                  id="settings-current-password"
                  type="password"
                  value={currentPw}
                  onChange={e => setCurrentPw(e.target.value)}
                />
                <label htmlFor="settings-new-password">New password</label>
                <input
                  id="settings-new-password"
                  type="password"
                  value={newPw}
                  onChange={e => setNewPw(e.target.value)}
                />
                <label htmlFor="settings-confirm-new-password">Confirm new password</label>
                <input
                  id="settings-confirm-new-password"
                  type="password"
                  value={confirmPw}
                  onChange={e => setConfirmPw(e.target.value)}
                />
                {pwMsg && <div className={`msg ${pwMsg.kind}`}>{pwMsg.text}</div>}
                <div className="settings-actions">
                  <button type="button" className="primary" onClick={savePassword}>
                    Update password
                  </button>
                </div>
              </section>
            </>
          )}

          {tab === "developer" && <DeveloperPanel />}

          {tab === "federation" && federationOn && <FederationPanel />}

          {tab === "invites" && <InvitesPanel />}

          {tab === "account" && (
            <section className="settings-card danger-zone">
              <h3>Danger zone</h3>
              <div className="danger-desc">Permanently delete your account and all files. This cannot be undone.</div>
              {!confirmingDelete ? (
                <div className="settings-actions">
                  <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>
                    Delete account
                  </button>
                </div>
              ) : (
                <>
                  <label>Enter your password to confirm</label>
                  <input type="password" value={deletePw} onChange={e => setDeletePw(e.target.value)} />
                  {deleteErr && <div className="msg err">{deleteErr}</div>}
                  <div className="settings-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingDelete(false)
                        setDeletePw("")
                        setDeleteErr("")
                      }}
                    >
                      Cancel
                    </button>
                    <button type="button" className="danger" onClick={deleteAccount}>
                      Permanently delete
                    </button>
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

type AdminSection = "users" | "teams" | "invites" | "stats" | "audit" | "contact" | "settings" | "mcp"

// rootOnly: instance-level surfaces that a team host does not have (the
// owner only ever signs in on the root host, so this is belt and braces)
const ADMIN_SECTIONS: Array<{ id: AdminSection; label: string; rootOnly?: boolean }> = [
  { id: "users", label: "Users" },
  { id: "teams", label: "Teams", rootOnly: true },
  { id: "invites", label: "Invites" },
  { id: "settings", label: "Settings", rootOnly: true },
  { id: "mcp", label: "MCP", rootOnly: true },
  { id: "contact", label: "Contact", rootOnly: true },
  { id: "stats", label: "Stats", rootOnly: true },
  { id: "audit", label: "Audit" },
]

const AdminView: React.FC<{ section?: string }> = ({ section: requested }) => {
  const me = api.getUser()
  const rootHost = me?.is_root !== false
  const sections = ADMIN_SECTIONS.filter(s => rootHost || !s.rootOnly)
  const section: AdminSection = sections.some(s => s.id === requested) ? (requested as AdminSection) : "users"

  if (!me?.is_owner) {
    return (
      <div className="main">
        <div className="toolbar">
          <div className="crumbs">
            <span className="current">Admin</span>
          </div>
        </div>
        <div className="content">
          <div className="empty">
            <div>Owner access required</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs">
          <span className="current">Admin</span>
        </div>
      </div>
      <div className="content">
        <div className="admin-sections">
          {sections.map(s => (
            <button
              key={s.id}
              type="button"
              className={section === s.id ? "active" : ""}
              onClick={() => navigate(`/app/admin/${s.id}`)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {section === "users" && <AdminUsers meId={me.id} scope="owner" />}
        {section === "teams" && <AdminTeams />}
        {section === "invites" && <AdminInvites scope="owner" />}
        {section === "settings" && <AdminSettings />}
        {section === "mcp" && <AdminMcp />}
        {section === "contact" && <AdminContact />}
        {section === "stats" && <AdminStats />}
        {section === "audit" && <AdminAudit scope="owner" />}
      </div>
    </div>
  )
}

const SETTING_LABELS: Record<string, string> = {
  webdav_enabled: "WebDAV",
  federation_enabled: "Federation",
  mcp_enabled: "MCP server",
  mcp_tool_read: "MCP — read tools",
  mcp_tool_write: "MCP — write tools",
  mcp_tool_delete: "MCP — delete tools",
  mcp_tool_share: "MCP — share tools",
}

const AdminSettings: React.FC = () => {
  const [rows, setRows] = useState<api.AdminSetting[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    api
      .adminGetSettings()
      .then(setRows)
      .catch(e => setError(e?.message ?? "Failed to load settings"))
  }

  useEffect(() => {
    load()
  }, [])

  const toggle = async (key: string, next: boolean) => {
    setBusy(key)
    setError(null)
    try {
      await api.adminUpdateSettings({ [key]: next })
      load()
    } catch (e: any) {
      setError(e?.message ?? "Failed to update setting")
    } finally {
      setBusy(null)
    }
  }

  if (!rows) {
    return (
      <section className="settings-card">
        <h3>Instance settings</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>{error ?? "Loading…"}</div>
      </section>
    )
  }

  return (
    <section className="settings-card">
      <h3>Instance settings</h3>
      <p style={{ color: "var(--muted)", fontSize: 13.5, margin: "0 0 16px", lineHeight: 1.55 }}>
        Owner-controlled feature toggles. Changes take effect immediately — no restart needed. Disabling a feature
        blocks its routes for everyone; existing data (federation memberships, WebDAV credentials) is preserved and
        resumes when you turn it back on.
      </p>
      {error && <div style={{ color: "var(--danger, #c0392b)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      <div className="admin-settings-list">
        {rows.map(row => {
          const label = SETTING_LABELS[row.key] ?? row.key
          const current = row.value === true
          return (
            <div key={row.key} className="admin-setting-row">
              <div className="admin-setting-meta">
                <div className="admin-setting-name">{label}</div>
                <div className="admin-setting-key">{row.key}</div>
                <div className="admin-setting-desc">{row.description}</div>
                {row.updated_at && (
                  <div className="admin-setting-updated">Last changed {new Date(row.updated_at).toLocaleString()}</div>
                )}
              </div>
              <div className="admin-setting-control">
                <label className="admin-setting-toggle">
                  <input
                    type="checkbox"
                    checked={current}
                    disabled={busy === row.key}
                    onChange={e => toggle(row.key, e.target.checked)}
                  />
                  <span className="admin-setting-track" aria-hidden="true">
                    <span className="admin-setting-thumb" />
                  </span>
                  <span className="admin-setting-state">{current ? "On" : "Off"}</span>
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

const MCP_TOGGLE_KEYS = ["mcp_enabled", "mcp_tool_read", "mcp_tool_write", "mcp_tool_delete", "mcp_tool_share"] as const

const AdminMcp: React.FC = () => {
  const [settings, setSettings] = useState<api.AdminSetting[] | null>(null)
  const [preview, setPreview] = useState<api.McpPreview | null>(null)
  const [servers, setServers] = useState<api.McpServer[] | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const load = () => {
    Promise.all([
      api.adminGetSettings(),
      api.adminGetMcpPreview().catch(() => null),
      api.adminListMcpServers().catch(() => []),
    ])
      .then(([s, p, srv]) => {
        setSettings(s)
        setPreview(p)
        setServers(srv ?? [])
      })
      .catch(e => setError(e?.message ?? "Failed to load MCP settings"))
  }

  useEffect(() => {
    load()
  }, [])

  const toggle = async (key: string, next: boolean) => {
    setBusyKey(key)
    setError(null)
    try {
      await api.adminUpdateSettings({ [key]: next })
      load()
    } catch (e: any) {
      setError(e?.message ?? "Failed to update setting")
    } finally {
      setBusyKey(null)
    }
  }

  const mcpSettings = (settings ?? []).filter(s => MCP_TOGGLE_KEYS.includes(s.key as (typeof MCP_TOGGLE_KEYS)[number]))
  const mainToggle = mcpSettings.find(s => s.key === "mcp_enabled")
  const toolToggles = mcpSettings.filter(s => s.key !== "mcp_enabled")

  if (!settings) {
    return (
      <section className="settings-card">
        <h3>Model Context Protocol</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>{error ?? "Loading…"}</div>
      </section>
    )
  }

  return (
    <>
      <section className="settings-card">
        <h3>Model Context Protocol</h3>
        <p style={{ color: "var(--muted)", fontSize: 13.5, margin: "0 0 16px", lineHeight: 1.55 }}>
          Stohr ships a Model Context Protocol (MCP) endpoint at <code>{preview?.endpoint ?? "(loading)"}</code>. AI
          clients (Claude Desktop, IDE extensions, custom agents) authenticate with a personal access token or an OAuth
          access token and call tools to browse and manage the caller's files. Each capability group has its own switch
          — turn on only what you trust the AI to do.
        </p>
        {error && <div style={{ color: "var(--danger, #c0392b)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {mainToggle && (
          <div className="admin-setting-row" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="admin-setting-meta">
              <div className="admin-setting-name">MCP server</div>
              <div className="admin-setting-key">{mainToggle.key}</div>
              <div className="admin-setting-desc">{mainToggle.description}</div>
            </div>
            <div className="admin-setting-control">
              <label className="admin-setting-toggle">
                <input
                  type="checkbox"
                  checked={mainToggle.value === true}
                  disabled={busyKey === mainToggle.key}
                  onChange={e => toggle(mainToggle.key, e.target.checked)}
                />
                <span className="admin-setting-track" aria-hidden="true">
                  <span className="admin-setting-thumb" />
                </span>
                <span className="admin-setting-state">{mainToggle.value === true ? "On" : "Off"}</span>
              </label>
            </div>
          </div>
        )}

        <div className="admin-settings-list" style={{ marginTop: 8 }}>
          {toolToggles.map(row => {
            const current = row.value === true
            const label = SETTING_LABELS[row.key] ?? row.key
            return (
              <div key={row.key} className="admin-setting-row">
                <div className="admin-setting-meta">
                  <div className="admin-setting-name">{label}</div>
                  <div className="admin-setting-key">{row.key}</div>
                  <div className="admin-setting-desc">{row.description}</div>
                </div>
                <div className="admin-setting-control">
                  <label className="admin-setting-toggle">
                    <input
                      type="checkbox"
                      checked={current}
                      disabled={busyKey === row.key || mainToggle?.value !== true}
                      onChange={e => toggle(row.key, e.target.checked)}
                    />
                    <span className="admin-setting-track" aria-hidden="true">
                      <span className="admin-setting-thumb" />
                    </span>
                    <span className="admin-setting-state">{current ? "On" : "Off"}</span>
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {preview && (
        <section className="settings-card">
          <h3>
            Tools exposed to AI clients <span className="admin-count">({preview.advertised_tools.length})</span>
          </h3>
          {!preview.enabled && (
            <p style={{ color: "var(--muted)", fontSize: 13.5 }}>
              MCP is currently <strong>off</strong> — the endpoint returns 503 regardless of these toggles.
            </p>
          )}
          {preview.advertised_tools.length === 0 && (
            <div style={{ color: "var(--muted)", fontSize: 14 }}>
              No tools advertised. Turn on at least one capability group above.
            </div>
          )}
          <div className="admin-list">
            {preview.advertised_tools.map(t => (
              <div key={t.name} className="admin-row">
                <div className="admin-row-main">
                  <div className="admin-row-line">
                    <strong>{t.name}</strong>
                    <span className="admin-count" style={{ marginLeft: 8 }}>
                      {t.category}
                    </span>
                  </div>
                  <div className="admin-row-sub">{t.description}</div>
                </div>
              </div>
            ))}
          </div>
          {preview.hidden_tools.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
              <strong>Hidden:</strong> {preview.hidden_tools.map(t => `${t.name} (${t.category})`).join(", ")}
            </div>
          )}
        </section>
      )}

      <section className="settings-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h3 style={{ margin: 0 }}>
            External MCP servers <span className="admin-count">({servers?.length ?? 0})</span>
          </h3>
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(s => !s)}>
            {showAdd ? "Cancel" : "Add server"}
          </button>
        </div>
        <p style={{ color: "var(--muted)", fontSize: 13.5, marginTop: 8, lineHeight: 1.55 }}>
          Outbound MCP servers Stohr can call. Once added, their tools become available to AI integrations (the built-in
          /ai/chat surface that consumes them is being built — for now this is the configuration surface).
        </p>
        {showAdd && (
          <AdminMcpServerForm
            onSaved={() => {
              setShowAdd(false)
              load()
            }}
          />
        )}
        <div className="admin-list" style={{ marginTop: 12 }}>
          {(servers ?? []).map(srv => (
            <AdminMcpServerRow key={srv.id} server={srv} onChanged={load} />
          ))}
          {servers && servers.length === 0 && (
            <div style={{ color: "var(--muted)", fontSize: 14 }}>No external MCP servers configured.</div>
          )}
        </div>
      </section>
    </>
  )
}

const AdminMcpServerForm: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [desc, setDesc] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.adminCreateMcpServer({
        name: name.trim(),
        url: url.trim(),
        description: desc.trim() || undefined,
        auth_token: token.trim() || null,
        enabled: true,
      })
      onSaved()
    } catch (e: any) {
      setErr(e?.message ?? "Failed to add server")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-form" style={{ marginTop: 12, display: "grid", gap: 8 }}>
      <input
        aria-label="Name"
        className="input"
        placeholder="Name"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <input
        aria-label="https://example.com/mcp"
        className="input"
        placeholder="https://example.com/mcp"
        value={url}
        onChange={e => setUrl(e.target.value)}
      />
      <input
        aria-label="Description (optional)"
        className="input"
        placeholder="Description (optional)"
        value={desc}
        onChange={e => setDesc(e.target.value)}
      />
      <input
        aria-label="Bearer token (optional)"
        className="input"
        placeholder="Bearer token (optional)"
        value={token}
        onChange={e => setToken(e.target.value)}
        type="password"
      />
      {err && <div style={{ color: "var(--danger, #c0392b)", fontSize: 13 }}>{err}</div>}
      <div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={busy || !name.trim() || !url.trim()}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  )
}

const AdminMcpServerRow: React.FC<{ server: api.McpServer; onChanged: () => void }> = ({ server, onChanged }) => {
  const [probe, setProbe] = useState<{ ok: boolean; tools?: any[]; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const toggleEnabled = async () => {
    setBusy(true)
    try {
      await api.adminUpdateMcpServer(server.id, { enabled: !server.enabled })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete external MCP server "${server.name}"?`)) return
    setBusy(true)
    try {
      await api.adminDeleteMcpServer(server.id)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const runProbe = async () => {
    setBusy(true)
    setProbe(null)
    try {
      setProbe(await api.adminProbeMcpServer(server.id))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin-row">
      <div className="admin-row-main">
        <div className="admin-row-line">
          <strong>{server.name}</strong>
          {!server.enabled && (
            <span className="admin-count" style={{ marginLeft: 8 }}>
              disabled
            </span>
          )}
        </div>
        <div className="admin-row-sub" style={{ wordBreak: "break-all" }}>
          {server.url}
        </div>
        {server.description && <div className="admin-row-sub">{server.description}</div>}
        {probe && (
          <div
            className="admin-row-sub"
            style={{ marginTop: 6, color: probe.ok ? "var(--muted)" : "var(--danger, #c0392b)" }}
          >
            {probe.ok
              ? `OK — ${probe.tools?.length ?? 0} tool(s): ${(probe.tools ?? []).map((t: any) => t.name).join(", ")}`
              : `Probe failed: ${probe.error}`}
          </div>
        )}
      </div>
      <div className="admin-row-actions" style={{ display: "flex", gap: 6 }}>
        <button type="button" className="btn" onClick={runProbe} disabled={busy}>
          Probe
        </button>
        <button type="button" className="btn" onClick={toggleEnabled} disabled={busy}>
          {server.enabled ? "Disable" : "Enable"}
        </button>
        <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
          Delete
        </button>
      </div>
    </div>
  )
}

type AdminUser = api.ManagedUser

// The same list serves the owner (every user, /admin/*) and a team admin
// (the host's team, /team/*). The scope picks the endpoint base and which
// actions exist: quota, ownership and broadcast are owner-only, direct
// member creation is a team route.
type AdminScope = "owner" | "team"
const adminBase = (scope: AdminScope): api.UserAdminBase => (scope === "owner" ? "/admin" : "/team")

const AdminUsers: React.FC<{ meId: number; scope: AdminScope }> = ({ meId, scope }) => {
  const client = useMemo(() => api.userAdminApi(adminBase(scope)), [scope])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<number | null>(null)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [messaging, setMessaging] = useState<AdminUser | null>(null)
  const [broadcasting, setBroadcasting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [tick, setTick] = useState(0)
  const reload = () => setTick(t => t + 1)

  useEffect(() => {
    let cancelled = false
    client.listUsers().then(data => {
      if (cancelled) return
      if (Array.isArray(data)) {
        setUsers(data)
        setError("")
      } else {
        setUsers([])
        setError(data?.error ?? "Failed to load users")
      }
    })
    return () => {
      cancelled = true
    }
  }, [client, tick])

  // one shape for every row action: busy marker, surface the error, refresh
  const act = async (u: AdminUser, run: () => Promise<any>) => {
    setBusy(u.id)
    const res = await run()
    setBusy(null)
    if (res?.error) return alert(res.error)
    reload()
  }

  const suspend = (u: AdminUser) => {
    const reason = prompt(`Suspend @${u.username}? Optional reason (sent to the user):`, "")
    if (reason === null) return
    act(u, () => client.suspendUser(u.id, reason.trim() || undefined))
  }
  const unsuspend = (u: AdminUser) => {
    if (!confirm(`Restore access for @${u.username}?`)) return
    act(u, () => client.unsuspendUser(u.id))
  }
  const resetPassword = async (u: AdminUser) => {
    if (!confirm(`Issue a password reset link for @${u.username}?`)) return
    setBusy(u.id)
    const res = await client.resetUserPassword(u.id)
    setBusy(null)
    if (res.error) return alert(res.error)
    if (res.reset_url) {
      prompt("The email wasn't sent. Copy this reset URL and send it manually:", res.reset_url)
    } else {
      alert("Reset link emailed to the user.")
    }
  }
  const toggleOwner = (u: AdminUser) => {
    if (u.id === meId) return
    if (!confirm(`${u.is_owner ? "Remove" : "Grant"} owner role ${u.is_owner ? "from" : "to"} @${u.username}?`)) return
    act(u, () => api.adminSetOwner(u.id, !u.is_owner))
  }
  const remove = (u: AdminUser) => {
    if (u.id === meId) return alert("Use Settings to delete your own account.")
    if (!confirm(`Permanently delete @${u.username}? All their files will be removed.`)) return
    act(u, () => client.deleteUser(u.id))
  }
  const setQuota = (u: AdminUser) => {
    const currentGb =
      u.storage_quota_bytes > 0 ? String(Math.round((u.storage_quota_bytes / 1024 ** 3) * 100) / 100) : "0"
    const input = prompt(`Storage cap for @${u.username}, in GB (0 = unlimited):`, currentGb)
    if (input === null) return
    const gb = Number(input.trim())
    if (!Number.isFinite(gb) || gb < 0) return alert("Enter a non-negative number of GB.")
    act(u, () => api.adminSetUserQuota(u.id, Math.round(gb * 1024 ** 3)))
  }

  const owner = scope === "owner"

  return (
    <section className="settings-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>
          {owner ? "Users" : "Members"} <span className="admin-count">({users.length})</span>
        </h3>
        {owner ? (
          <button type="button" onClick={() => setBroadcasting(true)}>
            <Mail size={14} strokeWidth={1.75} /> Broadcast
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            <UserPlus size={14} strokeWidth={1.75} /> Add member
          </button>
        )}
      </div>
      {error && <div className="msg err">{error}</div>}
      {!error && users.length === 0 && (
        <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 14 }}>No users yet.</div>
      )}
      <div className="admin-list">
        {users.map(u => (
          <div key={u.id} className="admin-row">
            <div className="admin-row-main">
              <div className="admin-row-line">
                <strong>@{u.username}</strong>
                <span className="admin-row-name">{u.name}</span>
                <span className="admin-row-name">· {u.email}</span>
                {u.is_owner && <span className="admin-pill admin-pill-owner">owner</span>}
                {u.team_admin && !u.is_owner && <span className="admin-pill admin-pill-owner">team admin</span>}
                {u.suspended_at && (
                  <span
                    className="admin-pill"
                    style={{ background: "var(--danger-bg, #fee)", color: "var(--danger, #c00)" }}
                  >
                    suspended
                  </span>
                )}
                {u.id === meId && <span className="admin-pill">you</span>}
                <span className="admin-row-when">{new Date(u.created_at).toLocaleDateString()}</span>
              </div>
              <div className="admin-row-reason">
                {formatBytes(u.storage_bytes)} · {u.file_count} file{u.file_count === 1 ? "" : "s"}
                {" · "}
                {u.storage_quota_bytes > 0 ? `${formatBytes(u.storage_quota_bytes)} cap` : "no cap"}
                {u.suspended_reason && <> · suspended: {u.suspended_reason}</>}
              </div>
            </div>
            <div className="admin-row-actions">
              <button type="button" disabled={busy === u.id} onClick={() => setEditing(u)}>
                Edit
              </button>
              {owner && (
                <button type="button" disabled={busy === u.id} onClick={() => setQuota(u)}>
                  Quota
                </button>
              )}
              <button type="button" disabled={busy === u.id} onClick={() => setMessaging(u)}>
                Message
              </button>
              {owner && (
                <button type="button" disabled={busy === u.id || u.id === meId} onClick={() => toggleOwner(u)}>
                  {u.is_owner ? "Revoke owner" : "Make owner"}
                </button>
              )}
              {!u.is_owner && (
                <button type="button" disabled={busy === u.id} onClick={() => resetPassword(u)}>
                  Reset password
                </button>
              )}
              {u.id !== meId &&
                !u.is_owner &&
                (u.suspended_at ? (
                  <button type="button" disabled={busy === u.id} onClick={() => unsuspend(u)}>
                    Unsuspend
                  </button>
                ) : (
                  <button type="button" disabled={busy === u.id} onClick={() => suspend(u)}>
                    Suspend
                  </button>
                ))}
              {u.id !== meId && (owner || !u.is_owner) && (
                <button type="button" className="danger" disabled={busy === u.id} onClick={() => remove(u)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <AdminUserEditModal
          user={editing}
          client={client}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
      {messaging && <AdminMessageModal target={messaging} client={client} onClose={() => setMessaging(null)} />}
      {broadcasting && <AdminBroadcastModal onClose={() => setBroadcasting(false)} />}
      {adding && <TeamMemberCreateModal onClose={() => setAdding(false)} onCreated={reload} />}
    </section>
  )
}

type UserAdminClient = ReturnType<typeof api.userAdminApi>

const AdminUserEditModal: React.FC<{
  user: AdminUser
  client: UserAdminClient
  onClose: () => void
  onSaved: () => void
}> = ({ user, client, onClose, onSaved }) => {
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [username, setUsername] = useState(user.username)
  const [teamAdmin, setTeamAdmin] = useState(!!user.team_admin)
  const [err, setErr] = useState("")
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setErr("")
    const patch: { name?: string; email?: string; username?: string; team_admin?: boolean } = {}
    if (name.trim() !== user.name) patch.name = name.trim()
    if (email.trim().toLowerCase() !== user.email) patch.email = email.trim().toLowerCase()
    if (username.trim().toLowerCase() !== user.username) patch.username = username.trim().toLowerCase()
    if (teamAdmin !== !!user.team_admin) patch.team_admin = teamAdmin
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    const res = await client.editUser(user.id, patch)
    setSaving(false)
    if ((res as any).error) {
      setErr((res as any).error)
      return
    }
    onSaved()
  }

  return (
    <Modal title={`Edit @${user.username}`} onClose={onClose}>
      {err && <div className="msg err">{err}</div>}
      <label htmlFor="adminusereditmodal-display-name" style={{ fontSize: 13, color: "var(--muted)" }}>
        Display name
      </label>
      <input id="adminusereditmodal-display-name" value={name} onChange={e => setName(e.target.value)} />
      <label htmlFor="adminusereditmodal-email" style={{ fontSize: 13, color: "var(--muted)" }}>
        Email
      </label>
      <input id="adminusereditmodal-email" value={email} onChange={e => setEmail(e.target.value)} type="email" />
      <label htmlFor="adminusereditmodal-username" style={{ fontSize: 13, color: "var(--muted)" }}>
        Username
      </label>
      <input
        id="adminusereditmodal-username"
        value={username}
        onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
      />
      {/* an owner administers root implicitly; the flag is for everyone else */}
      {!user.is_owner && (
        <label className="scope-check" style={{ margin: "12px 0 16px" }}>
          <input type="checkbox" checked={teamAdmin} onChange={e => setTeamAdmin(e.target.checked)} />
          Team admin — manages this team's members, invites and audit log
        </label>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  )
}

// A team admin adding someone directly. Without a password the API mints a
// one-time set-password link on this team's host; it is shown once here
// (and emailed when the instance can send mail).
const TeamMemberCreateModal: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [teamAdmin, setTeamAdmin] = useState(false)
  const [err, setErr] = useState("")
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ email: string; set_password_url: string | null; emailed: boolean } | null>(
    null,
  )

  const create = async () => {
    setErr("")
    if (!email.trim()) return setErr("Email is required")
    if (password && password.length < 8) return setErr("Password must be at least 8 characters")
    setSaving(true)
    const res = await api.teamCreateUser({
      email: email.trim(),
      name: name.trim() || undefined,
      username: username.trim() || undefined,
      password: password || undefined,
      team_admin: teamAdmin,
    })
    setSaving(false)
    if (res.error) return setErr(res.error)
    setResult({ email: res.email, set_password_url: res.set_password_url, emailed: res.emailed })
    onCreated()
  }

  if (result) {
    return (
      <Modal title="Member added" onClose={onClose}>
        <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.5, margin: "0 0 12px" }}>
          <strong style={{ color: "var(--text)" }}>{result.email}</strong> can sign in at{" "}
          <strong style={{ color: "var(--text)" }}>{window.location.origin}</strong>.
        </p>
        {result.set_password_url ? (
          <div className="msg">
            <div style={{ fontWeight: 500, marginBottom: 4 }}>
              {result.emailed
                ? "Their set-password link, also emailed to them. Shown once."
                : "Email is off — send them this set-password link. Shown once."}
            </div>
            <div className="share-link" style={{ fontSize: 11, wordBreak: "break-all" }}>
              {result.set_password_url}
            </div>
            <div style={{ marginTop: 6 }}>
              <button type="button" onClick={() => navigator.clipboard.writeText(result.set_password_url ?? "")}>
                <Copy size={14} strokeWidth={1.75} /> Copy link
              </button>
            </div>
          </div>
        ) : (
          <div className="msg ok">They sign in with the password you set.</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Add a member" onClose={onClose}>
      {err && <div className="msg err">{err}</div>}
      <label htmlFor="teammembercreatemodal-email" style={{ fontSize: 13, color: "var(--muted)" }}>
        Email
      </label>
      <input
        id="teammembercreatemodal-email"
        type="email"
        placeholder="alice@example.com"
        value={email}
        onChange={e => setEmail(e.target.value)}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
      />
      <label htmlFor="teammembercreatemodal-name-optional" style={{ fontSize: 13, color: "var(--muted)" }}>
        Name (optional)
      </label>
      <input id="teammembercreatemodal-name-optional" value={name} onChange={e => setName(e.target.value)} />
      <label
        htmlFor="teammembercreatemodal-username-optional-derived-from-the-email-otherwise"
        style={{ fontSize: 13, color: "var(--muted)" }}
      >
        Username (optional, derived from the email otherwise)
      </label>
      <input
        id="teammembercreatemodal-username-optional-derived-from-the-email-otherwise"
        value={username}
        onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <label
        htmlFor="teammembercreatemodal-password-optional-leave-blank-for-a-set-password-link"
        style={{ fontSize: 13, color: "var(--muted)" }}
      >
        Password (optional — leave blank for a set-password link)
      </label>
      <input
        id="teammembercreatemodal-password-optional-leave-blank-for-a-set-password-link"
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        autoComplete="new-password"
      />
      <label className="scope-check" style={{ margin: "12px 0 16px" }}>
        <input type="checkbox" checked={teamAdmin} onChange={e => setTeamAdmin(e.target.checked)} />
        Team admin
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={saving} onClick={create}>
          {saving ? "Adding…" : "Add member"}
        </button>
      </div>
    </Modal>
  )
}

const AdminMessageModal: React.FC<{ target: AdminUser; client: UserAdminClient; onClose: () => void }> = ({
  target,
  client,
  onClose,
}) => {
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [err, setErr] = useState("")
  const [sending, setSending] = useState(false)

  const send = async () => {
    setErr("")
    if (!subject.trim() || !body.trim()) {
      setErr("Subject and body are required.")
      return
    }
    setSending(true)
    const res = await client.messageUser(target.id, subject.trim(), body.trim())
    setSending(false)
    if ((res as any).error) {
      setErr((res as any).error)
      return
    }
    onClose()
  }

  return (
    <Modal title={`Message @${target.username}`} onClose={onClose}>
      {err && <div className="msg err">{err}</div>}
      <input
        aria-label="Subject"
        placeholder="Subject"
        value={subject}
        onChange={e => setSubject(e.target.value)}
        autoFocus
      />
      <textarea
        aria-label="Message"
        placeholder="Message"
        rows={8}
        value={body}
        onChange={e => setBody(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={sending} onClick={send}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </Modal>
  )
}

const AdminBroadcastModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [err, setErr] = useState("")
  const [sending, setSending] = useState(false)

  const send = async () => {
    setErr("")
    if (!subject.trim() || !body.trim()) {
      setErr("Subject and body are required.")
      return
    }
    if (!confirm("Send this message to every active user on this instance?")) return
    setSending(true)
    const res = await api.adminBroadcast(subject.trim(), body.trim())
    setSending(false)
    if (res.error) {
      setErr(res.error)
      return
    }
    alert(`Delivered to ${res.delivered} user${res.delivered === 1 ? "" : "s"}.`)
    onClose()
  }

  return (
    <Modal title="Broadcast to all users" onClose={onClose}>
      {err && <div className="msg err">{err}</div>}
      <input
        aria-label="Subject"
        placeholder="Subject"
        value={subject}
        onChange={e => setSubject(e.target.value)}
        autoFocus
      />
      <textarea
        aria-label="Message"
        placeholder="Message"
        rows={8}
        value={body}
        onChange={e => setBody(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={sending} onClick={send}>
          {sending ? "Sending…" : "Send to all"}
        </button>
      </div>
    </Modal>
  )
}

// Owner: every invite for the root team. Team admin: the host team's. The
// signup link is built on this origin, which is the host the invite redeems on.
const AdminInvites: React.FC<{ scope: AdminScope }> = ({ scope }) => {
  const client = useMemo(() => api.userAdminApi(adminBase(scope)), [scope])
  const [filter, setFilter] = useState<"all" | "unused" | "used">("unused")
  const [invites, setInvites] = useState<api.ManagedInvite[]>([])
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  // the token exists only in the create response; the server keeps a hash
  const [justCreated, setJustCreated] = useState<{ id: number; token: string } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const reload = () => setTick(t => t + 1)

  useEffect(() => {
    let cancelled = false
    client.listInvites(filter).then(data => {
      if (!cancelled) setInvites(Array.isArray(data) ? data : [])
    })
    return () => {
      cancelled = true
    }
  }, [client, filter, tick])

  const inviteLink = (token: string) => `${window.location.origin}/signup?invite=${token}`

  const create = async () => {
    setError("")
    const res = await client.createInvite(email.trim() || undefined)
    if (res.error) return setError(res.error)
    if (res.token && res.id) setJustCreated({ id: res.id, token: res.token })
    setEmail("")
    if (filter === "used") setFilter("unused")
    else reload()
  }

  const remove = async (id: number) => {
    if (!confirm("Delete this invite?")) return
    setBusy(id)
    const res = await client.deleteInvite(id)
    setBusy(null)
    if (res.error) return alert(res.error)
    if (justCreated?.id === id) setJustCreated(null)
    reload()
  }

  return (
    <section className="settings-card">
      <h3>
        {scope === "owner" ? "All invites" : "Invites"} <span className="admin-count">({invites.length})</span>
      </h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input
          aria-label="Email (optional, locks the invite to this address)"
          type="email"
          placeholder="Email (optional, locks the invite to this address)"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === "Enter" && create()}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button type="button" className="primary" onClick={create}>
          <Mail size={14} strokeWidth={1.75} /> Create invite
        </button>
      </div>
      {error && <div className="msg err">{error}</div>}
      {justCreated && (
        <div className="msg" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>Copy this link now — we don't store it.</div>
          <div className="share-link" style={{ fontSize: 11, wordBreak: "break-all" }}>
            {inviteLink(justCreated.token)}
          </div>
          <div style={{ marginTop: 6 }}>
            <button type="button" onClick={() => navigator.clipboard.writeText(inviteLink(justCreated.token))}>
              <Copy size={14} strokeWidth={1.75} /> Copy link
            </button>
          </div>
        </div>
      )}
      <div className="admin-tabs">
        <button type="button" className={filter === "unused" ? "active" : ""} onClick={() => setFilter("unused")}>
          Unused
        </button>
        <button type="button" className={filter === "used" ? "active" : ""} onClick={() => setFilter("used")}>
          Used
        </button>
        <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
          All
        </button>
      </div>
      {invites.length === 0 && (
        <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 14 }}>
          No {filter === "all" ? "" : filter} invites.
        </div>
      )}
      <div className="admin-list">
        {invites.map(inv => (
          <div key={inv.id} className="admin-row">
            <div className="admin-row-main">
              <div className="admin-row-line">
                <strong>{inv.email ?? "Open invite"}</strong>
                {inv.invited_by_username && <span className="admin-row-name">from @{inv.invited_by_username}</span>}
                {inv.used_by_username && (
                  <span className="admin-pill admin-pill-used">used by @{inv.used_by_username}</span>
                )}
                <span className="admin-row-when">{new Date(inv.created_at).toLocaleDateString()}</span>
              </div>
            </div>
            <div className="admin-row-actions">
              {!inv.used_at && (
                <button type="button" className="danger" disabled={busy === inv.id} onClick={() => remove(inv.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

type AdminStatsData = {
  users: number
  folders: number
  files: number
  total_storage_bytes: number
  invites_total: number
  invites_used: number
  invites_unused: number
  requests_pending: number
}

const AdminContact: React.FC = () => {
  const [filter, setFilter] = useState<"new" | "read" | "handled" | "spam" | "all">("new")
  const [items, setItems] = useState<api.ContactMessage[]>([])
  const [counts, setCounts] = useState<Record<api.ContactMessageStatus, number>>({
    new: 0,
    read: 0,
    handled: 0,
    spam: 0,
  })
  const [busy, setBusy] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const load = async () => {
    const res = await api.adminListContact(filter)
    setItems(Array.isArray(res?.items) ? res.items : [])
    setCounts(res?.counts ?? { new: 0, read: 0, handled: 0, spam: 0 })
  }
  useEffect(() => {
    load()
  }, [filter])

  const setStatus = async (id: number, status: api.ContactMessageStatus) => {
    setBusy(id)
    const res = await api.adminUpdateContact(id, status)
    setBusy(null)
    if (res.error) return alert(res.error)
    await load()
  }
  const remove = async (id: number) => {
    if (!confirm("Delete this message? This cannot be undone.")) return
    setBusy(id)
    const res = await api.adminDeleteContact(id)
    setBusy(null)
    if (res.error) return alert(res.error)
    await load()
  }
  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Mark as "read" when opening a card.
  const open = async (m: api.ContactMessage) => {
    toggle(m.id)
    if (!expanded.has(m.id) && m.status === "new") {
      await api.adminUpdateContact(m.id, "read")
      await load()
    }
  }

  const tabs: Array<{ key: typeof filter; label: string; count?: number }> = [
    { key: "new", label: "New", count: counts.new },
    { key: "read", label: "Read", count: counts.read },
    { key: "handled", label: "Handled", count: counts.handled },
    { key: "spam", label: "Spam", count: counts.spam },
    { key: "all", label: "All" },
  ]

  return (
    <section className="settings-card">
      <h3>
        Contact submissions <span className="admin-count">({items.length})</span>
      </h3>
      <div className="admin-tabs">
        {tabs.map(t => (
          <button
            type="button"
            key={t.key}
            className={filter === t.key ? "active" : ""}
            onClick={() => setFilter(t.key)}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 && <span className="admin-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      {items.length === 0 && (
        <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 14 }}>
          No {filter === "all" ? "" : filter} messages.
        </div>
      )}
      <div className="contact-cards">
        {items.map(m => {
          const isOpen = expanded.has(m.id)
          return (
            <article key={m.id} className={`contact-card status-${m.status}${isOpen ? " open" : ""}`}>
              <header className="contact-card-head" onClick={() => open(m)}>
                <div className="contact-card-meta">
                  <span className={`contact-status-pill status-${m.status}`}>{m.status}</span>
                  <span className="contact-card-time">{new Date(m.created_at).toLocaleString()}</span>
                </div>
                <h4 className="contact-card-subject">{m.subject}</h4>
                <div className="contact-card-from">
                  <strong>{m.name}</strong>
                  <span className="muted"> · </span>
                  <a href={`mailto:${m.email}?subject=${encodeURIComponent("Re: " + m.subject)}`}>{m.email}</a>
                </div>
                {!isOpen && (
                  <p className="contact-card-preview">
                    {m.message.length > 180 ? m.message.slice(0, 180) + "…" : m.message}
                  </p>
                )}
              </header>
              {isOpen && (
                <>
                  <div className="contact-card-body">
                    <pre className="contact-card-message">{m.message}</pre>
                  </div>
                  <footer className="contact-card-foot">
                    <div className="contact-card-trace">
                      {m.ip && <span title="Origin IP">IP {m.ip}</span>}
                      {m.handled_by_user && (
                        <span>
                          handled by <strong>@{m.handled_by_user.username}</strong>
                          {m.handled_at && <> · {new Date(m.handled_at).toLocaleDateString()}</>}
                        </span>
                      )}
                    </div>
                    <div className="contact-card-actions">
                      {m.status !== "handled" && (
                        <button
                          type="button"
                          className="primary"
                          onClick={() => setStatus(m.id, "handled")}
                          disabled={busy === m.id}
                        >
                          Mark handled
                        </button>
                      )}
                      {m.status === "handled" && (
                        <button type="button" onClick={() => setStatus(m.id, "new")} disabled={busy === m.id}>
                          Reopen
                        </button>
                      )}
                      {m.status !== "spam" && (
                        <button type="button" onClick={() => setStatus(m.id, "spam")} disabled={busy === m.id}>
                          Mark spam
                        </button>
                      )}
                      <button
                        type="button"
                        className="danger"
                        onClick={() => remove(m.id)}
                        disabled={busy === m.id}
                        style={{ marginLeft: "auto" }}
                      >
                        Delete
                      </button>
                    </div>
                  </footer>
                </>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

const AdminAudit: React.FC<{ scope: AdminScope }> = ({ scope }) => {
  const client = useMemo(() => api.userAdminApi(adminBase(scope)), [scope])
  const [events, setEvents] = useState<api.AuditRow[]>([])
  const [eventFilter, setEventFilter] = useState("")
  // the filter the list was last loaded with; Refresh applies the typed one
  const [applied, setApplied] = useState("")
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    client.listAudit({ event: applied || undefined, limit: 200 }).then(data => {
      if (cancelled) return
      setEvents(Array.isArray(data) ? data : [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [client, applied, tick])

  const load = () => {
    setApplied(eventFilter)
    setTick(t => t + 1)
  }

  const tone = (event: string): string => {
    if (
      event.includes("fail") ||
      event.includes("rate_limited") ||
      event.includes("locked") ||
      event.includes("disabled")
    )
      return "warn"
    if (
      event.startsWith("login.ok") ||
      event.includes("enabled") ||
      event.endsWith(".created") ||
      event === "signup.ok"
    )
      return "ok"
    return "info"
  }

  const presets = [
    "",
    "login.ok",
    "login.fail",
    "login.rate_limited",
    "login.mfa_required",
    "mfa.enabled",
    "mfa.disabled",
    "signup.ok",
    ...(scope === "team"
      ? ["team.user_created", "team.user_deleted", "admin.user_edited", "admin.user_suspended"]
      : ["admin.team_created", "admin.team_edited", "admin.team_deleted"]),
  ]

  return (
    <section className="settings-card">
      <h3>Audit log</h3>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
        Most recent 200 security-relevant events.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <select value={eventFilter} onChange={e => setEventFilter(e.target.value)} style={{ minWidth: 220 }}>
          {presets.map(p => (
            <option key={p} value={p}>
              {p === "" ? "All events" : p}
            </option>
          ))}
        </select>
        <input
          aria-label="Or type a custom event…"
          placeholder="Or type a custom event…"
          value={eventFilter}
          onChange={e => setEventFilter(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>
      {loading && <div style={{ color: "var(--muted)" }}>Loading…</div>}
      {!loading && events.length === 0 && <div style={{ color: "var(--muted)" }}>No events</div>}
      {!loading && events.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {events.map(ev => (
            <div key={ev.id} className={`audit-row audit-${tone(ev.event)}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <code style={{ fontSize: 12, fontWeight: 600 }}>{ev.event}</code>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{new Date(ev.created_at).toLocaleString()}</span>
              </div>
              <div
                style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}
              >
                {ev.actor && <span>{ev.actor}</span>}
                {!ev.actor && ev.username && <span>@{ev.username}</span>}
                {!ev.actor && !ev.username && ev.user_email && <span>{ev.user_email}</span>}
                {!ev.actor && !ev.username && !ev.user_email && ev.user_id === null && <span>anonymous</span>}
                {ev.ip && <span>· {ev.ip}</span>}
                {ev.metadata && <span>· {ev.metadata}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

const AdminStats: React.FC = () => {
  const [s, setS] = useState<AdminStatsData | null>(null)

  useEffect(() => {
    api
      .adminGetStats()
      .then(setS)
      .catch(() => setS(null))
  }, [])

  if (!s)
    return (
      <section className="settings-card">
        <h3>Stats</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>Loading…</div>
      </section>
    )

  const stats: Array<{ label: string; value: string }> = [
    { label: "Users", value: String(s.users) },
    { label: "Total storage", value: formatBytes(s.total_storage_bytes) },
    { label: "Files", value: String(s.files) },
    { label: "Folders", value: String(s.folders) },
    { label: "Pending requests", value: String(s.requests_pending) },
    { label: "Active invites", value: String(s.invites_unused) },
    { label: "Used invites", value: String(s.invites_used) },
    { label: "Total invites", value: String(s.invites_total) },
  ]

  return (
    <section className="settings-card">
      <h3>Stats</h3>
      <div className="admin-stats">
        {stats.map(stat => (
          <div key={stat.label} className="admin-stat">
            <div className="admin-stat-value">{stat.value}</div>
            <div className="admin-stat-label">{stat.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// Team admin's own team: usage against the team cap, members, invites, audit.
// Members/invites/audit are the owner's admin components pointed at /team.
type TeamSection = "overview" | "members" | "invites" | "audit"

const TEAM_SECTIONS: Array<{ id: TeamSection; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "members", label: "Members" },
  { id: "invites", label: "Invites" },
  { id: "audit", label: "Audit" },
]

const TeamView: React.FC<{ section?: string }> = ({ section: requested }) => {
  const me = api.getUser()
  const section: TeamSection = TEAM_SECTIONS.some(s => s.id === requested) ? (requested as TeamSection) : "overview"

  if (!me || (!me.team_admin && !me.is_owner)) {
    return (
      <div className="main">
        <div className="toolbar">
          <div className="crumbs">
            <span className="current">Team</span>
          </div>
        </div>
        <div className="content">
          <div className="empty">
            <div>Team admin access required</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs">
          <span className="current">{me.team?.name ?? "Team"}</span>
        </div>
      </div>
      <div className="content">
        <div className="admin-sections">
          {TEAM_SECTIONS.map(s => (
            <button
              key={s.id}
              type="button"
              className={section === s.id ? "active" : ""}
              onClick={() => navigate(`/app/team/${s.id}`)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {section === "overview" && <TeamOverview />}
        {section === "members" && <AdminUsers meId={me.id} scope="team" />}
        {section === "invites" && <AdminInvites scope="team" />}
        {section === "audit" && <AdminAudit scope="team" />}
      </div>
    </div>
  )
}

const quotaUnlimited = (bytes: number | null | undefined): boolean => bytes == null || bytes <= 0

const TeamOverview: React.FC = () => {
  const [team, setTeam] = useState<api.TeamInfo | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    api
      .getTeam()
      .then(t => {
        if (cancelled) return
        if (t.error) setError(t.error)
        else setTeam(t)
      })
      .catch(e => {
        if (!cancelled) setError(e?.message ?? "Failed to load team")
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!team) {
    return (
      <section className="settings-card">
        <h3>Team</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>{error || "Loading…"}</div>
      </section>
    )
  }

  const unlimited = quotaUnlimited(team.quota_bytes)
  const pct = unlimited ? 0 : Math.min(100, (team.usage.total / (team.quota_bytes as number)) * 100)

  return (
    <>
      <section className="settings-card">
        <h3>
          {team.name} <span className="admin-count">{team.slug}</span>
        </h3>
        {team.suspended_at && (
          <div className="msg err" style={{ marginTop: 0, marginBottom: 12 }}>
            This team is suspended. Members cannot sign in until the instance owner lifts it.
          </div>
        )}
        <div className="sub-current">
          <div className="sub-tier-row">
            <div>
              <div className="sub-tier">{unlimited ? "No team cap" : "Team storage cap"}</div>
              <div className="sub-status">
                {unlimited ? "Bounded only by the server's disk." : "Cap set by the instance owner."}
              </div>
            </div>
            <div className="sub-usage-text">
              {formatBytes(team.usage.total)}
              <span style={{ color: "var(--muted)" }}>
                {unlimited ? " used" : ` of ${formatBytes(team.quota_bytes as number)}`}
              </span>
            </div>
          </div>
          {!unlimited && (
            <div className="sub-bar">
              <div
                className="sub-fill"
                style={{ width: `${pct}%`, background: pct > 90 ? "var(--danger)" : "var(--brand)" }}
              />
            </div>
          )}
          <div className="sub-breakdown">
            <span>
              Active <strong>{formatBytes(team.usage.active)}</strong>
            </span>
            <span>
              Trash <strong>{formatBytes(team.usage.trash)}</strong>
            </span>
            <span>
              Versions <strong>{formatBytes(team.usage.versions)}</strong>
            </span>
          </div>
        </div>
      </section>
      <section className="settings-card" style={{ marginTop: 16 }}>
        <h3>At a glance</h3>
        <div className="admin-stats">
          <div className="admin-stat">
            <div className="admin-stat-value">{team.user_count}</div>
            <div className="admin-stat-label">Members</div>
          </div>
          <div className="admin-stat">
            <div className="admin-stat-value" style={{ fontSize: 15, wordBreak: "break-all" }}>
              {team.base_url.replace(/^https?:\/\//, "")}
            </div>
            <div className="admin-stat-label">Host</div>
          </div>
          <div className="admin-stat">
            <div className="admin-stat-value" style={{ fontSize: 15 }}>
              {new Date(team.created_at).toLocaleDateString()}
            </div>
            <div className="admin-stat-label">Created</div>
          </div>
        </div>
      </section>
      {team.id !== 1 && <TeamDomainSettings />}
    </>
  )
}

const TeamDomainSettings: React.FC = () => {
  const [state, setState] = useState<api.TeamDomain | null>(null)
  const [domain, setDomain] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState("")

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await api.getTeamDomain()
        if (cancelled) return
        if (data.error) setError(data.error)
        else {
          setState(data)
          setDomain(data.domain ?? "")
        }
      } catch {
        if (!cancelled) setError("Could not load domain settings. Reload to try again.")
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const act = async (run: () => Promise<api.TeamDomain>, removing = false) => {
    setBusy(true)
    setError("")
    try {
      const data = await run()
      if (data.error) {
        setError(data.error)
        return
      }
      const oldDomain = state?.domain
      const fallback = state?.default_url
      setState({ ...data, enabled: state?.enabled })
      setDomain(data.domain ?? "")
      if (removing && oldDomain === window.location.hostname && fallback) {
        window.location.assign(`${fallback}/app/team/overview`)
      }
    } catch {
      setError("Could not update the domain. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-card" style={{ marginTop: 16 }}>
      <h3>Custom domain</h3>
      <p className="sub-status">Use your own address for this team. Your Stohr address stays available.</p>
      {error && (
        <div className="msg err" role="alert">
          {error}
        </div>
      )}
      {!state ? (
        <p>{error ? "" : "Loading domain settings…"}</p>
      ) : !state.enabled ? (
        <p>Custom domains are unavailable on this instance.</p>
      ) : (
        <>
          <label htmlFor="team-domain">Domain</label>
          <input
            id="team-domain"
            value={domain}
            placeholder="files.yourcompany.com"
            disabled={busy || !!state.domain}
            onChange={e => setDomain(e.target.value)}
            autoCapitalize="none"
            spellCheck={false}
            style={{ width: "100%", margin: "8px 0 12px" }}
          />
          {!state.domain ? (
            <button
              type="button"
              className="primary"
              disabled={busy || !domain.trim()}
              onClick={() => act(() => api.setTeamDomain(domain))}
            >
              {busy ? "Saving…" : "Add domain"}
            </button>
          ) : (
            <>
              <p role="status">
                {state.verified
                  ? "Ownership verified. HTTPS is issued on the first visit once DNS points here."
                  : "Waiting for DNS verification."}
              </p>
              <p className="sub-status">
                Add these records with your DNS provider. For a root domain, use A/AAAA records pointing to this server
                instead of CNAME.
              </p>
              <div className="domain-records">
                {[
                  { type: "CNAME", name: state.domain, value: state.target },
                  { type: "TXT", name: state.verification_name, value: state.verification_value },
                ].map(record => (
                  <div className="domain-record" key={record.type}>
                    <strong>{record.type}</strong>
                    <dl>
                      {(["name", "value"] as const).map(field => (
                        <div key={field}>
                          <dt>{field === "name" ? "Name" : "Value"}</dt>
                          <dd>
                            <code>{record[field]}</code>
                            <button
                              type="button"
                              aria-label={`Copy ${record.type} ${field}`}
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(record[field] ?? "")
                                  setCopied(`${record.type} ${field} copied.`)
                                } catch {
                                  setCopied("Could not copy. Select the record text to copy it manually.")
                                }
                              }}
                            >
                              <Copy size={14} /> Copy
                            </button>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
              {copied && (
                <p className="sub-status" role="status">
                  {copied}
                </p>
              )}
              <p className="sub-status">
                Sign in again on your custom domain. Register a new passkey there; passkeys from your Stohr address stay
                on that address.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
                {!state.verified && (
                  <button type="button" className="primary" disabled={busy} onClick={() => act(api.verifyTeamDomain)}>
                    {busy ? "Checking DNS…" : "Verify DNS"}
                  </button>
                )}
                {state.verified && (
                  <a href={`https://${state.domain}`} target="_blank" rel="noreferrer">
                    Open domain
                  </a>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm("Remove this custom domain? Members can still use the team's Stohr address."))
                      act(api.removeTeamDomain, true)
                  }}
                >
                  Remove domain
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

// Root owner's control plane: every team on the instance.
const gbToBytes = (gb: number): number => Math.round(gb * 1024 ** 3)
const bytesToGb = (bytes: number | null | undefined): string =>
  quotaUnlimited(bytes) ? "0" : String(Math.round(((bytes as number) / 1024 ** 3) * 100) / 100)
// team 1 is the owner's own team; it cannot be suspended or deleted
const ROOT_TEAM_ID = 1

const dangerPill: React.CSSProperties = { background: "var(--danger-bg, #fee)", color: "var(--danger, #c00)" }

const AdminTeams: React.FC = () => {
  const [filter, setFilter] = useState<"live" | "deleted" | "all">("live")
  const [teams, setTeams] = useState<api.AdminTeam[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<api.AdminTeam | null>(null)
  const [deleting, setDeleting] = useState<api.AdminTeam | null>(null)
  const [tick, setTick] = useState(0)
  const reload = () => setTick(t => t + 1)

  useEffect(() => {
    let cancelled = false
    api.adminListTeams(filter).then(data => {
      if (cancelled) return
      if (Array.isArray(data)) {
        setTeams(data)
        setError("")
      } else {
        setTeams([])
        setError(data?.error ?? "Failed to load teams")
      }
    })
    return () => {
      cancelled = true
    }
  }, [filter, tick])

  const act = async (t: api.AdminTeam, run: () => Promise<{ error?: string }>) => {
    setBusy(t.id)
    const res = await run()
    setBusy(null)
    if (res.error) return alert(res.error)
    reload()
  }
  const suspend = (t: api.AdminTeam) => {
    if (!confirm(`Suspend ${t.name}? Every request on ${t.base_url} is refused until it is unsuspended.`)) return
    act(t, () => api.adminUpdateTeam(t.id, { suspended: true }))
  }
  const unsuspend = (t: api.AdminTeam) => {
    if (!confirm(`Unsuspend ${t.name}?`)) return
    act(t, () => api.adminUpdateTeam(t.id, { suspended: false }))
  }
  const restore = (t: api.AdminTeam) => {
    if (!confirm(`Restore ${t.name}? Its host starts resolving again and the purge is cancelled.`)) return
    act(t, () => api.adminRestoreTeam(t.id))
  }

  return (
    <section className="settings-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>
          Teams <span className="admin-count">({teams.length})</span>
        </h3>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          <Plus size={14} strokeWidth={1.75} /> New team
        </button>
      </div>
      <div className="admin-tabs" style={{ marginTop: 12 }}>
        <button type="button" className={filter === "live" ? "active" : ""} onClick={() => setFilter("live")}>
          Live
        </button>
        <button type="button" className={filter === "deleted" ? "active" : ""} onClick={() => setFilter("deleted")}>
          Deleted
        </button>
        <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
          All
        </button>
      </div>
      {error && <div className="msg err">{error}</div>}
      {!error && teams.length === 0 && (
        <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 14 }}>
          No {filter === "live" ? "" : `${filter} `}teams.
        </div>
      )}
      <div className="admin-list">
        {teams.map(t => {
          const isRoot = t.id === ROOT_TEAM_ID
          const unlimited = quotaUnlimited(t.quota_bytes)
          const pct = unlimited ? 0 : Math.min(100, (t.usage.total / (t.quota_bytes as number)) * 100)
          return (
            <div key={t.id} className="admin-row">
              <div className="admin-row-main">
                <div className="admin-row-line">
                  <strong>{t.name}</strong>
                  <code style={{ fontSize: 12 }}>{t.slug}</code>
                  {isRoot && <span className="admin-pill admin-pill-owner">root</span>}
                  {t.suspended_at && (
                    <span className="admin-pill" style={dangerPill}>
                      suspended
                    </span>
                  )}
                  {t.deleted_at && (
                    <span className="admin-pill" style={dangerPill}>
                      deleting
                    </span>
                  )}
                  <span className="admin-row-when">{new Date(t.created_at).toLocaleDateString()}</span>
                </div>
                <div className="admin-row-reason">
                  <a href={t.base_url} target="_blank" rel="noreferrer">
                    {t.base_url.replace(/^https?:\/\//, "")}
                  </a>
                  {" · "}
                  {t.user_count} user{t.user_count === 1 ? "" : "s"}
                  {" · "}
                  {formatBytes(t.usage.total)}
                  {unlimited ? " used · no cap" : ` of ${formatBytes(t.quota_bytes as number)}`}
                </div>
                {!unlimited && (
                  <div className="sub-bar" style={{ maxWidth: 260, marginTop: 6 }}>
                    <div
                      className="sub-fill"
                      style={{ width: `${pct}%`, background: pct > 90 ? "var(--danger)" : "var(--brand)" }}
                    />
                  </div>
                )}
              </div>
              <div className="admin-row-actions">
                {t.deleted_at ? (
                  <button type="button" disabled={busy === t.id} onClick={() => restore(t)}>
                    Restore
                  </button>
                ) : (
                  <>
                    <button type="button" disabled={busy === t.id} onClick={() => setEditing(t)}>
                      Edit
                    </button>
                    {!isRoot &&
                      (t.suspended_at ? (
                        <button type="button" disabled={busy === t.id} onClick={() => unsuspend(t)}>
                          Unsuspend
                        </button>
                      ) : (
                        <button type="button" disabled={busy === t.id} onClick={() => suspend(t)}>
                          Suspend
                        </button>
                      ))}
                    {!isRoot && (
                      <button type="button" className="danger" disabled={busy === t.id} onClick={() => setDeleting(t)}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {creating && <AdminTeamCreateModal onClose={() => setCreating(false)} onCreated={reload} />}
      {editing && (
        <AdminTeamEditModal
          team={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
      {deleting && (
        <AdminTeamDeleteModal
          team={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            reload()
          }}
        />
      )}
    </section>
  )
}

const AdminTeamCreateModal: React.FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")
  const [quotaGb, setQuotaGb] = useState("0")
  const [adminEmail, setAdminEmail] = useState("")
  const [adminName, setAdminName] = useState("")
  const [adminUsername, setAdminUsername] = useState("")
  const [err, setErr] = useState("")
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{
    team: api.AdminTeam
    admin: { email: string }
    set_password_url: string
    emailed: boolean
  } | null>(null)

  const rootDomain =
    document.querySelector('meta[name="stohr-root-domain"]')?.getAttribute("content") ?? window.location.hostname

  const create = async () => {
    setErr("")
    if (!slug.trim()) return setErr("Slug is required")
    if (!adminEmail.trim()) return setErr("The first admin's email is required")
    const gb = Number(quotaGb.trim() || "0")
    if (!Number.isFinite(gb) || gb < 0) return setErr("Storage cap must be a non-negative number of GB (0 = unlimited)")
    setSaving(true)
    const res = await api.adminCreateTeam({
      slug: slug.trim(),
      name: name.trim() || undefined,
      quota_bytes: gb > 0 ? gbToBytes(gb) : null,
      admin_email: adminEmail.trim(),
      admin_name: adminName.trim() || undefined,
      admin_username: adminUsername.trim() || undefined,
    })
    setSaving(false)
    if (res.error) return setErr(res.error)
    setResult(res)
    onCreated()
  }

  if (result) {
    return (
      <Modal title={`${result.team.name} is ready`} onClose={onClose}>
        <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.5, margin: "0 0 12px" }}>
          Lives at{" "}
          <a href={result.team.base_url} target="_blank" rel="noreferrer">
            {result.team.base_url}
          </a>
          . First admin: <strong style={{ color: "var(--text)" }}>{result.admin.email}</strong>.
        </p>
        <div className="msg">
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {result.emailed
              ? "Their set-password link, also emailed to them. Shown once."
              : "Email is off — send them this set-password link. Shown once."}
          </div>
          <div className="share-link" style={{ fontSize: 11, wordBreak: "break-all" }}>
            {result.set_password_url}
          </div>
          <div style={{ marginTop: 6 }}>
            <button type="button" onClick={() => navigator.clipboard.writeText(result.set_password_url)}>
              <Copy size={14} strokeWidth={1.75} /> Copy link
            </button>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="New team" onClose={onClose}>
      {err && <div className="msg err">{err}</div>}
      <label htmlFor="adminteamcreatemodal-slug" style={{ fontSize: 13, color: "var(--muted)" }}>
        Slug
      </label>
      <input
        id="adminteamcreatemodal-slug"
        placeholder="acme"
        value={slug}
        onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
      />
      <div style={{ fontSize: 12, color: "var(--muted)", margin: "-6px 0 10px" }}>
        Becomes the host{" "}
        <code>
          {slug || "acme"}.{rootDomain}
        </code>
        . Lowercase letters, digits and hyphens; it cannot be changed later.
      </div>
      <label htmlFor="adminteamcreatemodal-name" style={{ fontSize: 13, color: "var(--muted)" }}>
        Name
      </label>
      <input
        id="adminteamcreatemodal-name"
        placeholder="Acme Inc"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <label
        htmlFor="adminteamcreatemodal-storage-cap-in-gb-0-unlimited"
        style={{ fontSize: 13, color: "var(--muted)" }}
      >
        Storage cap in GB (0 = unlimited)
      </label>
      <input
        id="adminteamcreatemodal-storage-cap-in-gb-0-unlimited"
        inputMode="decimal"
        value={quotaGb}
        onChange={e => setQuotaGb(e.target.value)}
      />
      <label htmlFor="adminteamcreatemodal-first-admin-s-email" style={{ fontSize: 13, color: "var(--muted)" }}>
        First admin's email
      </label>
      <input
        id="adminteamcreatemodal-first-admin-s-email"
        type="email"
        placeholder="jane@acme.example"
        value={adminEmail}
        onChange={e => setAdminEmail(e.target.value)}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <label htmlFor="adminteamcreatemodal-admin-name-optional" style={{ fontSize: 13, color: "var(--muted)" }}>
        Admin name (optional)
      </label>
      <input
        id="adminteamcreatemodal-admin-name-optional"
        value={adminName}
        onChange={e => setAdminName(e.target.value)}
      />
      <label htmlFor="adminteamcreatemodal-admin-username-optional" style={{ fontSize: 13, color: "var(--muted)" }}>
        Admin username (optional)
      </label>
      <input
        id="adminteamcreatemodal-admin-username-optional"
        value={adminUsername}
        onChange={e => setAdminUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={saving} onClick={create}>
          {saving ? "Creating…" : "Create team"}
        </button>
      </div>
    </Modal>
  )
}

const AdminTeamEditModal: React.FC<{ team: api.AdminTeam; onClose: () => void; onSaved: () => void }> = ({
  team,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState(team.name)
  const [quotaGb, setQuotaGb] = useState(bytesToGb(team.quota_bytes))
  const [err, setErr] = useState("")
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setErr("")
    const gb = Number(quotaGb.trim() || "0")
    if (!Number.isFinite(gb) || gb < 0) return setErr("Storage cap must be a non-negative number of GB (0 = unlimited)")
    const patch: { name?: string; quota_bytes?: number | null } = {}
    if (name.trim() && name.trim() !== team.name) patch.name = name.trim()
    const quota = gb > 0 ? gbToBytes(gb) : null
    if (quota !== (quotaUnlimited(team.quota_bytes) ? null : team.quota_bytes)) patch.quota_bytes = quota
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    const res = await api.adminUpdateTeam(team.id, patch)
    setSaving(false)
    if (res.error) return setErr(res.error)
    onSaved()
  }

  return (
    <Modal title={`Edit ${team.name}`} onClose={onClose}>
      {err && <div className="msg err">{err}</div>}
      <label htmlFor="adminteameditmodal-name" style={{ fontSize: 13, color: "var(--muted)" }}>
        Name
      </label>
      <input id="adminteameditmodal-name" value={name} onChange={e => setName(e.target.value)} autoFocus />
      <label htmlFor="adminteameditmodal-storage-cap-in-gb-0-unlimited" style={{ fontSize: 13, color: "var(--muted)" }}>
        Storage cap in GB (0 = unlimited)
      </label>
      <input
        id="adminteameditmodal-storage-cap-in-gb-0-unlimited"
        inputMode="decimal"
        value={quotaGb}
        onChange={e => setQuotaGb(e.target.value)}
      />
      <div style={{ fontSize: 12, color: "var(--muted)", margin: "-6px 0 10px" }}>
        Caps the sum of every member's storage; per-user caps still apply. Currently using{" "}
        {formatBytes(team.usage.total)}.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  )
}

const AdminTeamDeleteModal: React.FC<{ team: api.AdminTeam; onClose: () => void; onDeleted: () => void }> = ({
  team,
  onClose,
  onDeleted,
}) => {
  const [typed, setTyped] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const matches = typed.trim() === team.slug

  const run = async () => {
    if (!matches) return
    setErr("")
    setBusy(true)
    const res = await api.adminDeleteTeam(team.id)
    setBusy(false)
    if (res.error) return setErr(res.error)
    onDeleted()
  }

  return (
    <Modal title={`Delete ${team.name}`} onClose={onClose}>
      <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.5, margin: "0 0 12px" }}>
        <strong style={{ color: "var(--text)" }}>{team.base_url.replace(/^https?:\/\//, "")}</strong> stops resolving
        immediately. {team.user_count} user{team.user_count === 1 ? "" : "s"} and {formatBytes(team.usage.total)} of
        files are purged after 24 hours; until then the team can be restored from the Deleted filter.
      </p>
      {err && <div className="msg err">{err}</div>}
      <label htmlFor="adminteamdeletemodal-type-to-confirm" style={{ fontSize: 13, color: "var(--muted)" }}>
        Type <code>{team.slug}</code> to confirm
      </label>
      <input
        id="adminteamdeletemodal-type-to-confirm"
        value={typed}
        onChange={e => setTyped(e.target.value)}
        onKeyDown={e => e.key === "Enter" && run()}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="danger" disabled={!matches || busy} onClick={run}>
          {busy ? "Deleting…" : "Delete team"}
        </button>
      </div>
    </Modal>
  )
}

const App: React.FC = () => {
  const [loggedIn, setLoggedIn] = useState(!!api.getToken())
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location))
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  // which team host this is, for the signed-out screens; the subdomain is the
  // fallback until the setup probe says
  const [tenant, setTenant] = useState<Tenant | null>(() => {
    const slug = hostTeamSlug()
    return slug ? { slug, name: slug } : null
  })

  // OIDC callback hands the JWT back in the URL fragment so it doesn't end
  // up in the API logs or a redirect-chain Referer. Adopt it once, clear
  // the hash, and fetch /me to populate the user record before flipping
  // into the logged-in shell. Only a fragment this tab asked for counts —
  // see markSsoStart.
  useEffect(() => {
    if (loggedIn) return
    const hash = window.location.hash
    if (!hash.startsWith("#token=")) return
    const t = decodeURIComponent(hash.slice("#token=".length))
    history.replaceState(null, "", window.location.pathname + window.location.search)
    if (!t || !api.consumeSsoStart()) return
    api.adoptToken(t).then(u => {
      if (u) setLoggedIn(true)
    })
  }, [loggedIn])

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    if (loggedIn) {
      setNeedsSetup(false)
      return
    }
    api
      .getSetupStatus()
      .then(s => {
        setNeedsSetup(!!s?.needsSetup)
        if (s?.team && s.is_root === false) setTenant({ slug: s.team.slug, name: s.team.name })
      })
      .catch(() => setNeedsSetup(false))
  }, [loggedIn])

  const initialInvite = useMemo(() => {
    if (window.location.pathname !== "/signup") return null
    const params = new URLSearchParams(window.location.search)
    return params.get("invite")
  }, [])

  if (route.kind === "share") return <SharePage token={route.token} />
  if (route.kind === "publicFolder") return <PublicFolderPage username={route.username} folderId={route.folderId} />
  if (route.kind === "passwordForgot") return <ForgotPasswordPage />
  if (route.kind === "passwordReset") return <ResetPasswordPage token={route.token} />
  if (route.kind === "contact") return <ContactPage />
  if (route.kind === "oauthAuthorize") {
    if (!loggedIn) {
      return (
        <Auth
          onLogin={() => setLoggedIn(true)}
          initialInvite={null}
          needsSetup={false}
          initialMode="login"
          oauthNext={`/oauth/authorize${route.query}`}
          tenant={tenant}
        />
      )
    }
    return <OAuthConsent query={route.query} />
  }
  if (route.kind === "pair") {
    if (!loggedIn) {
      return (
        <Auth
          onLogin={() => setLoggedIn(true)}
          initialInvite={null}
          needsSetup={false}
          initialMode="login"
          oauthNext={`/pair${route.query}`}
          tenant={tenant}
        />
      )
    }
    return <DevicePair query={route.query} />
  }

  const logout = () => {
    api.setToken(null)
    setLoggedIn(false)
    history.replaceState(null, "", "/")
  }

  if (loggedIn) return <Shell onLogout={logout} route={route} />
  if (needsSetup === null) return null

  const path = window.location.pathname

  if (needsSetup) {
    return <Auth onLogin={() => setLoggedIn(true)} initialInvite={null} needsSetup={true} />
  }
  if (path === "/signup") {
    return (
      <Auth
        onLogin={() => setLoggedIn(true)}
        initialInvite={initialInvite}
        needsSetup={false}
        initialMode="signup"
        tenant={tenant}
      />
    )
  }
  return (
    <Auth
      onLogin={() => setLoggedIn(true)}
      initialInvite={null}
      needsSetup={false}
      initialMode="login"
      tenant={tenant}
    />
  )
}

createRoot(document.getElementById("app")!).render(<App />)
