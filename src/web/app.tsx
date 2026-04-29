import React, { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  Check,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  File as FileIconBase,
  FileArchive,
  FileCode,
  FileText,
  FileVideo,
  FileAudio,
  FileImage,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Github,
  Inbox,
  Link2,
  Mail,
  Monitor,
  Moon,
  MoreVertical,
  Music,
  Camera,
  PanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
  Smartphone,
  Sun,
  Share2,
  Terminal,
  Trash2,
  Upload as UploadIcon,
  UserPlus,
  Users,
  X,
  Zap,
} from "lucide-react"
import * as api from "./api.ts"
import { applyTheme, getTheme, setTheme as setThemePref, type Theme } from "./theme.ts"
import { Logo } from "./logo.tsx"

type Route =
  | { kind: "root" }
  | { kind: "folder"; id: number; ownerUsername?: string }
  | { kind: "file"; id: number; ownerUsername?: string }
  | { kind: "shared" }
  | { kind: "links" }
  | { kind: "actions" }
  | { kind: "actionEdit"; id: number }
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "admin" }
  | { kind: "share"; token: string }
  | { kind: "publicFolder"; username: string; folderId: number }
  | { kind: "oauthAuthorize"; query: string }
  | { kind: "pair"; query: string }
  | { kind: "passwordForgot" }
  | { kind: "passwordReset"; token: string }

const parseRoute = (loc: { pathname: string; search: string }): Route => {
  const path = loc.pathname
  if (path === "/oauth/authorize") return { kind: "oauthAuthorize", query: loc.search }
  if (path === "/pair") return { kind: "pair", query: loc.search }
  if (path === "/password/forgot") return { kind: "passwordForgot" }
  if (path === "/password/reset") {
    const token = new URLSearchParams(loc.search).get("token") ?? ""
    return { kind: "passwordReset", token }
  }
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
  if (path === "/app/settings") return { kind: "settings" }
  if (path === "/app/admin") return { kind: "admin" }
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

const folderHref = (id: number, ownerUsername?: string) =>
  ownerUsername ? `/app/u/${ownerUsername}/f/${id}` : `/app/f/${id}`

const fileHref = (id: number, ownerUsername: string) =>
  `/app/u/${ownerUsername}/file/${id}`

type Folder = { id: number; name: string; parent_id: number | null; kind?: string; is_public?: boolean; created_at: string }
type FileItem = { id: number; name: string; mime: string; size: number; folder_id: number | null; version: number; created_at: string }
type Crumb = { id: number; name: string }
type Share = { id: number; token: string; expires_at: string | null; created_at: string; name: string; size: number; mime: string; file_id: number; password_required?: boolean; burn_on_view?: boolean }
type TrashedFolder = Folder & { deleted_at: string }
type TrashedFile = FileItem & { deleted_at: string }
type FileVersion = { version: number; mime: string; size: number; uploaded_by: number | null; uploaded_at: string; is_current: boolean }

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
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("Could not encode PNG")), "image/png")
  })
}

const ensureScreenshotsFolder = async (): Promise<number> => {
  const folders = await api.listFolders(null) as Array<{ id: number; name: string; kind?: string }>
  const existing = folders.find(f => f.kind === "screenshots")
  if (existing) return existing.id
  const created = await api.createFolderTyped("Screenshots", null, { kind: "screenshots" }) as { id?: number; error?: string }
  if (!created.id) throw new Error(created.error ?? "Could not create Screenshots folder")
  return created.id
}

const MimeIcon: React.FC<{ mime: string; size?: number }> = ({ mime, size = 28 }) => {
  if (mime.startsWith("image/")) return <FileImage size={size} strokeWidth={1.5} />
  if (mime.startsWith("video/")) return <FileVideo size={size} strokeWidth={1.5} />
  if (mime.startsWith("audio/")) return <FileAudio size={size} strokeWidth={1.5} />
  if (mime.includes("pdf")) return <FileText size={size} strokeWidth={1.5} />
  if (mime.includes("zip") || mime.includes("compressed") || mime.includes("x-tar") || mime.includes("gzip")) return <FileArchive size={size} strokeWidth={1.5} />
  if (mime.includes("javascript") || mime.includes("typescript") || mime.includes("x-sh") || mime.includes("json") || mime.includes("xml")) return <FileCode size={size} strokeWidth={1.5} />
  if (mime.startsWith("text/")) return <FileText size={size} strokeWidth={1.5} />
  return <FileIconBase size={size} strokeWidth={1.5} />
}

const FileThumb: React.FC<{ file: FileItem }> = ({ file }) => {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <div className="icon"><MimeIcon mime={file.mime} size={32} /></div>
  }
  return (
    <div className="thumb">
      <img
        src={`/api/files/${file.id}/thumb?v=${file.version}`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

const Auth: React.FC<{ onLogin: () => void; initialInvite?: string | null; needsSetup: boolean; initialMode?: "login" | "signup"; oauthNext?: string }> = ({ onLogin, initialInvite, needsSetup, initialMode, oauthNext }) => {
  const [mode, setMode] = useState<"login" | "signup">(initialMode ?? (needsSetup || initialInvite ? "signup" : "login"))
  const [name, setName] = useState("")
  const [username, setUsername] = useState("")
  const [identity, setIdentity] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteToken, setInviteToken] = useState(initialInvite ?? "")
  const [inviteEmailLock, setInviteEmailLock] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState("")
  const [mfaUseBackup, setMfaUseBackup] = useState(false)
  const [mfaBackup, setMfaBackup] = useState("")

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
    return () => { cancelled = true }
  }, [mode, inviteToken, needsSetup])

  const submit = async () => {
    setError("")
    if (mode === "signup") {
      const res = await api.signup({ name, username, email, password, inviteToken: needsSetup ? undefined : inviteToken })
      if (res.error) return setError(res.error)
      if (!res.token) return setError("Authentication failed")
      if (window.location.pathname === "/signup") history.replaceState(null, "", "/")
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
  }

  const submitMfa = async () => {
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
  }

  const heading = needsSetup
    ? "Set up your Stohr"
    : mode === "login" ? "Sign in to your cloud storage" : "Create your account"

  return (
    <div className="auth">
      <Logo className="auth-logo" />
      <h2>{heading}</h2>
      {needsSetup && (
        <div style={{ background: "var(--accent-bg)", color: "var(--brand)", border: "1px solid var(--brand)", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          No accounts yet. The first user becomes the owner and can invite others.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {mfaToken ? (
        <>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 8 }}>
            Enter the 6-digit code from your authenticator app.
          </div>
          {mfaUseBackup ? (
            <input
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
              placeholder="6-digit code"
              value={mfaCode}
              autoFocus
              inputMode="numeric"
              maxLength={6}
              onChange={e => setMfaCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={e => e.key === "Enter" && submitMfa()}
            />
          )}
          <button className="primary" onClick={submitMfa}>Verify</button>
          <div className="toggle" onClick={() => { setMfaUseBackup(!mfaUseBackup); setError("") }}>
            {mfaUseBackup ? "Use authenticator code instead" : "Use a backup code"}
          </div>
          <div className="toggle" onClick={() => { setMfaToken(null); setMfaCode(""); setMfaBackup(""); setError("") }}>
            Cancel
          </div>
        </>
      ) : mode === "signup" ? (
        <>
          <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
          <input placeholder="Username" value={username}
            onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <input
            placeholder="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            disabled={!!inviteEmailLock}
          />
          <input placeholder="Password (min 8 chars)" type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => needsSetup && e.key === "Enter" && submit()}
          />
          {!needsSetup && (
            <input placeholder="Invite token" value={inviteToken}
              onChange={e => setInviteToken(e.target.value.trim())}
              onKeyDown={e => e.key === "Enter" && submit()}
            />
          )}
        </>
      ) : (
        <>
          <input placeholder="Email or username" value={identity}
            onChange={e => setIdentity(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <input placeholder="Password" type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
        </>
      )}
      {!mfaToken && (
        <>
          <button className="primary" onClick={submit}>
            {needsSetup ? "Create owner account" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          {!needsSetup && (
            <div className="toggle" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
              {mode === "login" ? "Have an invite? Create your account" : "Already have an account? Sign in"}
            </div>
          )}
          {!needsSetup && mode === "login" && (
            <div className="toggle" onClick={() => navigate("/password/forgot")} style={{ marginTop: 4 }}>
              Forgot your password?
            </div>
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
    if (!email.trim()) { setError("Email is required"); return }
    setStatus("submitting"); setError("")
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
            If an account exists for <strong style={{ color: "var(--text)" }}>{email}</strong>, we've sent a link to reset your password.
            The link expires in one hour.
          </p>
          <div className="toggle" onClick={() => navigate("/login")}>Back to sign in</div>
        </>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          <input
            type="email"
            placeholder="Your email"
            value={email}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
          <button className="primary" onClick={submit} disabled={status === "submitting"}>
            {status === "submitting" ? "Sending…" : "Send reset link"}
          </button>
          <div className="toggle" onClick={() => navigate("/login")}>Back to sign in</div>
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
    if (!token) { setError("Missing reset token"); return }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return }
    if (password !== confirm) { setError("Passwords don't match"); return }
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
          <button className="primary" onClick={() => navigate("/login")}>Sign in</button>
        </>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          <input
            type="password"
            placeholder="New password (min 8 chars)"
            value={password}
            autoFocus
            onChange={e => setPassword(e.target.value)}
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
          <button className="primary" onClick={submit} disabled={status === "submitting"}>
            {status === "submitting" ? "Updating…" : "Update password"}
          </button>
          <div className="toggle" onClick={() => navigate("/login")}>Cancel</div>
        </>
      )}
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
            <>Uploading <span style={{ color: "var(--muted)" }}>{active} of {uploads.length}</span> · {formatBytes(totalLoaded)} / {formatBytes(totalSize)}</>
          ) : (
            <>{uploads.length} upload{uploads.length === 1 ? "" : "s"}</>
          )}
        </div>
        <button onClick={onClear}>Clear</button>
      </div>
      <div className="upload-list">
        {uploads.map(u => {
          const pct = u.size === 0 ? 100 : Math.min(100, Math.round((u.loaded / u.size) * 100))
          return (
            <div key={u.id} className={`upload-item ${u.status}`}>
              <div className="upload-line">
                <div className="upload-name" title={u.name}>{u.name}</div>
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
                <button className="upload-cancel" onClick={() => onCancel(u.id)} aria-label="Cancel"><X size={12} /></button>
              )}
              {u.status !== "uploading" && (
                <button className="upload-cancel" onClick={() => onDismiss(u.id)} aria-label="Dismiss"><X size={12} /></button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; size?: "default" | "wide" }> = ({ title, onClose, children, size = "default" }) => (
  <div className="modal-backdrop" onClick={onClose}>
    <div className={`modal${size === "wide" ? " modal-wide" : ""}`} onClick={e => e.stopPropagation()}>
      <h3>{title}</h3>
      {children}
    </div>
  </div>
)

type PaletteFolder = { id: number; name: string; parent_id: number | null }
type PaletteResults = { files: FileItem[]; folders: PaletteFolder[] }

type FolderDetail = { id: number; name: string; parent_id: number | null; role: "owner" | "editor" | "viewer"; owner: { id: number; username: string; name: string } | null; trail: Crumb[] }

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
  const visible = items.filter(i => !i.hidden)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (visible.length === 0) return null

  return (
    <div className="kebab" ref={ref} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="kebab-trigger"
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
      >
        <MoreVertical size={16} strokeWidth={2} />
      </button>
      {open && (
        <div className="kebab-menu" role="menu">
          {visible.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`kebab-item${item.danger ? " danger" : ""}`}
              onClick={() => { setOpen(false); item.onClick() }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const Files: React.FC<{ routeFolderId: number | null; routeFileId: number | null }> = ({ routeFolderId, routeFileId }) => {
  const [folders, setFolders] = useState<Folder[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [currentId, setCurrentId] = useState<number | null>(routeFolderId)
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const [currentRole, setCurrentRole] = useState<"owner" | "editor" | "viewer">("owner")
  const [currentOwner, setCurrentOwner] = useState<{ id: number; username: string; name: string } | null>(null)
  const [currentKind, setCurrentKind] = useState<string>("standard")
  const [currentIsPublic, setCurrentIsPublic] = useState<boolean>(false)
  const [showFolderSettings, setShowFolderSettings] = useState(false)
  const [search, setSearch] = useState("")
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
  const canEdit = currentRole === "owner" || currentRole === "editor"

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
    return () => { aborted = true }
  }, [routeFileId])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState("")
  const [paletteResults, setPaletteResults] = useState<PaletteResults>({ files: [], folders: [] })
  const [paletteActive, setPaletteActive] = useState(0)
  const [paletteLoading, setPaletteLoading] = useState(false)

  const load = async () => {
    const [fo, fi] = await Promise.all([
      api.listFolders(currentId),
      api.listFiles(currentId, search || undefined),
    ])
    setFolders(Array.isArray(fo) ? fo : [])
    setFiles(Array.isArray(fi) ? fi : [])
    if (currentId == null) {
      setCrumbs([])
      setCurrentRole("owner")
      setCurrentOwner(null)
      setCurrentKind("standard")
      setCurrentIsPublic(false)
    } else {
      const data = await api.getFolder(currentId) as (FolderDetail & { kind?: string; is_public?: boolean }) & { error?: string }
      if (data && !data.error) {
        setCrumbs(data.trail ?? [])
        setCurrentRole(data.role ?? "owner")
        setCurrentOwner(data.owner ?? null)
        setCurrentKind(data.kind ?? "standard")
        setCurrentIsPublic(!!data.is_public)
      }
    }
  }

  useEffect(() => { load() }, [currentId, search])
  useEffect(() => { setSelected(new Set()); setLastClicked(null) }, [currentId, search])

  useEffect(() => {
    if (currentId == null) {
      if (window.location.pathname.startsWith("/app/")) navigate("/")
      return
    }
    const ownerSlug = currentOwner && me && currentOwner.id !== me.id ? currentOwner.username : undefined
    const want = folderHref(currentId, ownerSlug)
    if (window.location.pathname !== want) {
      history.replaceState(null, "", want)
    }
  }, [currentId, currentOwner?.id])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault()
        setPaletteOpen(true)
        setPaletteQuery("")
        setPaletteResults({ files: [], folders: [] })
        setPaletteActive(0)
        setPaletteLoading(false)
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [])

  useEffect(() => {
    if (!paletteOpen) return
    if (!paletteQuery) {
      setPaletteResults({ files: [], folders: [] })
      setPaletteActive(0)
      return
    }
    setPaletteLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await api.search(paletteQuery) as PaletteResults
        const results: PaletteResults = {
          folders: Array.isArray(res?.folders) ? res.folders : [],
          files: Array.isArray(res?.files) ? res.files : [],
        }
        setPaletteResults(results)
        setPaletteActive(prev => {
          const total = results.folders.length + results.files.length
          return total === 0 ? 0 : Math.min(prev, total - 1)
        })
      } catch {
        setPaletteResults({ files: [], folders: [] })
        setPaletteActive(0)
      } finally {
        setPaletteLoading(false)
      }
    }, 150)
    return () => clearTimeout(t)
  }, [paletteOpen, paletteQuery])

  const orderedKeys = useMemo(
    () => [...folders.map(f => `fo-${f.id}`), ...files.map(f => `fi-${f.id}`)],
    [folders, files]
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

  const clearSelection = () => { setSelected(new Set()); setLastClicked(null) }

  const selectAll = () => {
    if (selected.size === orderedKeys.length) clearSelection()
    else setSelected(new Set(orderedKeys))
  }

  const bulkDelete = async () => {
    if (!confirm(`Move ${selected.size} item${selected.size === 1 ? "" : "s"} to Trash?`)) return
    const tasks: Promise<any>[] = []
    for (const k of selected) {
      const [kind, idStr] = k.split("-")
      const id = Number(idStr)
      tasks.push(kind === "fo" ? api.deleteFolder(id) : api.deleteFile(id))
    }
    await Promise.allSettled(tasks)
    clearSelection()
    await load()
  }

  const bulkMove = async (targetFolderId: number | null) => {
    const tasks: Promise<any>[] = []
    for (const k of selected) {
      const [kind, idStr] = k.split("-")
      const id = Number(idStr)
      if (kind === "fi") tasks.push(api.moveFile(id, targetFolderId))
      else if (id !== targetFolderId) tasks.push(api.moveFolder(id, targetFolderId))
    }
    await Promise.allSettled(tasks)
    setMovingOpen(false)
    clearSelection()
    await load()
  }

  const upload = async (list: FileList | File[]) => {
    const files = Array.from(list)
    if (files.length === 0) return

    const queued: Uploading[] = files.map(f => ({
      id: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${f.name}`,
      name: f.name,
      size: f.size,
      loaded: 0,
      status: "uploading" as const,
      abort: () => {},
    }))
    setUploads(prev => [...prev, ...queued])

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      const u = queued[i]!
      const handle = api.uploadFile(f, currentId, (loaded) => {
        setUploads(prev => prev.map(p => p.id === u.id ? { ...p, loaded } : p))
      })
      setUploads(prev => prev.map(p => p.id === u.id ? { ...p, abort: handle.abort } : p))
      try {
        await handle.promise
        setUploads(prev => prev.map(p => p.id === u.id ? { ...p, loaded: f.size, status: "done" } : p))
      } catch (e: any) {
        setUploads(prev => prev.map(p => p.id === u.id ? { ...p, status: "error", error: e?.message ?? "Failed" } : p))
      }
    }

    await load()
  }

  const onDrop: React.DragEventHandler = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files)
  }

  const [captureNotice, setCaptureNotice] = useState<string | null>(null)
  const captureScreenshot = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCaptureNotice("Screen capture isn't supported in this browser.")
      return
    }
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "monitor" } as any, audio: false })
      const blob = await captureFrame(stream)
      const folderId = await ensureScreenshotsFolder()
      const stamp = stampForFilename(new Date())
      const filename = `Screenshot ${stamp}.png`
      const file = new File([blob], filename, { type: "image/png" })
      const handle = api.uploadFile(file, folderId)
      const res = await handle.promise as { id?: number; error?: string } | Array<{ id: number }>
      const fileId = Array.isArray(res) ? res[0]?.id : res?.id
      if (!fileId) throw new Error("Upload failed")
      const share = await api.createShare(fileId, { expiresIn: 30 * 86400 }) as { token?: string; error?: string }
      if (!share.token) throw new Error(share.error ?? "Share failed")
      const url = `${window.location.origin}/s/${share.token}`
      try { await navigator.clipboard.writeText(url) } catch {}
      setCaptureNotice(`Link copied: ${url}`)
      await load()
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (!/cancel|abort|denied/i.test(msg)) setCaptureNotice(`Screenshot failed: ${msg}`)
    } finally {
      stream?.getTracks().forEach(t => t.stop())
    }
  }

  const createFolder = async () => {
    if (!newFolderName.trim()) return
    await api.createFolder(newFolderName.trim(), currentId)
    setNewFolderName("")
    setCreatingFolder(false)
    await load()
  }

  const del = async (kind: "folder" | "file", id: number) => {
    if (!confirm(`Delete this ${kind}?`)) return
    const res = kind === "folder" ? await api.deleteFolder(id) : await api.deleteFile(id)
    if (res.error) alert(res.error)
    await load()
  }

  const rename = async () => {
    if (!renaming || !renaming.name.trim()) return
    const res = renaming.kind === "folder"
      ? await api.renameFolder(renaming.id, renaming.name.trim())
      : await api.renameFile(renaming.id, renaming.name.trim())
    if (res.error) alert(res.error)
    setRenaming(null)
    await load()
  }

  const ownerSlug = currentOwner && me && currentOwner.id !== me.id ? currentOwner.username : undefined

  const pathCrumbs = (
    <div className="crumbs">
      {currentRole === "owner"
        ? <span className="crumb" onClick={() => navigate("/")}>All Files</span>
        : currentOwner && <span className="crumb" onClick={() => navigate("/app/shared")}>Shared with me</span>}
      {currentOwner && currentRole !== "owner" && (
        <>
          <span className="sep"><ChevronRight size={14} /></span>
          <span style={{ color: "var(--muted)" }}>@{currentOwner.username}</span>
        </>
      )}
      {crumbs.map((c, i) => (
        <React.Fragment key={c.id}>
          <span className="sep"><ChevronRight size={14} /></span>
          {i === crumbs.length - 1
            ? <span className="current">{c.name}</span>
            : <span className="crumb" onClick={() => navigate(folderHref(c.id, ownerSlug))}>{c.name}</span>}
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <div className="main">
      <div className="toolbar">
        <input className="search" placeholder="Search files..." value={search} onChange={e => setSearch(e.target.value)} />
        <div className="toolbar-actions">
          {currentId != null && currentRole === "owner" && (
            <button onClick={() => setShowFolderSettings(true)} aria-label="Folder settings" title="Folder settings">
              <SettingsIcon size={14} />
            </button>
          )}
          <button onClick={() => setCreatingFolder(true)}>
            <FolderPlus size={14} /> <span>Folder</span>
          </button>
          <button onClick={captureScreenshot} title="Capture screenshot">
            <Camera size={14} /> <span>Capture</span>
          </button>
          <button className="primary" onClick={() => fileInput.current?.click()}>
            <UploadIcon size={14} /> <span>Upload</span>
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={e => e.target.files && upload(e.target.files)} />
        </div>
      </div>
      {captureNotice && (
        <div className="capture-notice">
          <span>{captureNotice}</span>
          <button onClick={() => setCaptureNotice(null)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      <div className="content"
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="path-bar">{pathCrumbs}</div>
        <div className={`dropzone${dragOver ? " over" : ""}`}>
          Drag & drop files here to upload to {currentId == null ? "your Stohr" : `"${crumbs[crumbs.length - 1]?.name ?? ""}"`}
        </div>

        {folders.length === 0 && files.length === 0 && !search && (
          <div className="empty">
            <div className="big"><Inbox size={64} strokeWidth={1.25} /></div>
            <div>This folder is empty</div>
            <div style={{ marginTop: 8, fontSize: 13 }}>Upload files or create a folder to get started</div>
          </div>
        )}

        {search && folders.length === 0 && files.length === 0 && (
          <div className="empty">
            <div className="big"><Search size={64} strokeWidth={1.25} /></div>
            <div>No files match "{search}"</div>
          </div>
        )}

        {selected.size > 0 && (
          <div className="selbar">
            <div>{selected.size} selected</div>
            <div className="selbar-actions">
              <button onClick={selectAll}>
                {selected.size === orderedKeys.length ? "Deselect all" : "Select all"}
              </button>
              <button onClick={() => setMovingOpen(true)}>Move to...</button>
              <button className="danger" onClick={bulkDelete}>
                <Trash2 size={14} /> <span>Delete</span>
              </button>
              <button onClick={clearSelection} aria-label="Clear"><X size={14} /></button>
            </div>
          </div>
        )}

        <div className="grid">
          {folders.map(f => {
            const key = `fo-${f.id}`
            const sel = selected.has(key)
            return (
              <div
                key={key}
                className={`card${sel ? " selected" : ""}`}
                onClick={(e) => {
                  if (selected.size > 0) return toggleSelect(key, e)
                  const ownerSlug = currentOwner && me && currentOwner.id !== me.id ? currentOwner.username : undefined
                  navigate(folderHref(f.id, ownerSlug))
                }}
              >
                <div className={`check${sel ? " on" : ""}`} onClick={e => toggleSelect(key, e)}>
                  <div className="check-box" />
                </div>
                <CardKebab
                  ariaLabel="Folder actions"
                  items={[
                    { label: "Share", onClick: () => setSharing({ kind: "folder", id: f.id, name: f.name }), hidden: currentRole !== "owner" },
                    { label: "Rename", onClick: () => setRenaming({ kind: "folder", id: f.id, name: f.name }), hidden: !canEdit },
                    { label: "Delete", onClick: () => del("folder", f.id), danger: true, hidden: !canEdit },
                  ]}
                />
                <div className="icon">
                  {f.kind === "screenshots"
                    ? <Camera size={32} strokeWidth={1.5} />
                    : <FolderIcon size={32} strokeWidth={1.5} />}
                </div>
                <div className="name">{f.name}</div>
                <div className="meta">
                  {f.kind === "photos" ? "Photos" : f.kind === "screenshots" ? "Screenshots" : "Folder"}
                </div>
              </div>
            )
          })}
          {currentKind !== "photos" && currentKind !== "screenshots" && files.map(f => {
            const key = `fi-${f.id}`
            const sel = selected.has(key)
            return (
              <div
                key={key}
                className={`card${sel ? " selected" : ""}`}
                onClick={(e) => selected.size > 0 ? toggleSelect(key, e) : setPreviewing(f)}
              >
                <div className={`check${sel ? " on" : ""}`} onClick={e => toggleSelect(key, e)}>
                  <div className="check-box" />
                </div>
                <CardKebab
                  ariaLabel="File actions"
                  items={[
                    { label: "Download", onClick: () => downloadFile(f) },
                    { label: "Share", onClick: () => setSharing({ kind: "file", id: f.id, name: f.name }), hidden: currentRole !== "owner" },
                    { label: "Versions", onClick: () => setViewingVersions(f), hidden: f.version <= 1 },
                    { label: "Rename", onClick: () => setRenaming({ kind: "file", id: f.id, name: f.name }), hidden: !canEdit },
                    { label: "Delete", onClick: () => del("file", f.id), danger: true, hidden: !canEdit },
                  ]}
                />
                <FileThumb file={f} />
                <div className="name">{f.name}</div>
                <div className="meta">
                  {formatBytes(f.size)}
                  {f.version > 1 && <span className="badge">v{f.version}</span>}
                </div>
              </div>
            )
          })}
        </div>

        {(currentKind === "photos" || currentKind === "screenshots") && (
          <PhotosGallery
            files={files}
            thumbUrl={(id, version) => `/api/files/${id}/thumb?v=${version}`}
            fullUrl={(id) => `${api.downloadUrl(id)}?inline=1`}
            authHeader
          />
        )}
      </div>

      {creatingFolder && (
        <Modal title="Create folder" onClose={() => setCreatingFolder(false)}>
          <input autoFocus placeholder="Folder name" value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createFolder()}
          />
          <div className="actions">
            <button onClick={() => setCreatingFolder(false)}>Cancel</button>
            <button className="primary" onClick={createFolder}>Create</button>
          </div>
        </Modal>
      )}

      {sharing && (
        <SharingModal
          target={sharing}
          ownerUsername={me?.username ?? null}
          onClose={() => setSharing(null)}
        />
      )}

      {renaming && (
        <Modal title={`Rename ${renaming.kind}`} onClose={() => setRenaming(null)}>
          <input autoFocus value={renaming.name}
            onChange={e => setRenaming({ ...renaming, name: e.target.value })}
            onKeyDown={e => e.key === "Enter" && rename()}
          />
          <div className="actions">
            <button onClick={() => setRenaming(null)}>Cancel</button>
            <button className="primary" onClick={rename}>Rename</button>
          </div>
        </Modal>
      )}

      {previewing && (
        <PreviewModal file={previewing} onClose={() => setPreviewing(null)} />
      )}

      {showFolderSettings && currentId != null && (
        <FolderSettingsModal
          folderId={currentId}
          folderName={crumbs[crumbs.length - 1]?.name ?? ""}
          ownerUsername={currentOwner?.username ?? me?.username ?? ""}
          initialKind={currentKind}
          initialIsPublic={currentIsPublic}
          onClose={() => setShowFolderSettings(false)}
          onSaved={async () => { setShowFolderSettings(false); await load() }}
        />
      )}

      {viewingVersions && (
        <VersionsModal
          file={viewingVersions}
          onClose={() => setViewingVersions(null)}
          onRestored={async () => { setViewingVersions(null); await load() }}
        />
      )}

      {movingOpen && (
        <FolderPicker
          excludeIds={[...selected].filter(k => k.startsWith("fo-")).map(k => Number(k.slice(3)))}
          onClose={() => setMovingOpen(false)}
          onPick={bulkMove}
        />
      )}

      {paletteOpen && (() => {
        const combined = [...paletteResults.folders, ...paletteResults.files]
        const closePalette = () => { setPaletteOpen(false); setPaletteQuery(""); setPaletteResults({ files: [], folders: [] }); setPaletteActive(0) }
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
            setPaletteActive(prev => Math.min(prev + 1, combined.length - 1))
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setPaletteActive(prev => Math.max(prev - 1, 0))
          } else if (e.key === "Enter") {
            e.preventDefault()
            activate(paletteActive)
          } else if (e.key === "Escape") {
            closePalette()
          }
        }
        return (
          <div className="modal-backdrop" onClick={closePalette}>
            <div className="modal" style={{ maxWidth: 520, width: "100%" }} onClick={e => e.stopPropagation()} onKeyDown={onKeyDown}>
              <input
                autoFocus
                className="search"
                style={{ width: "100%", marginBottom: 8, boxSizing: "border-box" }}
                placeholder="Search files and folders..."
                value={paletteQuery}
                onChange={e => { setPaletteQuery(e.target.value); setPaletteActive(0) }}
              />
              {paletteQuery.length > 0 && !paletteLoading && paletteResults.folders.length === 0 && paletteResults.files.length === 0 && (
                <div style={{ padding: "12px 0", color: "var(--muted)", textAlign: "center", fontSize: 14 }}>No matches.</div>
              )}
              {paletteResults.folders.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", padding: "6px 0 2px" }}>Folders</div>
                  {paletteResults.folders.map((f, i) => (
                    <div
                      key={`pf-${f.id}`}
                      className={`picker-row${paletteActive === i ? " active" : ""}`}
                      style={{ cursor: "pointer", borderRadius: 6, padding: "6px 8px", background: paletteActive === i ? "var(--hover)" : undefined }}
                      onClick={() => activate(i)}
                      onMouseEnter={() => setPaletteActive(i)}
                    >
                      <FolderIcon size={16} strokeWidth={1.5} />
                      <span style={{ marginLeft: 8 }}>{f.name}</span>
                    </div>
                  ))}
                </>
              )}
              {paletteResults.files.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)", padding: "6px 0 2px" }}>Files</div>
                  {paletteResults.files.map((f, i) => {
                    const globalIdx = paletteResults.folders.length + i
                    return (
                      <div
                        key={`pfi-${f.id}`}
                        className={`picker-row${paletteActive === globalIdx ? " active" : ""}`}
                        style={{ cursor: "pointer", borderRadius: 6, padding: "6px 8px", background: paletteActive === globalIdx ? "var(--hover)" : undefined }}
                        onClick={() => activate(globalIdx)}
                        onMouseEnter={() => setPaletteActive(globalIdx)}
                      >
                        <MimeIcon mime={f.mime} size={16} />
                        <span style={{ marginLeft: 8 }}>{f.name}</span>
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          </div>
        )
      })()}

      <UploadPanel
        uploads={uploads}
        onCancel={(id) => {
          setUploads(prev => {
            const target = prev.find(p => p.id === id)
            if (target?.abort) target.abort()
            return prev.filter(p => p.id !== id)
          })
        }}
        onDismiss={(id) => setUploads(prev => prev.filter(p => p.id !== id))}
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

const FolderPicker: React.FC<{ excludeIds: number[]; onClose: () => void; onPick: (folderId: number | null) => void }> = ({ excludeIds, onClose, onPick }) => {
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const [folders, setFolders] = useState<Folder[]>([])

  const load = async () => {
    const list = await api.listFolders(currentId)
    setFolders(Array.isArray(list) ? list : [])
    if (currentId == null) setCrumbs([])
    else {
      const data = await api.getFolder(currentId)
      setCrumbs(data.trail ?? [])
    }
  }
  useEffect(() => { load() }, [currentId])

  return (
    <Modal title="Move to folder" onClose={onClose}>
      <div className="picker-crumbs">
        <span className="crumb" onClick={() => setCurrentId(null)}>All Files</span>
        {crumbs.map((c, i) => (
          <React.Fragment key={c.id}>
            <span className="sep"><ChevronRight size={14} /></span>
            {i === crumbs.length - 1
              ? <span className="current">{c.name}</span>
              : <span className="crumb" onClick={() => setCurrentId(c.id)}>{c.name}</span>}
          </React.Fragment>
        ))}
      </div>
      <div className="picker-list">
        {folders.length === 0 && <div className="picker-empty">No subfolders here</div>}
        {folders.map(f => {
          const disabled = excludeIds.includes(f.id)
          return (
            <div
              key={f.id}
              className={`picker-row${disabled ? " disabled" : ""}`}
              onClick={() => !disabled && setCurrentId(f.id)}
            >
              <FolderIcon size={18} strokeWidth={1.5} />
              <span>{f.name}</span>
            </div>
          )
        })}
      </div>
      <div className="actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => onPick(currentId)}>
          Move here{crumbs.length > 0 ? `: ${crumbs[crumbs.length - 1]?.name}` : ""}
        </button>
      </div>
    </Modal>
  )
}

const TEXT_MIMES = ["application/json", "application/xml", "application/javascript", "application/typescript", "application/x-sh"]

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
  const kind = kindFor(file.mime)

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
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [onClose])

  const loading = !error && kind !== "other" && !url && text === null

  return (
    <div className="preview-backdrop" onClick={onClose}>
      <div className="preview" onClick={e => e.stopPropagation()}>
        <div className="preview-head">
          <div className="preview-title">
            <span className="preview-icon"><MimeIcon mime={file.mime} size={28} /></span>
            <div>
              <div className="preview-name">{file.name}</div>
              <div className="preview-meta">{formatBytes(file.size)} • {file.mime}</div>
            </div>
          </div>
          <div className="preview-actions">
            <button onClick={() => downloadFile(file)}>Download</button>
            <button onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
        </div>
        <div className="preview-body">
          {loading && <div className="preview-empty">Loading preview...</div>}
          {error && <div className="preview-empty">Could not load preview: {error}</div>}
          {kind === "image" && url && <img src={url} alt={file.name} />}
          {kind === "video" && url && <video src={url} controls autoPlay />}
          {kind === "audio" && url && (
            <div className="preview-audio">
              <div className="preview-audio-icon"><Music size={72} strokeWidth={1.25} /></div>
              <audio src={url} controls autoPlay />
            </div>
          )}
          {kind === "pdf" && url && <iframe src={url} title={file.name} />}
          {kind === "text" && text !== null && <pre className="preview-text">{text}</pre>}
          {kind === "other" && (
            <div className="preview-empty">
              <div className="preview-empty-icon"><MimeIcon mime={file.mime} size={64} /></div>
              <div>No inline preview for this file type</div>
              <button className="primary" style={{ marginTop: 16 }} onClick={() => downloadFile(file)}>Download</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const VersionsModal: React.FC<{ file: FileItem; onClose: () => void; onRestored: () => void }> = ({ file, onClose, onRestored }) => {
  const [versions, setVersions] = useState<FileVersion[]>([])
  const [err, setErr] = useState("")

  const load = async () => {
    const data = await api.listVersions(file.id)
    if (Array.isArray(data)) setVersions(data)
    else setErr(data.error ?? "Failed to load versions")
  }
  useEffect(() => { load() }, [file.id])

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
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
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
              <div className="version-meta">{formatBytes(v.size)} • {new Date(v.uploaded_at).toLocaleString()}</div>
            </div>
            <div className="version-actions">
              <button onClick={() => downloadVersion(v)}>Download</button>
              {!v.is_current && <button onClick={() => restore(v)}>Restore</button>}
              {!v.is_current && <button className="danger" onClick={() => remove(v)}>Delete</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  )
}

const TrashView: React.FC = () => {
  const [data, setData] = useState<{ folders: TrashedFolder[]; files: TrashedFile[] }>({ folders: [], files: [] })

  const load = async () => {
    const res = await api.listTrash()
    if (res && "folders" in res) setData(res)
    else setData({ folders: [], files: [] })
  }
  useEffect(() => { load() }, [])

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
        <div className="crumbs"><span className="current">Trash</span></div>
        {!isEmpty && <button className="danger" onClick={emptyAll}>Empty trash</button>}
      </div>
      <div className="content">
        {isEmpty && (
          <div className="empty"><div className="big"><Trash2 size={64} strokeWidth={1.25} /></div><div>Trash is empty</div></div>
        )}
        {!isEmpty && (
          <div className="grid">
            {data.folders.map(f => (
              <div key={`tf-${f.id}`} className="card">
                <div className="icon"><FolderIcon size={32} strokeWidth={1.5} /></div>
                <div className="name">{f.name}</div>
                <div className="meta">Deleted {new Date(f.deleted_at).toLocaleDateString()}</div>
                <div className="row">
                  <button onClick={() => restoreF("folder", f.id)}>Restore</button>
                  <button className="danger" onClick={() => purge("folder", f.id)}>Delete forever</button>
                </div>
              </div>
            ))}
            {data.files.map(f => (
              <div key={`tfi-${f.id}`} className="card">
                <div className="icon"><MimeIcon mime={f.mime} size={32} /></div>
                <div className="name">{f.name}</div>
                <div className="meta">{formatBytes(f.size)} • Deleted {new Date(f.deleted_at).toLocaleDateString()}</div>
                <div className="row">
                  <button onClick={() => restoreF("file", f.id)}>Restore</button>
                  <button className="danger" onClick={() => purge("file", f.id)}>Delete forever</button>
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
  useEffect(() => { load() }, [kind, id])

  const add = async () => {
    if (!identity.trim() || busy) return
    setBusy(true)
    setError("")
    setPendingInvite(null)
    const fn = kind === "folder" ? api.addFolderCollab : api.addFileCollab
    const res = await fn(id, identity.trim(), role)
    setBusy(false)
    if (res.error) return setError(res.error)
    if (res.invite_token && res.email) {
      setPendingInvite({ token: res.invite_token, email: res.email })
    }
    setIdentity("")
    await load()
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
        Add by username or email. Unknown emails get an invite link you can send.
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          placeholder="username or email"
          value={identity}
          onChange={e => setIdentity(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          autoCapitalize="off"
          autoCorrect="off"
          style={{ flex: 1 }}
        />
        <select
          value={role}
          onChange={e => setRole(e.target.value as "viewer" | "editor")}
          style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--panel)", color: "var(--text)" }}
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <button className="primary" onClick={add} disabled={busy}>
          <UserPlus size={14} /> <span>Add</span>
        </button>
      </div>
      {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
      {pendingInvite && (
        <div className="msg ok" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Invite link for {pendingInvite.email}:</div>
          <div className="share-link" style={{ margin: "4px 0" }}>
            {window.location.origin}/signup?invite={pendingInvite.token}
          </div>
          <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/signup?invite=${pendingInvite.token}`)}>Copy invite link</button>
        </div>
      )}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No collaborators yet</div>}
        {rows.map(r => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {r.user ? `@${r.user.username}` : r.email}
                {r.user && <span style={{ color: "var(--muted)", marginLeft: 6, fontWeight: 400 }}>{r.user.name}</span>}
                {!r.user && <span className="badge" style={{ marginLeft: 8 }}>pending</span>}
              </div>
            </div>
            <span style={{ fontSize: 12, color: "var(--muted)", textTransform: "capitalize" }}>{r.role}</span>
            <button className="danger" onClick={() => remove(r.id)} style={{ padding: "4px 8px", fontSize: 12 }}>
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
  const [publicLink, setPublicLink] = useState<{ url: string; passwordRequired: boolean; burnOnView: boolean } | null>(null)
  const [linkExpiry, setLinkExpiry] = useState<number>(86400)
  const [linkPassword, setLinkPassword] = useState("")
  const [linkBurn, setLinkBurn] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkErr, setLinkErr] = useState("")

  const createPublic = async () => {
    if (target.kind !== "file") return
    setLinkBusy(true); setLinkErr("")
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
      setLinkErr(res.error ?? "Failed to share")
    }
  }

  return (
    <Modal title={`Share "${target.name}"`} onClose={onClose}>
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginBottom: 16 }}>
        <button
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

      {tab === "people" && (
        <>
          <CollaboratorsPanel kind={target.kind} id={target.id} />
          {directLink && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Collaborators with access can open:</div>
              <div className="share-link">{directLink}</div>
              <button onClick={() => navigator.clipboard.writeText(directLink)} style={{ marginTop: 6 }}>Copy link</button>
            </div>
          )}
        </>
      )}

      {tab === "link" && target.kind === "file" && (
        <>
          {publicLink ? (
            <>
              <div style={{ marginBottom: 6 }}>Send this link to anyone:</div>
              <div className="share-link">{publicLink.url}</div>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--muted)" }}>
                {publicLink.passwordRequired && <span>· Recipient will need the password you set.</span>}
                {publicLink.burnOnView && <span>· Link self-destructs after the first viewer (other than you) downloads it.</span>}
              </div>
              <div className="actions">
                <button onClick={() => navigator.clipboard.writeText(publicLink.url)}>Copy</button>
                <button className="primary" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            <>
              <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Expires in</label>
              <select value={linkExpiry} onChange={e => setLinkExpiry(Number(e.target.value))}>
                <option value={3600}>1 hour</option>
                <option value={86400}>1 day</option>
                <option value={604800}>7 days</option>
                <option value={2592000}>30 days</option>
              </select>
              <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginTop: 14, marginBottom: 6 }}>Password (optional)</label>
              <input type="password" autoComplete="new-password" value={linkPassword} onChange={e => setLinkPassword(e.target.value)} placeholder="Leave blank for no password" />
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, fontSize: 13 }}>
                <input type="checkbox" checked={linkBurn} onChange={e => setLinkBurn(e.target.checked)} />
                <span>Self-destruct after first non-owner view</span>
              </label>
              {linkErr && <div className="msg err" style={{ marginTop: 10 }}>{linkErr}</div>}
              <div className="actions">
                <button onClick={onClose}>Cancel</button>
                <button className="primary" disabled={linkBusy} onClick={createPublic}>
                  {linkBusy ? "Creating…" : "Create link"}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

type SharedFolder = { id: number; user_id: number; parent_id: number | null; name: string; created_at: string; role: "viewer" | "editor"; owner: { id: number; username: string; name: string } | null }
type SharedFile = FileItem & { user_id: number; role: "viewer" | "editor"; owner: { id: number; username: string; name: string } | null }

const SharedView: React.FC = () => {
  const [data, setData] = useState<{ folders: SharedFolder[]; files: SharedFile[] }>({ folders: [], files: [] })
  const [previewing, setPreviewing] = useState<FileItem | null>(null)

  const load = async () => {
    const res = await api.listSharedWithMe()
    if (res && "folders" in res) setData(res)
    else setData({ folders: [], files: [] })
  }
  useEffect(() => { load() }, [])

  const isEmpty = data.folders.length === 0 && data.files.length === 0

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs"><span className="current">Shared with me</span></div>
      </div>
      <div className="content">
        {isEmpty && (
          <div className="empty">
            <div className="big"><Users size={64} strokeWidth={1.25} /></div>
            <div>Nothing shared with you yet</div>
            <div style={{ marginTop: 8, fontSize: 13 }}>
              When someone adds you as a collaborator, the folder or file will appear here.
            </div>
          </div>
        )}
        {!isEmpty && (
          <div className="grid">
            {data.folders.map(f => (
              <div
                key={`sf-${f.id}`}
                className="card"
                onClick={() => navigate(folderHref(f.id, f.owner?.username))}
              >
                <div className="icon"><FolderIcon size={32} strokeWidth={1.5} /></div>
                <div className="name">{f.name}</div>
                <div className="meta">
                  {f.owner && <span>@{f.owner.username}</span>}
                  <span className="badge" style={{ marginLeft: 6 }}>{f.role}</span>
                </div>
              </div>
            ))}
            {data.files.map(f => (
              <div
                key={`sfi-${f.id}`}
                className="card"
                onClick={() => setPreviewing(f)}
              >
                <FileThumb file={f} />
                <div className="name">{f.name}</div>
                <div className="meta">
                  {formatBytes(f.size)}
                  {f.owner && <span style={{ marginLeft: 8 }}>@{f.owner.username}</span>}
                  <span className="badge" style={{ marginLeft: 6 }}>{f.role}</span>
                </div>
                <div className="row" onClick={e => e.stopPropagation()}>
                  <button onClick={() => downloadFile(f)}>Download</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {previewing && <PreviewModal file={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  )
}

const SharesView: React.FC = () => {
  const [shares, setShares] = useState<Share[]>([])

  const load = async () => {
    const data = await api.listShares()
    setShares(Array.isArray(data) ? data : [])
  }
  useEffect(() => { load() }, [])

  const revoke = async (id: number) => {
    if (!confirm("Revoke this share?")) return
    await api.deleteShare(id)
    await load()
  }

  if (shares.length === 0) {
    return (
      <div className="main">
        <div className="toolbar"><div className="crumbs"><span className="current">Shared links</span></div></div>
        <div className="content">
          <div className="empty"><div className="big"><Link2 size={64} strokeWidth={1.25} /></div><div>No active shares</div></div>
        </div>
      </div>
    )
  }

  return (
    <div className="main">
      <div className="toolbar"><div className="crumbs"><span className="current">Shared links</span></div></div>
      <div className="content">
        <table className="shares-table">
          <thead><tr><th>File</th><th>Link</th><th>Size</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {shares.map(s => {
              const url = `${window.location.origin}/s/${s.token}`
              return (
                <tr key={s.id}>
                  <td>
                    <span className="inline-icon"><MimeIcon mime={s.mime} size={16} /></span> {s.name}
                    {s.password_required && <span className="badge" style={{ marginLeft: 6 }}>password</span>}
                    {s.burn_on_view && <span className="badge" style={{ marginLeft: 6 }}>burn</span>}
                  </td>
                  <td><a href={url} target="_blank" rel="noreferrer">{url}</a></td>
                  <td>{formatBytes(s.size)}</td>
                  <td>{s.expires_at ? new Date(s.expires_at).toLocaleString() : "Never"}</td>
                  <td>
                    <button onClick={() => navigator.clipboard.writeText(url)}>Copy</button>
                    <button className="danger" onClick={() => revoke(s.id)}>Revoke</button>
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

const AuthedImage: React.FC<{ src: string; alt: string; useAuth: boolean }> = ({ src, alt, useAuth }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [resolved, setResolved] = useState<string | null>(useAuth ? null : src)
  const [loaded, setLoaded] = useState(false)
  const [visible, setVisible] = useState(!useAuth)

  useEffect(() => {
    if (!useAuth) return
    const node = ref.current
    if (!node) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) {
        setVisible(true)
        obs.disconnect()
      }
    }, { rootMargin: "200px" })
    obs.observe(node)
    return () => obs.disconnect()
  }, [useAuth])

  useEffect(() => {
    if (!useAuth || !visible || resolved) return
    let url: string | null = null
    let aborted = false
    ;(async () => {
      try {
        const res = await fetch(src, { headers: { authorization: `Bearer ${api.getToken()}` } })
        if (!res.ok) return
        const blob = await res.blob()
        if (aborted) return
        url = URL.createObjectURL(blob)
        setResolved(url)
      } catch {}
    })()
    return () => {
      aborted = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [src, useAuth, visible, resolved])

  return (
    <div ref={ref} className="thumb-wrap">
      {!loaded && <div className="thumb-spinner" aria-hidden="true" />}
      {resolved && (
        <img
          src={resolved}
          alt={alt}
          loading="lazy"
          onLoad={() => setLoaded(true)}
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
        <div className="big"><FileImage size={64} strokeWidth={1.25} /></div>
        <div>No photos yet</div>
      </div>
    )
  }

  return (
    <>
      <div className="gallery">
        {photos.map(p => (
          <div key={p.id} className="tile" onClick={() => setActive(photos.indexOf(p))}>
            <AuthedImage
              src={thumbUrl(p.id, p.version)}
              alt={p.name}
              useAuth={!!authHeader}
            />
          </div>
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
      if (!res.ok) { setSrc(null); return }
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
        <button onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="lightbox-stage" onClick={e => e.stopPropagation()}>
        {hasPrev && (
          <button className="lightbox-nav prev" onClick={onPrev} aria-label="Previous">‹</button>
        )}
        {file.mime.startsWith("video/") ? (
          src && <video src={src} controls autoPlay />
        ) : (
          src && <img src={src} alt={file.name} />
        )}
        {hasNext && (
          <button className="lightbox-nav next" onClick={onNext} aria-label="Next">›</button>
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
  key: string                    // value lives at draft[key]
  unitKey: string                // chosen unit lives at draft[unitKey]
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
    description: "Shrinks every image to a maximum width while keeping its proportions. Great for photo folders that don't need full-size originals.",
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
    apply: (v) => {
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
    summarize: (config) => {
      if (typeof config.width === "number") return `Maximum width ${config.width}px`
      if (typeof config.width_pct === "number") return `${config.width_pct}% of original width`
      return ""
    },
  },
  {
    id: "compress-images",
    name: "Save space (compress images)",
    description: "Re-saves images at smaller file sizes with little quality loss. Saves a lot of storage on photo-heavy folders.",
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
    apply: (v) => {
      const width = Math.max(64, Math.min(8192, Number(v.width ?? 2048) || 2048))
      const quality = Math.max(1, Math.min(100, Number(v.quality ?? 85) || 85))
      const cfg = { width, quality, format: "webp" }
      return [
        { slug: "stohr/resize-image", event: "file.created", config: cfg },
        { slug: "stohr/resize-image", event: "file.moved.in", config: cfg },
      ]
    },
    matches: (slug, config) => slug === "stohr/resize-image" && config.format === "webp",
    summarize: (config) => {
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
    apply: (v) => {
      const pattern = v.depth === "day" ? "YYYY/MM/DD" : "YYYY/MM"
      const cfg = { pattern }
      return [
        { slug: "stohr/organize-by-date", event: "file.created", config: cfg },
        { slug: "stohr/organize-by-date", event: "file.moved.in", config: cfg },
      ]
    },
    matches: (slug) => slug === "stohr/organize-by-date",
    summarize: (config) => config.pattern === "YYYY/MM/DD" ? "By year, month, and day" : "By year and month",
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
    const [list, uas] = await Promise.all([
      api.listFolderActions(folderId),
      api.listUserActions(),
    ])
    setActions(Array.isArray(list) ? list : [])
    setUserActions(Array.isArray(uas) ? uas : [])
  }
  useEffect(() => { void load() }, [folderId])

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
    setBusy(true); setError("")
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
    setBusy(true); setError("")
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
          <div className="auto-panel-sub">
            Run a helpful little task every time files arrive in this folder.
          </div>
        </div>
      </div>

      {groups.length === 0 && !adding && (
        <div className="auto-empty">Nothing automated yet.</div>
      )}

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
                <button onClick={() => navigate(`/app/actions/${g.userAction!.id}/edit`)} disabled={busy} title="Edit in Actions">
                  <Edit3 size={13} />
                </button>
              )}
              <button onClick={() => togglePause(g.rows)} disabled={busy}>
                {allOn ? "Pause" : "Resume"}
              </button>
              <button className="danger" onClick={() => removeGroup(label, g.rows)} disabled={busy}>Remove</button>
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
              <div className="auto-recipes-label" style={{ marginTop: 12 }}>Your actions</div>
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
                      <div className="auto-recipe-icon"><Zap size={20} strokeWidth={1.6} /></div>
                      <div className="auto-recipe-name">{ua.name}</div>
                      <div className="auto-recipe-desc">{ua.description ?? ""}</div>
                      {already && <div className="auto-recipe-flag">Already added</div>}
                    </button>
                  )
                })}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                Manage your actions in <a onClick={(e) => { e.preventDefault(); navigate("/app/actions") }} href="/app/actions" style={{ color: "var(--brand)", cursor: "pointer" }}>Actions</a>.
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
                <label className="auto-field-label" htmlFor={`auto-${f.key}`}>{f.label}</label>
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
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                )}
                {f.type === "number-unit" && (() => {
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
            <button onClick={() => setAdding(null)} disabled={busy}>Back</button>
            <button className="primary" onClick={submitAdd} disabled={busy}>
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

  const KIND_OPTIONS: Array<{ value: "standard" | "photos" | "screenshots"; label: string; desc: string; icon: React.ReactNode }> = [
    { value: "standard", label: "Files & folders", desc: "The classic. Anything goes.", icon: <FolderIcon size={20} strokeWidth={1.6} /> },
    { value: "photos", label: "Photo album", desc: "Show as a clean photo grid with lightbox.", icon: <FileImage size={20} strokeWidth={1.6} /> },
    { value: "screenshots", label: "Screenshots", desc: "Drop captures here from the menu bar.", icon: <Camera size={20} strokeWidth={1.6} /> },
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
            <div className="settings-section-sub">Public folders are visible to anyone with the link, no sign-in needed.</div>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={e => setIsPublic(e.target.checked)}
            />
            <span className="settings-toggle-track" aria-hidden="true"><span className="settings-toggle-dot" /></span>
            <div>
              <div className="settings-toggle-label">{isPublic ? "Public — anyone with the link" : "Private — only people I share with"}</div>
              {isPublic && (
                <div className="settings-toggle-help">Share the link below with anyone you want to give access.</div>
              )}
            </div>
          </label>
          {isPublic && (
            <div className="settings-link-row">
              <input className="settings-link-input" value={publicUrl} readOnly onFocus={e => e.currentTarget.select()} />
              <button onClick={() => navigator.clipboard.writeText(publicUrl)}>
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
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  )
}

type OAuthInfo = {
  client?: { client_id: string; name: string; description: string | null; icon_url: string | null; is_official: boolean }
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

const OAuthConsent: React.FC<{ query: string }> = ({ query }) => {
  const [info, setInfo] = useState<OAuthInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.oauthAuthorizeInfo(query).then(setInfo)
  }, [query])

  const params = useMemo(() => {
    const out: Record<string, string> = {}
    new URLSearchParams(query).forEach((v, k) => { out[k] = v })
    return out
  }, [query])

  const decide = async (approve: boolean) => {
    setBusy(true); setError(null)
    const res = approve
      ? await api.oauthAuthorizeApprove(params)
      : await api.oauthAuthorizeDeny(params)
    setBusy(false)
    if (res.error) {
      setError(res.error_description ?? res.error)
      return
    }
    if (res.redirect_url) {
      window.location.replace(res.redirect_url)
    }
  }

  if (!info) return <div className="share-page">Loading…</div>
  if (info.error || !info.client) {
    return (
      <div className="share-page">
        <div className="file-icon"><AlertTriangle size={64} strokeWidth={1.5} /></div>
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
        {info.client.is_official && (
          <div className="oauth-official">Official Stohr application</div>
        )}

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
          <button onClick={() => decide(false)} disabled={busy}>Deny</button>
          <button className="primary" onClick={() => decide(true)} disabled={busy}>
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
  client?: { client_id: string; name: string; description: string | null; icon_url: string | null; is_official: boolean }
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
    setBusy(true); setLookupErr(null)
    const res = await api.oauthDeviceInfo(trimmed) as DeviceInfo
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
    setBusy(true); setLookupErr(null)
    const res = approve
      ? await api.oauthDeviceApprove(info.user_code)
      : await api.oauthDeviceDeny(info.user_code)
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
            <div className="oauth-desc">
              Enter the code shown by the app you're trying to sign in.
            </div>
            <input
              autoFocus
              placeholder="ABCD-1234"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === "Enter") void fetchInfo(code) }}
              style={{ marginTop: 12, textAlign: "center", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 18, letterSpacing: 2 }}
            />
            {lookupErr && <div className="msg err" style={{ marginTop: 10 }}>{lookupErr}</div>}
            <div className="oauth-actions">
              <button className="primary" disabled={busy || code.trim().length === 0} onClick={() => fetchInfo(code)}>
                {busy ? "Looking up…" : "Continue"}
              </button>
            </div>
          </>
        )}

        {info && info.client && (
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
              <button onClick={() => decide(false)} disabled={busy}>Deny</button>
              <button className="primary" onClick={() => decide(true)} disabled={busy}>
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
    | { folder: { id: number; name: string; kind: string }; owner: { username: string; name: string }; files: GalleryFile[] }
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
        <div className="file-icon"><AlertTriangle size={64} strokeWidth={1.5} /></div>
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
    setBusy(true); setError(null)
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
        <div className="file-icon"><AlertTriangle size={64} strokeWidth={1.5} /></div>
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
          <div className="public-owner">{formatBytes(meta.size ?? 0)} • {meta.mime}</div>
        </div>
        {unlocked && content && (
          <button className="primary" onClick={triggerDownload}>
            <Download size={14} /> <span>Download</span>
          </button>
        )}
      </header>

      {!unlocked && (
        <div className="public-content share-viewer">
          <div className="share-gate">
            <div className="share-gate-card">
              <div className="share-gate-icon"><MimeIcon mime={meta.mime ?? ""} size={48} /></div>
              <div className="share-gate-name">{meta.name}</div>
              <div className="share-gate-meta">{formatBytes(meta.size ?? 0)} • {meta.mime}</div>
              {expiresLabel && <div className="share-gate-warn">Expires {expiresLabel}</div>}
              {meta.burn_on_view && (
                <div className="share-gate-burn">
                  <AlertTriangle size={14} /> One-time view — this link self-destructs after you open it
                </div>
              )}
              {meta.password_required && (
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="Password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") reveal() }}
                  style={{ marginTop: 12 }}
                />
              )}
              {error && <div className="msg err" style={{ marginTop: 10 }}>{error}</div>}
              <div className="actions" style={{ marginTop: 14 }}>
                <button className="primary" disabled={busy || (!!meta.password_required && !password)} onClick={reveal}>
                  {busy ? "Loading…" : (meta.burn_on_view ? "Open & destroy link" : "Open")}
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
              <div className="preview-audio-icon"><Music size={72} strokeWidth={1.25} /></div>
              <audio src={content.blobUrl} controls />
            </div>
          )}
          {kind === "pdf" && <iframe className="share-pdf" src={content.blobUrl} title={meta.name} />}
          {kind === "text" && <ShareText blobUrl={content.blobUrl} />}
          {kind === "other" && (
            <div className="empty">
              <div className="big"><MimeIcon mime={meta.mime ?? ""} size={64} /></div>
              <div>No inline preview for this file type</div>
              <button className="primary" onClick={triggerDownload} style={{ marginTop: 16 }}>
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
    fetch(blobUrl).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    }).then(t => { if (!aborted) setText(t) })
      .catch(e => { if (!aborted) setError(e.message) })
    return () => { aborted = true }
  }, [blobUrl])
  if (error) return <div className="empty">Could not load: {error}</div>
  if (text === null) return <div className="empty">Loading…</div>
  return <pre className="preview-text">{text}</pre>
}

/* ─────────── Action Builder views ─────────── */

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
  "file.created", "file.moved.in", "file.updated", "file.deleted", "file.moved.out",
  "folder.created", "folder.moved.in", "folder.updated", "folder.deleted", "folder.moved.out",
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
  useEffect(() => { void load() }, [])

  const builtins = registry.filter(r => r.is_builtin)
  const userActions = registry.filter(r => !r.is_builtin)

  const cloneBuiltin = async (slug: string) => {
    setBusy(true); setError("")
    const res = await api.cloneBuiltin(slug)
    setBusy(false)
    if (res.error) return setError(res.error)
    navigate(`/app/actions/${res.id}/edit`)
  }

  const createBlank = async () => {
    setBusy(true); setError("")
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
          <button className="primary" onClick={createBlank} disabled={busy}>
            <Plus size={14} /> <span>New action</span>
          </button>
        </div>
      </div>

      <div className="content">
        <div className="path-bar"><div className="crumbs"><span className="current">Actions</span></div></div>

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
                <div className="action-tile-icon"><Zap size={20} strokeWidth={1.6} /></div>
                <div className="action-tile-name">{a.name} <span className="action-tile-badge">Built-in</span></div>
                <div className="action-tile-desc">{a.description}</div>
                <div className="action-tile-buttons">
                  <button onClick={() => cloneBuiltin(a.slug)} disabled={busy}>Save a copy</button>
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
                <div className="action-tile-icon"><Zap size={20} strokeWidth={1.6} /></div>
                <div className="action-tile-name">{a.name}</div>
                {a.description && <div className="action-tile-desc">{a.description}</div>}
                {a.forked_from && <div className="action-tile-sub">Based on {a.forked_from}</div>}
                <div className="action-tile-buttons">
                  <button onClick={() => navigate(`/app/actions/${(a as any).id ?? Number(a.slug.replace(/^u\//, ""))}/edit`)}>
                    <Edit3 size={13} /> <span>Edit</span>
                  </button>
                  <button className="danger" onClick={() => remove((a as any).id ?? Number(a.slug.replace(/^u\//, "")), a.name)}>
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
      const [a, p] = await Promise.all([
        api.getUserAction(id),
        api.listPrimitives(),
      ])
      if ((a as any).error) { setError((a as any).error); return }
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
    const steps = draft.steps.map((s, idx) => idx === i ? { ...s, config } : s)
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
    setBusy(true); setError("")
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
          <button onClick={() => navigate("/app/actions")}>← Back</button>
          <button className="primary" onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="content">
        <div className="path-bar">
          <div className="crumbs">
            <span className="crumb" onClick={() => navigate("/app/actions")}>Actions</span>
            <span className="sep"><ChevronRight size={14} /></span>
            <span className="current">{draft.name}</span>
          </div>
        </div>

        <div className="action-edit">
          <section className="action-edit-section">
            <label className="action-edit-field">
              <span>Name</span>
              <input
                type="text"
                value={draft.name}
                onChange={e => update({ name: e.target.value })}
              />
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
            <div className="action-edit-section-sub">Each step happens to the file in turn. Filters can stop the chain.</div>

            {draft.steps.length === 0 && !picking && (
              <div className="actions-empty">No steps yet. Add one below.</div>
            )}

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
                      <button onClick={() => moveStep(i, -1)} disabled={i === 0} title="Move up">↑</button>
                      <button onClick={() => moveStep(i, 1)} disabled={i === draft.steps.length - 1} title="Move down">↓</button>
                      <button className="danger" onClick={() => removeStep(i)} title="Remove">×</button>
                    </div>
                  </div>
                  {prim && (
                    <PrimitiveConfigForm
                      prim={prim}
                      value={step.config}
                      onChange={cfg => updateStep(i, cfg)}
                    />
                  )}
                </div>
              )
            })}

            {picking ? (
              <div className="step-picker">
                <div className="step-picker-head">
                  <div className="step-picker-title">Add a step</div>
                  <button onClick={() => setPicking(false)}>Cancel</button>
                </div>
                {(["filter", "transform", "route"] as const).map(cat => groups[cat].length > 0 && (
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
                ))}
              </div>
            ) : (
              <button className="step-add" onClick={() => setPicking(true)}>
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
              <span>{label}{isRequired && <em className="req"> *</em>}</span>
              <select value={(val as string) ?? ""} onChange={e => onChange({ ...value, [key]: e.target.value })}>
                {!isRequired && !prop.default && <option value="">— choose —</option>}
                {prop.enum.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
              {help && <span className="step-config-help">{help}</span>}
            </label>
          )
        }
        if (prop.type === "integer" || prop.type === "number") {
          return (
            <label key={key} className="step-config-field">
              <span>{label}{isRequired && <em className="req"> *</em>}</span>
              <input
                type="number"
                min={prop.minimum}
                max={prop.maximum}
                value={val === undefined || val === null ? "" : String(val)}
                onChange={e => {
                  const v = e.target.value
                  onChange({ ...value, [key]: v === "" ? undefined : (prop.type === "integer" ? parseInt(v, 10) : parseFloat(v)) })
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
              <span>{label}{isRequired && <em className="req"> *</em>}</span>
              {help && <span className="step-config-help">{help}</span>}
            </label>
          )
        }
        if (prop.type === "array" && prop.items?.enum) {
          const arr = Array.isArray(val) ? (val as string[]) : []
          const items = (prop.items.enum as string[])
          return (
            <div key={key} className="step-config-field">
              <span>{label}{isRequired && <em className="req"> *</em>}</span>
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
            <span>{label}{isRequired && <em className="req"> *</em>}</span>
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

const Shell: React.FC<{ onLogout: () => void; route: Route }> = ({ onLogout, route }) => {
  const [userSnapshot, setUserSnapshot] = useState(api.getUser())
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1" } catch { return false }
  })

  const toggleCollapsed = () => {
    setCollapsed(v => {
      const next = !v
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0") } catch {}
      return next
    })
  }

  const activeTab: "files" | "shared" | "links" | "actions" | "trash" | "settings" | "admin" = (() => {
    if (route.kind === "shared") return "shared"
    if (route.kind === "links") return "links"
    if (route.kind === "actions" || route.kind === "actionEdit") return "actions"
    if (route.kind === "trash") return "trash"
    if (route.kind === "settings") return "settings"
    if (route.kind === "admin") return "admin"
    return "files"
  })()

  const initial = (userSnapshot?.name?.[0] ?? userSnapshot?.username?.[0] ?? "?").toUpperCase()

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand"><Logo /></div>
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
        <div className={`nav${activeTab === "files" ? " active" : ""}`} onClick={() => navigate("/")} title="My Files">
          <FolderOpen size={18} strokeWidth={1.75} /> <span className="nav-label">My Files</span>
        </div>
        <div className={`nav${activeTab === "shared" ? " active" : ""}`} onClick={() => navigate("/app/shared")} title="Shared with me">
          <Users size={18} strokeWidth={1.75} /> <span className="nav-label">Shared with me</span>
        </div>
        <div className={`nav${activeTab === "links" ? " active" : ""}`} onClick={() => navigate("/app/links")} title="Public links">
          <Link2 size={18} strokeWidth={1.75} /> <span className="nav-label">Public links</span>
        </div>
        <div className={`nav${activeTab === "actions" ? " active" : ""}`} onClick={() => navigate("/app/actions")} title="Actions">
          <Zap size={18} strokeWidth={1.75} /> <span className="nav-label">Actions</span>
        </div>
        <div className={`nav${activeTab === "trash" ? " active" : ""}`} onClick={() => navigate("/app/trash")} title="Trash">
          <Trash2 size={18} strokeWidth={1.75} /> <span className="nav-label">Trash</span>
        </div>
        <div className={`nav${activeTab === "settings" ? " active" : ""}`} onClick={() => navigate("/app/settings")} title="Settings">
          <SettingsIcon size={18} strokeWidth={1.75} /> <span className="nav-label">Settings</span>
        </div>
        {userSnapshot?.is_owner && (
          <div className={`nav${activeTab === "admin" ? " active" : ""}`} onClick={() => navigate("/app/admin")} title="Admin">
            <AlertTriangle size={18} strokeWidth={1.75} /> <span className="nav-label">Admin</span>
          </div>
        )}
        <div className="user-footer">
          <div className="user-avatar" aria-hidden="true">{initial}</div>
          <div className="user-meta">
            <div className="who">{userSnapshot?.name ?? ""}</div>
            <div className="who muted">@{userSnapshot?.username ?? ""}</div>
            <div className="logout" onClick={onLogout}>Sign out</div>
          </div>
        </div>
      </aside>
      {activeTab === "files" && (
        <Files
          routeFolderId={route.kind === "folder" ? route.id : null}
          routeFileId={route.kind === "file" ? route.id : null}
        />
      )}
      {activeTab === "shared" && <SharedView />}
      {activeTab === "links" && <SharesView />}
      {activeTab === "actions" && route.kind === "actions" && <ActionsListView />}
      {activeTab === "actions" && route.kind === "actionEdit" && <ActionEditView id={route.id} />}
      {activeTab === "trash" && <TrashView />}
      {activeTab === "settings" && (
        <Settings
          onProfileUpdate={() => setUserSnapshot(api.getUser())}
          onAccountDeleted={onLogout}
        />
      )}
      {activeTab === "admin" && <AdminView />}
    </div>
  )
}

type Subscription = {
  tier: string
  quota_bytes: number
  used_bytes: number
  active_bytes?: number
  trash_bytes?: number
  version_bytes?: number
  status: string | null
  renews_at: string | null
  has_subscription: boolean
}

const SubscriptionPanel: React.FC = () => {
  const [sub, setSub] = useState<Subscription | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const load = async () => {
    const data = await api.getMySubscription()
    if (!data.error) setSub(data)
  }
  useEffect(() => { load() }, [])

  const upgrade = async (tier: "personal" | "pro" | "studio") => {
    setBusy(true); setError("")
    const res = await api.startCheckout(tier, "monthly")
    setBusy(false)
    if (res.error || !res.checkout_url) {
      setError(res.error ?? "Could not start checkout")
      return
    }
    window.location.href = res.checkout_url
  }

  if (!sub) {
    return (
      <section className="settings-card">
        <h3>Subscription</h3>
        <div style={{ color: "var(--muted)", fontSize: 14 }}>Loading…</div>
      </section>
    )
  }

  const unlimited = sub.quota_bytes <= 0
  const pct = unlimited ? 0 : Math.min(100, (sub.used_bytes / sub.quota_bytes) * 100)
  const tierLabel = unlimited ? "Owner" : sub.tier.charAt(0).toUpperCase() + sub.tier.slice(1)

  return (
    <section className="settings-card">
      <h3>Subscription</h3>
      <div className="sub-current">
        <div className="sub-tier-row">
          <div>
            <div className="sub-tier">{tierLabel}</div>
            {sub.status && <div className="sub-status">{sub.status}{sub.renews_at ? ` · renews ${new Date(sub.renews_at).toLocaleDateString()}` : ""}</div>}
            {unlimited && <div className="sub-status">Operator account — no storage cap</div>}
          </div>
          <div className="sub-usage-text">
            {formatBytes(sub.used_bytes)}
            <span style={{ color: "var(--muted)" }}>
              {unlimited ? " used" : ` of ${formatBytes(sub.quota_bytes)}`}
            </span>
          </div>
        </div>
        {!unlimited && (
          <div className="sub-bar">
            <div className="sub-fill" style={{ width: `${pct}%`, background: pct > 90 ? "var(--danger)" : "var(--brand)" }} />
          </div>
        )}
        {(sub.active_bytes !== undefined) && (
          <div className="sub-breakdown">
            <span>Active <strong>{formatBytes(sub.active_bytes)}</strong></span>
            <span>Trash <strong>{formatBytes(sub.trash_bytes ?? 0)}</strong></span>
            <span>Versions <strong>{formatBytes(sub.version_bytes ?? 0)}</strong></span>
          </div>
        )}
      </div>

      {sub.tier === "free" && !unlimited && (
        <>
          <div style={{ marginTop: 16, color: "var(--muted)", fontSize: 13 }}>Upgrade for more storage:</div>
          <div className="sub-upgrade-grid">
            <button disabled={busy} onClick={() => upgrade("personal")}>
              <div className="sub-up-tier">Personal</div>
              <div className="sub-up-meta">50 GB · $6/mo</div>
            </button>
            <button className="primary" disabled={busy} onClick={() => upgrade("pro")}>
              <div className="sub-up-tier">Pro</div>
              <div className="sub-up-meta">250 GB · $14/mo</div>
            </button>
            <button disabled={busy} onClick={() => upgrade("studio")}>
              <div className="sub-up-tier">Studio</div>
              <div className="sub-up-meta">1 TB · $34/mo</div>
            </button>
          </div>
        </>
      )}

      {sub.tier !== "free" && sub.has_subscription && (
        <div style={{ marginTop: 16 }}>
          <a href="https://app.lemonsqueezy.com/my-orders" target="_blank" rel="noreferrer">
            <button>Manage subscription ↗</button>
          </a>
        </div>
      )}

      {error && <div className="msg err" style={{ marginTop: 12 }}>{error}</div>}
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
  useEffect(() => { load() }, [])

  const create = async () => {
    setBusy(true); setError("")
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
    <div className="dev-section">
      <h4>S3 access keys</h4>
      <div className="dev-section-desc">
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
              <button onClick={() => navigator.clipboard.writeText(justCreated.access_key)}>Copy</button>
            </div>
            <label>Secret key</label>
            <div className="dev-secret-row">
              <code>{justCreated.secret_key}</code>
              <button onClick={() => navigator.clipboard.writeText(justCreated.secret_key ?? "")}>Copy</button>
            </div>
          </div>
          <button onClick={() => setJustCreated(null)} style={{ marginTop: 8 }}>I've saved it</button>
        </div>
      )}

      {creating && !justCreated && (
        <div className="dev-create">
          <label>Name <span className="lp-field-opt">(optional, e.g. "laptop")</span></label>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="What's this key for?" autoFocus />
          {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
          <div className="settings-actions">
            <button onClick={() => { setCreating(false); setNewName("") }}>Cancel</button>
            <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create key"}</button>
          </div>
        </div>
      )}

      {!creating && !justCreated && (
        <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button className="primary" onClick={() => setCreating(true)}>
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
                  {k.last_used_at
                    ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}`
                    : " · never used"}
                </div>
              </div>
              <button className="danger" onClick={() => revoke(k.id)}>Revoke</button>
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
  useEffect(() => { load() }, [])

  const create = async () => {
    if (!newName.trim()) return setError("Name is required")
    setBusy(true); setError("")
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
    <div className="dev-section">
      <h4>Apps</h4>
      <div className="dev-section-desc">
        Personal access tokens for SDKs, mobile apps, and scripts. Use <code>Authorization: Bearer &lt;token&gt;</code> against any API endpoint.
      </div>

      {justCreated && justCreated.token && (
        <div className="msg ok" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            New app token — save it now, it won't be shown again
          </div>
          <div className="dev-secret">
            <label>{justCreated.name}</label>
            <div className="dev-secret-row">
              <code>{justCreated.token}</code>
              <button onClick={() => navigator.clipboard.writeText(justCreated.token ?? "")}>Copy</button>
            </div>
          </div>
          <button onClick={() => setJustCreated(null)} style={{ marginTop: 8 }}>I've saved it</button>
        </div>
      )}

      {creating && !justCreated && (
        <div className="dev-create">
          <label>Name</label>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Flutter app, CI bot" autoFocus />
          <label style={{ marginTop: 8 }}>Description <span className="lp-field-opt">(optional)</span></label>
          <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="What's this app for?" />
          {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
          <div className="settings-actions">
            <button onClick={() => { setCreating(false); setNewName(""); setNewDesc(""); setError("") }}>Cancel</button>
            <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create app"}</button>
          </div>
        </div>
      )}

      {!creating && !justCreated && (
        <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button className="primary" onClick={() => setCreating(true)}>
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
                {a.description && (
                  <div className="dev-row-desc">{a.description}</div>
                )}
                <div className="dev-row-meta">
                  Created {new Date(a.created_at).toLocaleDateString()}
                  {a.last_used_at
                    ? ` · last used ${new Date(a.last_used_at).toLocaleDateString()}`
                    : " · never used"}
                </div>
              </div>
              <button className="danger" onClick={() => revoke(a.id)}>Revoke</button>
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
      {me?.is_owner && <OAuthClientsSection />}
    </section>
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
  useEffect(() => { load() }, [])

  const reset = () => {
    setName(""); setDescription(""); setRedirectsRaw("")
    setScopeRead(true); setScopeWrite(true); setScopeShare(true)
    setIsOfficial(false); setConfidential(false); setError("")
  }

  const create = async () => {
    if (!name.trim()) return setError("Name is required")
    const redirect_uris = redirectsRaw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    if (redirect_uris.length === 0) return setError("At least one redirect URI is required")
    const allowed_scopes = [
      ...(scopeRead ? ["read"] : []),
      ...(scopeWrite ? ["write"] : []),
      ...(scopeShare ? ["share"] : []),
    ]
    if (allowed_scopes.length === 0) return setError("At least one scope is required")

    setBusy(true); setError("")
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
    if (!confirm("Revoke this OAuth client? Existing access tokens will continue to work until they expire (1h), but no new tokens can be issued.")) return
    const res = await api.adminRevokeOAuthClient(id)
    if (res.error) return alert(res.error)
    await load()
  }

  const rotateSecret = async (id: number, name: string) => {
    if (!confirm(`Rotate the client_secret for "${name}"? Every existing refresh token for this client will be invalidated and connected apps will need to re-authenticate.`)) return
    const res = await api.adminRotateOAuthClientSecret(id) as { client_id?: string; client_secret?: string; error?: string }
    if (res.error) return alert(res.error)
    if (!res.client_secret) return alert("Rotation succeeded but no secret was returned")
    setJustCreated({
      ...(clients.find(c => c.id === id) as OAuthClient),
      client_secret: res.client_secret,
    })
    await load()
  }

  return (
    <div className="dev-section">
      <h4>OAuth applications</h4>
      <div className="dev-section-desc">
        Register apps that authenticate users via OAuth 2.0 + PKCE. Use for native/desktop/mobile clients (Butter, etc.) or third-party integrations.
      </div>

      {justCreated && (
        <div className="msg ok" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Client created — copy these now</div>
          <div className="dev-secret">
            <label>Client ID</label>
            <div className="dev-secret-row">
              <code>{justCreated.client_id}</code>
              <button onClick={() => navigator.clipboard.writeText(justCreated.client_id)}>Copy</button>
            </div>
            {justCreated.client_secret && (
              <>
                <label>Client secret <span style={{ color: "var(--muted)", fontWeight: 400 }}>(only shown once)</span></label>
                <div className="dev-secret-row">
                  <code>{justCreated.client_secret}</code>
                  <button onClick={() => navigator.clipboard.writeText(justCreated.client_secret ?? "")}>Copy</button>
                </div>
              </>
            )}
          </div>
          <button onClick={() => setJustCreated(null)} style={{ marginTop: 8 }}>I've saved it</button>
        </div>
      )}

      {creating && !justCreated && (
        <div className="dev-create">
          <label>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Butter" autoFocus />
          <label style={{ marginTop: 10 }}>Description <span className="lp-field-opt">(optional)</span></label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Desktop screenshot uploader" />
          <label style={{ marginTop: 10 }}>Redirect URIs <span className="lp-field-opt">(one per line, exact match)</span></label>
          <textarea
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
                Stohrshot desktop app: <code>stohrshot://oauth/callback</code>
                {" "}
                <button
                  type="button"
                  onClick={() => {
                    const uri = "stohrshot://oauth/callback"
                    setRedirectsRaw(prev => {
                      const lines = prev.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
                      return lines.includes(uri) ? prev : [...lines, uri].join("\n")
                    })
                  }}
                  style={{ marginLeft: 4, padding: "1px 8px", fontSize: 11 }}
                >
                  Use this
                </button>
              </li>
              <li>iOS/Android mobile app: a custom scheme like <code>stohrapp://oauth/callback</code></li>
              <li>SPA / web app: <code>https://yourapp.example.com/callback</code></li>
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
            <span>Confidential client (issues a client_secret — for server-side apps only; native apps must stay public)</span>
          </label>
          {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
          <div className="settings-actions">
            <button onClick={() => { setCreating(false); reset() }}>Cancel</button>
            <button className="primary" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create client"}</button>
          </div>
        </div>
      )}

      {!creating && !justCreated && (
        <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button className="primary" onClick={() => setCreating(true)}>Register new OAuth client</button>
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
                  {c.is_official && <span className="badge" style={{ background: "var(--brand)", color: "white" }}>official</span>}
                  {c.revoked_at && <span className="badge" style={{ background: "var(--muted)" }}>revoked</span>}
                </div>
                {c.description && <div className="dev-row-desc">{c.description}</div>}
                <div className="dev-row-meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  <span style={{ color: "var(--muted)" }}>client_id</span>
                  <code style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border)", fontSize: 11 }}>{c.client_id}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(c.client_id)}
                    style={{ padding: "2px 8px", fontSize: 11 }}
                  >
                    Copy
                  </button>
                  {!c.is_public_client && <span className="badge" style={{ background: "var(--muted)", marginLeft: 4 }}>has secret</span>}
                </div>
                <div className="dev-row-meta">
                  Scopes: {c.allowed_scopes.join(", ")} · Redirects: {c.redirect_uris.length}
                  {c.is_public_client ? " · public (PKCE)" : " · confidential"}
                </div>
              </div>
              {!c.revoked_at && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {!c.is_public_client && (
                    <button onClick={() => rotateSecret(c.id, c.name)}>Rotate secret</button>
                  )}
                  <button className="danger" onClick={() => revoke(c.id)}>Revoke</button>
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
    const s = await api.getMfaStatus() as MfaStatus
    setStatus(s)
  }
  useEffect(() => { reload() }, [])

  const start = async () => {
    setBusy(true); setError("")
    try {
      const res = await api.startMfaSetup() as { secret: string; otpauth_url: string; error?: string }
      if (res.error) { setError(res.error); return }
      const QR: typeof import("qrcode") = await import("qrcode")
      const qr = await QR.toDataURL(res.otpauth_url, { margin: 1, width: 200 })
      setSetup({ secret: res.secret, otpauth_url: res.otpauth_url, qr })
    } finally {
      setBusy(false)
    }
  }

  const enable = async () => {
    setBusy(true); setError("")
    try {
      const res = await api.enableMfa(enableCode.trim()) as { ok?: boolean; backup_codes?: string[]; error?: string }
      if (res.error) { setError(res.error); return }
      setBackupCodes(res.backup_codes ?? [])
      setSetup(null)
      setEnableCode("")
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true); setError("")
    try {
      const res = await api.disableMfa(disablePw, disableCode.trim()) as { ok?: boolean; error?: string }
      if (res.error) { setError(res.error); return }
      setShowDisable(false)
      setDisablePw(""); setDisableCode("")
      setBackupCodes(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const regen = async () => {
    setBusy(true); setError("")
    try {
      const res = await api.regenerateBackupCodes(regenPw) as { backup_codes?: string[]; error?: string }
      if (res.error) { setError(res.error); return }
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
          <button className="primary" disabled={busy} onClick={start}>Set up authenticator</button>
        </div>
      )}

      {setup && (
        <div className="dev-create">
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            Scan with Google Authenticator, 1Password, Authy, or any TOTP app — then enter the 6-digit code below.
          </div>
          <img src={setup.qr} alt="QR code" style={{ width: 180, height: 180, background: "#fff", padding: 8, borderRadius: 8 }} />
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>Or enter this secret manually:</div>
          <code style={{ display: "block", marginTop: 4, padding: 6, background: "var(--panel)", borderRadius: 4, fontSize: 12, wordBreak: "break-all" }}>
            {setup.secret}
          </code>
          <label style={{ marginTop: 14 }}>6-digit code from your app</label>
          <input
            inputMode="numeric"
            maxLength={6}
            value={enableCode}
            onChange={e => setEnableCode(e.target.value.replace(/\D/g, ""))}
          />
          {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
          <div className="settings-actions">
            <button onClick={() => { setSetup(null); setEnableCode(""); setError("") }}>Cancel</button>
            <button className="primary" disabled={busy || enableCode.length !== 6} onClick={enable}>Enable MFA</button>
          </div>
        </div>
      )}

      {backupCodes && (
        <div className="msg ok" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Save your backup codes — these won't be shown again</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, marginBottom: 8 }}>
            {backupCodes.map(c => <div key={c}>{c}</div>)}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => navigator.clipboard.writeText(backupCodes.join("\n"))}>Copy all</button>
            <button onClick={() => setBackupCodes(null)}>I've saved them</button>
          </div>
        </div>
      )}

      {status.enabled && !setup && !backupCodes && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span className="badge" style={{ background: "var(--brand)", color: "white" }}>Enabled</span>
            {status.enabled_at && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>since {new Date(status.enabled_at).toLocaleDateString()}</span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
            {status.backup_codes_remaining} backup code{status.backup_codes_remaining === 1 ? "" : "s"} remaining
          </div>

          {!showDisable && !showRegen && (
            <div className="settings-actions" style={{ justifyContent: "flex-start" }}>
              <button onClick={() => { setShowRegen(true); setError("") }}>Regenerate backup codes</button>
              <button className="danger" onClick={() => { setShowDisable(true); setError("") }}>Disable MFA</button>
            </div>
          )}

          {showRegen && (
            <div className="dev-create">
              <label>Confirm with your password</label>
              <input type="password" value={regenPw} onChange={e => setRegenPw(e.target.value)} />
              {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
              <div className="settings-actions">
                <button onClick={() => { setShowRegen(false); setRegenPw(""); setError("") }}>Cancel</button>
                <button className="primary" disabled={busy || !regenPw} onClick={regen}>Regenerate</button>
              </div>
            </div>
          )}

          {showDisable && (
            <div className="dev-create">
              <label>Password</label>
              <input type="password" value={disablePw} onChange={e => setDisablePw(e.target.value)} />
              <label style={{ marginTop: 10 }}>6-digit code from your app</label>
              <input
                inputMode="numeric"
                maxLength={6}
                value={disableCode}
                onChange={e => setDisableCode(e.target.value.replace(/\D/g, ""))}
              />
              {error && <div className="msg err" style={{ marginTop: 8 }}>{error}</div>}
              <div className="settings-actions">
                <button onClick={() => { setShowDisable(false); setDisablePw(""); setDisableCode(""); setError("") }}>Cancel</button>
                <button className="danger" disabled={busy || !disablePw || disableCode.length !== 6} onClick={disable}>Disable MFA</button>
              </div>
            </div>
          )}
        </>
      )}

      <SessionsSection />
    </section>
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
  useEffect(() => { load() }, [])

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
    <div className="dev-section">
      <h4>Active sessions</h4>
      <div className="dev-section-desc">
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
                    {s.current && <span className="badge" style={{ background: "var(--brand)", color: "white" }}>this session</span>}
                  </div>
                  <div className="dev-row-meta">
                    {s.ip ?? "Unknown IP"} · last used {new Date(s.last_used_at).toLocaleString()}
                  </div>
                </div>
                {!s.current && (
                  <button className="danger" disabled={busy} onClick={() => revoke(s.id)}>Sign out</button>
                )}
              </div>
            ))}
          </div>
          {rows.some(s => !s.current) && (
            <div className="settings-actions" style={{ justifyContent: "flex-start", marginTop: 12 }}>
              <button className="danger" disabled={busy} onClick={revokeOthers}>Sign out all other sessions</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

type Invite = { id: number; token: string; email: string | null; used_at: string | null; used_by: number | null; created_at: string }

const InvitesPanel: React.FC = () => {
  const [invites, setInvites] = useState<Invite[]>([])
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")

  const load = async () => {
    const list = await api.listInvites()
    setInvites(Array.isArray(list) ? list : [])
  }
  useEffect(() => { load() }, [])

  const create = async () => {
    setError("")
    const res = await api.createInvite(email.trim() || undefined)
    if (res.error) return setError(res.error)
    setEmail("")
    await load()
  }

  const revoke = async (id: number) => {
    if (!confirm("Revoke this invite?")) return
    const res = await api.revokeInvite(id)
    if (res.error) return alert(res.error)
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
      <label>Email (optional, locks the invite to this address)</label>
      <input type="email" placeholder="alice@example.com" value={email} onChange={e => setEmail(e.target.value)} />
      {error && <div className="msg err">{error}</div>}
      <div className="settings-actions">
        <button className="primary" onClick={create}>
          <Mail size={14} /> <span>Create invite</span>
        </button>
      </div>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {invites.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>No invites yet</div>}
        {invites.map(inv => {
          const url = `${window.location.origin}/signup?invite=${inv.token}`
          return (
            <div key={inv.id} style={{ padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{ flex: 1, fontWeight: 500 }}>
                  {inv.email ?? "Open invite"}
                  {inv.used_at && <span className="badge" style={{ marginLeft: 8, background: "var(--muted)" }}>used</span>}
                </div>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  {new Date(inv.created_at).toLocaleDateString()}
                </span>
              </div>
              <div className="share-link" style={{ margin: "4px 0", fontSize: 11 }}>{url}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button onClick={() => copyLink(inv.token)} disabled={!!inv.used_at}>Copy link</button>
                {!inv.used_at && (
                  <button className="danger" onClick={() => revoke(inv.id)} style={{ marginLeft: "auto" }}>Revoke</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

type SettingsTab = "profile" | "subscription" | "security" | "developer" | "invites" | "account"

const Settings: React.FC<{ onProfileUpdate: () => void; onAccountDeleted: () => void }> = ({ onProfileUpdate, onAccountDeleted }) => {
  const current = api.getUser()
  const [tab, setTab] = useState<SettingsTab>("profile")
  const [name, setName] = useState(current?.name ?? "")
  const [username, setUsername] = useState(current?.username ?? "")
  const [email, setEmail] = useState(current?.email ?? "")
  const [profileMsg, setProfileMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

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

  const saveProfile = async () => {
    setProfileMsg(null)
    const patch: { name?: string; email?: string; username?: string } = {}
    if (name.trim() && name.trim() !== current?.name) patch.name = name.trim()
    if (email.trim() && email.trim() !== current?.email) patch.email = email.trim()
    if (username.trim() && username.trim() !== current?.username) patch.username = username.trim()
    if (!patch.name && !patch.email && !patch.username) {
      setProfileMsg({ kind: "err", text: "Nothing changed" })
      return
    }
    const res = await api.updateProfile(patch)
    if (res.error) return setProfileMsg({ kind: "err", text: res.error })
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
    setCurrentPw(""); setNewPw(""); setConfirmPw("")
  }

  const deleteAccount = async () => {
    setDeleteErr("")
    if (!deletePw) return setDeleteErr("Enter your password to confirm")
    const res = await api.deleteAccount(deletePw)
    if (res.error) return setDeleteErr(res.error)
    onAccountDeleted()
  }

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "profile", label: "Profile" },
    { id: "subscription", label: "Subscription" },
    { id: "security", label: "Security" },
    { id: "developer", label: "Developer" },
    { id: "invites", label: "Invites" },
    { id: "account", label: "Account" },
  ]

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs"><span className="current">Settings</span></div>
      </div>
      <div className="content">
        <div className="settings">
          <nav className="settings-tabs" role="tablist">
            {tabs.map(t => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {tab === "profile" && (
            <>
              <section className="settings-card">
                <h3>Profile</h3>
                <label>Name</label>
                <input value={name} onChange={e => setName(e.target.value)} />
                <label>Username</label>
                <input
                  value={username}
                  onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <label>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
                {profileMsg && <div className={`msg ${profileMsg.kind}`}>{profileMsg.text}</div>}
                <div className="settings-actions">
                  <button className="primary" onClick={saveProfile}>Save changes</button>
                </div>
              </section>

              <section className="settings-card">
                <h3>Appearance</h3>
                <label>Theme</label>
                <div className="theme-group">
                  <button className={theme === "light" ? "active" : ""} onClick={() => chooseTheme("light")}>
                    <Sun size={14} /> <span>Light</span>
                  </button>
                  <button className={theme === "dark" ? "active" : ""} onClick={() => chooseTheme("dark")}>
                    <Moon size={14} /> <span>Dark</span>
                  </button>
                  <button className={theme === "system" ? "active" : ""} onClick={() => chooseTheme("system")}>
                    <Monitor size={14} /> <span>System</span>
                  </button>
                </div>
              </section>
            </>
          )}

          {tab === "subscription" && <SubscriptionPanel />}

          {tab === "security" && (
            <>
              <SecurityPanel />
              <section className="settings-card">
                <h3>Change password</h3>
                <label>Current password</label>
                <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} />
                <label>New password</label>
                <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} />
                <label>Confirm new password</label>
                <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} />
                {pwMsg && <div className={`msg ${pwMsg.kind}`}>{pwMsg.text}</div>}
                <div className="settings-actions">
                  <button className="primary" onClick={savePassword}>Update password</button>
                </div>
              </section>
            </>
          )}

          {tab === "developer" && <DeveloperPanel />}

          {tab === "invites" && <InvitesPanel />}

          {tab === "account" && (
            <section className="settings-card danger-zone">
              <h3>Danger zone</h3>
              <div className="danger-desc">Permanently delete your account and all files. This cannot be undone.</div>
              {!confirmingDelete ? (
                <div className="settings-actions">
                  <button className="danger" onClick={() => setConfirmingDelete(true)}>Delete account</button>
                </div>
              ) : (
                <>
                  <label>Enter your password to confirm</label>
                  <input type="password" value={deletePw} onChange={e => setDeletePw(e.target.value)} />
                  {deleteErr && <div className="msg err">{deleteErr}</div>}
                  <div className="settings-actions">
                    <button onClick={() => { setConfirmingDelete(false); setDeletePw(""); setDeleteErr("") }}>Cancel</button>
                    <button className="danger" onClick={deleteAccount}>Permanently delete</button>
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

type AdminInviteRequest = {
  id: number
  email: string
  name: string | null
  reason: string | null
  status: "pending" | "invited" | "dismissed"
  processed_at: string | null
  created_at: string
}

const AdminView: React.FC = () => {
  const me = api.getUser()
  const [section, setSection] = useState<"requests" | "users" | "invites" | "payments" | "stats" | "audit">("requests")

  if (!me?.is_owner) {
    return (
      <div className="main">
        <div className="toolbar"><div className="crumbs"><span className="current">Admin</span></div></div>
        <div className="content"><div className="empty"><div>Owner access required</div></div></div>
      </div>
    )
  }

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs"><span className="current">Admin</span></div>
      </div>
      <div className="content">
        <div className="admin-sections">
          <button className={section === "requests" ? "active" : ""} onClick={() => setSection("requests")}>Requests</button>
          <button className={section === "users" ? "active" : ""} onClick={() => setSection("users")}>Users</button>
          <button className={section === "invites" ? "active" : ""} onClick={() => setSection("invites")}>Invites</button>
          <button className={section === "payments" ? "active" : ""} onClick={() => setSection("payments")}>Payments</button>
          <button className={section === "stats" ? "active" : ""} onClick={() => setSection("stats")}>Stats</button>
          <button className={section === "audit" ? "active" : ""} onClick={() => setSection("audit")}>Audit</button>
        </div>
        {section === "requests" && <AdminRequests />}
        {section === "users" && <AdminUsers meId={me.id} />}
        {section === "invites" && <AdminInvites />}
        {section === "payments" && <AdminPayments />}
        {section === "stats" && <AdminStats />}
        {section === "audit" && <AdminAudit />}
      </div>
    </div>
  )
}

const AdminRequests: React.FC = () => {
  const [tab, setTab] = useState<"pending" | "invited" | "dismissed">("pending")
  const [rows, setRows] = useState<AdminInviteRequest[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [invited, setInvited] = useState<{ id: number; email: string; token: string } | null>(null)

  const load = async () => {
    const data = await api.adminListInviteRequests(tab)
    setRows(Array.isArray(data) ? data : [])
  }
  useEffect(() => { load() }, [tab])

  const sendInvite = async (id: number) => {
    setBusy(id)
    const res = await api.adminInviteFromRequest(id)
    setBusy(null)
    if (res.error) return alert(res.error)
    setInvited({ id, email: res.email, token: res.invite_token })
    await load()
  }

  const dismiss = async (id: number) => {
    if (!confirm("Dismiss this request?")) return
    setBusy(id)
    const res = await api.adminDismissRequest(id)
    setBusy(null)
    if (res.error) return alert(res.error)
    await load()
  }

  const remove = async (id: number) => {
    if (!confirm("Permanently delete this request?")) return
    setBusy(id)
    const res = await api.adminDeleteRequest(id)
    setBusy(null)
    if (res.error) return alert(res.error)
    await load()
  }

  const inviteUrl = invited ? `${window.location.origin}/signup?invite=${invited.token}` : ""

  return (
    <section className="settings-card">
      <h3>Invite requests</h3>
      <div className="admin-tabs">
        <button className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>Pending</button>
        <button className={tab === "invited" ? "active" : ""} onClick={() => setTab("invited")}>Invited</button>
        <button className={tab === "dismissed" ? "active" : ""} onClick={() => setTab("dismissed")}>Dismissed</button>
      </div>

      {invited && (
        <div className="msg ok" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Invite minted for {invited.email}</div>
          <div className="share-link" style={{ margin: "4px 0" }}>{inviteUrl}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => navigator.clipboard.writeText(inviteUrl)}>Copy link</button>
            <button onClick={() => setInvited(null)}>Done</button>
          </div>
        </div>
      )}

      {rows.length === 0 && (
        <div style={{ marginTop: 16, color: "var(--muted)", fontSize: 14 }}>No {tab} requests.</div>
      )}

      <div className="admin-list">
        {rows.map(r => (
          <div key={r.id} className="admin-row">
            <div className="admin-row-main">
              <div className="admin-row-line">
                <strong>{r.email}</strong>
                {r.name && <span className="admin-row-name">· {r.name}</span>}
                <span className="admin-row-when">{new Date(r.created_at).toLocaleDateString()}</span>
              </div>
              {r.reason && <div className="admin-row-reason">{r.reason}</div>}
            </div>
            <div className="admin-row-actions">
              {r.status === "pending" && (
                <>
                  <button className="primary" disabled={busy === r.id} onClick={() => sendInvite(r.id)}>Send invite</button>
                  <button disabled={busy === r.id} onClick={() => dismiss(r.id)}>Dismiss</button>
                </>
              )}
              {r.status !== "pending" && (
                <button className="danger" disabled={busy === r.id} onClick={() => remove(r.id)}>Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

type AdminUser = {
  id: number
  username: string
  email: string
  name: string
  is_owner: boolean
  storage_bytes: number
  file_count: number
  created_at: string
}

const AdminUsers: React.FC<{ meId: number }> = ({ meId }) => {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [busy, setBusy] = useState<number | null>(null)

  const load = async () => {
    const data = await api.adminListUsers()
    setUsers(Array.isArray(data) ? data : [])
  }
  useEffect(() => { load() }, [])

  const toggleOwner = async (u: AdminUser) => {
    if (u.id === meId) return
    if (!confirm(`${u.is_owner ? "Remove" : "Grant"} owner role ${u.is_owner ? "from" : "to"} @${u.username}?`)) return
    setBusy(u.id)
    const res = await api.adminSetOwner(u.id, !u.is_owner)
    setBusy(null)
    if (res.error) return alert(res.error)
    await load()
  }

  const remove = async (u: AdminUser) => {
    if (u.id === meId) return alert("Use Settings to delete your own account.")
    if (!confirm(`Permanently delete @${u.username}? All their files will be removed.`)) return
    setBusy(u.id)
    const res = await api.adminDeleteUser(u.id)
    setBusy(null)
    if (res.error) return alert(res.error)
    await load()
  }

  return (
    <section className="settings-card">
      <h3>Users <span className="admin-count">({users.length})</span></h3>
      {users.length === 0 && <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 14 }}>No users yet.</div>}
      <div className="admin-list">
        {users.map(u => (
          <div key={u.id} className="admin-row">
            <div className="admin-row-main">
              <div className="admin-row-line">
                <strong>@{u.username}</strong>
                <span className="admin-row-name">{u.name}</span>
                <span className="admin-row-name">· {u.email}</span>
                {u.is_owner && <span className="admin-pill admin-pill-owner">owner</span>}
                {u.id === meId && <span className="admin-pill">you</span>}
                <span className="admin-row-when">{new Date(u.created_at).toLocaleDateString()}</span>
              </div>
              <div className="admin-row-reason">
                {formatBytes(u.storage_bytes)} · {u.file_count} file{u.file_count === 1 ? "" : "s"}
              </div>
            </div>
            <div className="admin-row-actions">
              <button disabled={busy === u.id || u.id === meId} onClick={() => toggleOwner(u)}>
                {u.is_owner ? "Revoke owner" : "Make owner"}
              </button>
              {u.id !== meId && (
                <button className="danger" disabled={busy === u.id} onClick={() => remove(u)}>Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

type AdminInvite = {
  id: number
  token: string
  email: string | null
  invited_by: number | null
  invited_by_username: string | null
  used_at: string | null
  used_by: number | null
  used_by_username: string | null
  created_at: string
}

const AdminInvites: React.FC = () => {
  const [filter, setFilter] = useState<"all" | "unused" | "used">("unused")
  const [invites, setInvites] = useState<AdminInvite[]>([])
  const [busy, setBusy] = useState<number | null>(null)

  const load = async () => {
    const data = await api.adminListAllInvites(filter)
    setInvites(Array.isArray(data) ? data : [])
  }
  useEffect(() => { load() }, [filter])

  const remove = async (id: number) => {
    if (!confirm("Delete this invite?")) return
    setBusy(id)
    const res = await api.adminDeleteInvite(id)
    setBusy(null)
    if (res.error) return alert(res.error)
    await load()
  }

  return (
    <section className="settings-card">
      <h3>All invites <span className="admin-count">({invites.length})</span></h3>
      <div className="admin-tabs">
        <button className={filter === "unused" ? "active" : ""} onClick={() => setFilter("unused")}>Unused</button>
        <button className={filter === "used" ? "active" : ""} onClick={() => setFilter("used")}>Used</button>
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>
      </div>
      {invites.length === 0 && <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 14 }}>No {filter === "all" ? "" : filter} invites.</div>}
      <div className="admin-list">
        {invites.map(inv => {
          const url = `${window.location.origin}/signup?invite=${inv.token}`
          return (
            <div key={inv.id} className="admin-row">
              <div className="admin-row-main">
                <div className="admin-row-line">
                  <strong>{inv.email ?? "Open invite"}</strong>
                  {inv.invited_by_username && <span className="admin-row-name">from @{inv.invited_by_username}</span>}
                  {inv.used_by_username && <span className="admin-pill admin-pill-used">used by @{inv.used_by_username}</span>}
                  <span className="admin-row-when">{new Date(inv.created_at).toLocaleDateString()}</span>
                </div>
                {!inv.used_at && <div className="admin-row-reason" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{url}</div>}
              </div>
              <div className="admin-row-actions">
                {!inv.used_at && (
                  <>
                    <button onClick={() => navigator.clipboard.writeText(url)}>Copy</button>
                    <button className="danger" disabled={busy === inv.id} onClick={() => remove(inv.id)}>Delete</button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

type AutoSetupResult = {
  store: { id: string; name: string; slug: string; url: string }
  webhook: { id: string; url: string } | null
  webhook_error: string | null
  plans: Record<string, { monthly: string | null; yearly: string | null; product_name: string | null }>
  unmatched_products: string[]
}

const TIER_DETAILS: Record<"personal" | "pro" | "studio", { label: string; storage: string; monthly: string; yearly: string }> = {
  personal: { label: "Personal", storage: "50 GB", monthly: "$6", yearly: "$60" },
  pro: { label: "Pro", storage: "250 GB", monthly: "$14", yearly: "$140" },
  studio: { label: "Studio", storage: "1 TB", monthly: "$34", yearly: "$340" },
}

const AutoSetupCard: React.FC<{ webhookUrl: string; mode: "test" | "live"; onSetup: () => void }> = ({ webhookUrl, mode, onSetup }) => {
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AutoSetupResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storesAvailable, setStoresAvailable] = useState<string[] | null>(null)

  const run = async () => {
    if (!apiKey.trim()) { setError("Paste your Lemon Squeezy API key"); return }
    setBusy(true); setError(null); setStoresAvailable(null)
    const res = await api.adminAutoSetupPayments({
      api_key: apiKey.trim(),
      webhook_url: webhookUrl,
      mode,
    })
    setBusy(false)
    if (res.error) {
      if (Array.isArray(res.stores)) {
        setStoresAvailable(res.stores.map((s: any) => s.name))
      }
      setError(res.error)
      return
    }
    setResult(res as AutoSetupResult)
    onSetup()
  }

  if (result) {
    const todo: Array<{ tier: "personal" | "pro" | "studio"; missing: string[] }> = []
    for (const tier of ["personal", "pro", "studio"] as const) {
      const p = result.plans[tier]!
      const missing: string[] = []
      if (!p.product_name) {
        missing.push(`Create product "${tier.charAt(0).toUpperCase() + tier.slice(1)}"`)
      }
      if (!p.monthly) missing.push(`Add monthly variant at ${TIER_DETAILS[tier].monthly}`)
      if (!p.yearly) missing.push(`Add yearly variant at ${TIER_DETAILS[tier].yearly}`)
      if (missing.length > 0) todo.push({ tier, missing })
    }
    return (
      <div className="autosetup-result">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div className="autosetup-check">✓</div>
          <div>
            <div style={{ fontWeight: 600 }}>Connected to {result.store.name}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{result.store.url}</div>
          </div>
        </div>
        <div className="autosetup-grid">
          {(["personal", "pro", "studio"] as const).map(tier => {
            const p = result.plans[tier]!
            const ok = !!p.monthly || !!p.yearly
            return (
              <div key={tier} className={`autosetup-tier ${ok ? "ok" : "warn"}`}>
                <div className="autosetup-tier-name">{tier}</div>
                <div className="autosetup-tier-status">
                  {p.product_name ? p.product_name : "Not found"}
                </div>
                <div className="autosetup-tier-periods">
                  <span className={p.monthly ? "yes" : "no"}>monthly {p.monthly ? "✓" : "—"}</span>
                  <span className={p.yearly ? "yes" : "no"}>yearly {p.yearly ? "✓" : "—"}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ marginTop: 12, fontSize: 13 }}>
          {result.webhook && <div className="msg ok">Webhook created at {result.webhook.url}</div>}
          {result.webhook_error && (
            <div className="msg err">
              Webhook creation failed: {result.webhook_error}<br />
              <span style={{ fontSize: 12, opacity: 0.85 }}>Add it manually in Lemon Squeezy → Settings → Webhooks pointing at <code>{webhookUrl}</code>, then paste the signing secret below.</span>
            </div>
          )}
          {result.unmatched_products.length > 0 && (
            <div className="msg" style={{ background: "var(--bg)", border: "1px solid var(--border)", padding: "10px 12px", borderRadius: 6, marginTop: 8, fontSize: 13 }}>
              Unmatched products (rename to "Personal", "Pro", or "Studio" to map them): {result.unmatched_products.join(", ")}
            </div>
          )}
          {todo.length > 0 && (
            <div className="msg" style={{ background: "var(--err-bg)", border: "1px solid var(--err-border)", color: "var(--err-fg)", padding: "12px 14px", borderRadius: 6, marginTop: 8, fontSize: 13 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Lemon Squeezy doesn't allow API product creation — finish these in their dashboard, then re-run:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.5 }}>
                {todo.map(t => (
                  <li key={t.tier}>
                    <strong style={{ textTransform: "capitalize" }}>{t.tier}</strong>: {t.missing.join("; ")}
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                Make sure to mark products and variants as <strong>Published</strong> (not Draft).
              </div>
            </div>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => setResult(null)}>Run again</button>
        </div>
      </div>
    )
  }

  return (
    <div className="autosetup-card">
      <div className="autosetup-head">
        <div className="autosetup-title">Auto-setup with API key</div>
        <div className="autosetup-sub">
          Paste your Lemon Squeezy API key — we'll detect your store, map Personal/Pro/Studio products to tiers, and register the webhook.
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          type="password"
          placeholder="Your Lemon Squeezy API key (Settings → API)"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
        />
        {error && (
          <div className="msg err">
            {error}
            {storesAvailable && storesAvailable.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                Found stores: {storesAvailable.join(", ")}
              </div>
            )}
          </div>
        )}
        <div>
          <button className="primary" disabled={busy || !apiKey.trim()} onClick={run}>
            {busy ? "Connecting…" : "Run auto-setup"}
          </button>
        </div>
      </div>
    </div>
  )
}

type PaymentConfigForm = {
  mode: "test" | "live"
  store_id: string
  store_url: string
  api_key: string
  webhook_secret: string
  live_webhook_secret: string
  api_key_set: boolean
  webhook_secret_set: boolean
  live_webhook_secret_set: boolean
  tier_personal_monthly: string
  tier_personal_yearly: string
  tier_pro_monthly: string
  tier_pro_yearly: string
  tier_studio_monthly: string
  tier_studio_yearly: string
  live_tier_personal_monthly: string
  live_tier_personal_yearly: string
  live_tier_pro_monthly: string
  live_tier_pro_yearly: string
  live_tier_studio_monthly: string
  live_tier_studio_yearly: string
}

type AdminSubscription = {
  id: number
  username: string
  email: string
  tier: string
  subscription_status: string | null
  subscription_renews_at: string | null
  ls_subscription_id: string | null
  ls_customer_id: string | null
}

type LsEventRow = {
  id: number
  event_name: string
  signature_valid: boolean
  user_id: number | null
  ls_subscription_id: string | null
  error: string | null
  received_at: string
}

const AdminPayments: React.FC = () => {
  const [tab, setTab] = useState<"connection" | "plans" | "subscriptions" | "events">("connection")
  const [cfg, setCfg] = useState<PaymentConfigForm | null>(null)
  const [subs, setSubs] = useState<AdminSubscription[]>([])
  const [events, setEvents] = useState<LsEventRow[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const loadCfg = async () => {
    const data = await api.adminGetPaymentConfig()
    if (!data.error) {
      setCfg({
        mode: data.mode === "live" ? "live" : "test",
        store_id: data.store_id ?? "",
        store_url: data.store_url ?? "",
        api_key: "",
        webhook_secret: "",
        live_webhook_secret: "",
        api_key_set: !!data.api_key_set,
        webhook_secret_set: !!data.webhook_secret_set,
        live_webhook_secret_set: !!data.live_webhook_secret_set,
        tier_personal_monthly: data.tier_personal_monthly ?? "",
        tier_personal_yearly: data.tier_personal_yearly ?? "",
        tier_pro_monthly: data.tier_pro_monthly ?? "",
        tier_pro_yearly: data.tier_pro_yearly ?? "",
        tier_studio_monthly: data.tier_studio_monthly ?? "",
        tier_studio_yearly: data.tier_studio_yearly ?? "",
        live_tier_personal_monthly: data.live_tier_personal_monthly ?? "",
        live_tier_personal_yearly: data.live_tier_personal_yearly ?? "",
        live_tier_pro_monthly: data.live_tier_pro_monthly ?? "",
        live_tier_pro_yearly: data.live_tier_pro_yearly ?? "",
        live_tier_studio_monthly: data.live_tier_studio_monthly ?? "",
        live_tier_studio_yearly: data.live_tier_studio_yearly ?? "",
      })
    }
  }

  const setMode = async (mode: "test" | "live") => {
    if (!cfg || cfg.mode === mode) return
    setCfg({ ...cfg, mode })
    await api.adminSavePaymentConfig({ mode })
  }
  const loadSubs = async () => {
    const data = await api.adminListSubscriptions()
    setSubs(Array.isArray(data) ? data : [])
  }
  const loadEvents = async () => {
    const data = await api.adminListPaymentEvents()
    setEvents(Array.isArray(data) ? data : [])
  }

  useEffect(() => {
    if (tab === "connection" || tab === "plans") loadCfg()
    if (tab === "subscriptions") loadSubs()
    if (tab === "events") loadEvents()
  }, [tab])

  const save = async (patch: Partial<PaymentConfigForm>) => {
    if (!cfg) return
    setSaving(true); setMsg(null)
    const body: Record<string, unknown> = { ...patch }
    if (patch.api_key === "" || patch.api_key?.includes("…")) delete body.api_key
    if (patch.webhook_secret === "" || patch.webhook_secret?.includes("…")) delete body.webhook_secret
    const res = await api.adminSavePaymentConfig(body)
    setSaving(false)
    if (res.error) return setMsg({ kind: "err", text: res.error })
    setMsg({ kind: "ok", text: "Saved" })
    await loadCfg()
  }

  const setTier = async (id: number, tier: "free" | "personal" | "pro" | "studio") => {
    if (!confirm(`Set tier to ${tier}?`)) return
    const res = await api.adminSetUserTier(id, tier)
    if (res.error) return alert(res.error)
    await loadSubs()
  }

  const webhookUrl = `${window.location.origin}/api/lemonsqueezy/webhook`

  return (
    <section className="settings-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <h3 style={{ marginBottom: 0 }}>Payments <span className="admin-count">Lemon Squeezy</span></h3>
        {cfg && (
          <div className="mode-toggle" role="tablist" aria-label="Mode">
            <button
              className={cfg.mode === "test" ? "active" : ""}
              onClick={() => setMode("test")}
              role="tab"
              aria-selected={cfg.mode === "test"}
            >Test</button>
            <button
              className={cfg.mode === "live" ? "active" : ""}
              onClick={() => setMode("live")}
              role="tab"
              aria-selected={cfg.mode === "live"}
            >Live</button>
          </div>
        )}
      </div>
      <div className="admin-tabs">
        <button className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}>Connection</button>
        <button className={tab === "plans" ? "active" : ""} onClick={() => setTab("plans")}>Plans</button>
        <button className={tab === "subscriptions" ? "active" : ""} onClick={() => setTab("subscriptions")}>Subscriptions</button>
        <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>Events</button>
      </div>

      {msg && <div className={`msg ${msg.kind}`} style={{ marginTop: 12 }}>{msg.text}</div>}

      {tab === "connection" && cfg && (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Configuring <strong style={{ color: "var(--text)" }}>{cfg.mode}</strong> mode. Switch the toggle above to configure the other.
          </div>
          <AutoSetupCard webhookUrl={webhookUrl} mode={cfg.mode} onSetup={loadCfg} />
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, fontSize: 13, color: "var(--muted)" }}>
            Or configure manually:
          </div>
          <div>
            <label>Webhook URL (paste into Lemon Squeezy)</label>
            <div className="share-link">{webhookUrl}</div>
            <button onClick={() => navigator.clipboard.writeText(webhookUrl)} style={{ marginTop: 6 }}>Copy</button>
          </div>
          <div>
            <label>Store URL <span style={{ color: "var(--muted)", fontWeight: 400 }}>(shared between modes)</span></label>
            <input value={cfg.store_url} onChange={e => setCfg({ ...cfg, store_url: e.target.value })} placeholder="https://your-store.lemonsqueezy.com" />
          </div>
          <div>
            <label>Store ID <span style={{ color: "var(--muted)", fontWeight: 400 }}>(shared between modes)</span></label>
            <input value={cfg.store_id} onChange={e => setCfg({ ...cfg, store_id: e.target.value })} placeholder="e.g. 12345" />
          </div>
          <div>
            <label>API Key <span style={{ color: "var(--muted)", fontWeight: 400 }}>(shared){cfg.api_key_set && " — set, leave blank to keep current"}</span></label>
            <input type="password" value={cfg.api_key} onChange={e => setCfg({ ...cfg, api_key: e.target.value })} placeholder={cfg.api_key_set ? "•••• (unchanged)" : "Your Lemon Squeezy API key"} />
          </div>
          <div>
            <label>
              Webhook Secret ({cfg.mode})
              {(cfg.mode === "test" ? cfg.webhook_secret_set : cfg.live_webhook_secret_set) && <span style={{ color: "var(--muted)", fontWeight: 400 }}> — set, leave blank to keep current</span>}
            </label>
            {cfg.mode === "test" ? (
              <input type="password" value={cfg.webhook_secret} onChange={e => setCfg({ ...cfg, webhook_secret: e.target.value })} placeholder={cfg.webhook_secret_set ? "•••• (unchanged)" : "test webhook signing secret"} />
            ) : (
              <input type="password" value={cfg.live_webhook_secret} onChange={e => setCfg({ ...cfg, live_webhook_secret: e.target.value })} placeholder={cfg.live_webhook_secret_set ? "•••• (unchanged)" : "live webhook signing secret"} />
            )}
          </div>
          <div className="settings-actions">
            <button className="primary" disabled={saving} onClick={() => save({
              store_url: cfg.store_url,
              store_id: cfg.store_id,
              api_key: cfg.api_key,
              webhook_secret: cfg.mode === "test" ? cfg.webhook_secret : undefined,
              live_webhook_secret: cfg.mode === "live" ? cfg.live_webhook_secret : undefined,
            })}>{saving ? "Saving…" : "Save connection"}</button>
          </div>
        </div>
      )}

      {tab === "plans" && cfg && (() => {
        const prefix = cfg.mode === "live" ? "live_tier" : "tier"
        const fieldKey = (tier: string, period: "monthly" | "yearly") => `${prefix}_${tier}_${period}` as keyof PaymentConfigForm
        const valueOf = (tier: string, period: "monthly" | "yearly") => (cfg as any)[fieldKey(tier, period)] ?? ""
        return (
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>
              <strong style={{ color: "var(--text)", textTransform: "capitalize" }}>{cfg.mode}</strong> mode plans. Switch the toggle above to edit the other set.
            </div>
            {(["personal", "pro", "studio"] as const).map(tier => {
              const monthlyId = valueOf(tier, "monthly")
              const yearlyId = valueOf(tier, "yearly")
              const details = TIER_DETAILS[tier]
              return (
                <div key={tier} className="plan-card">
                  <div className="plan-head">
                    <div>
                      <div className="plan-name">{details.label}</div>
                      <div className="plan-storage">{details.storage}</div>
                    </div>
                  </div>
                  <div className="plan-periods">
                    {(["monthly", "yearly"] as const).map(period => {
                      const id = period === "monthly" ? monthlyId : yearlyId
                      const display = period === "monthly" ? `${details.monthly}/mo` : `${details.yearly}/yr`
                      return (
                        <div key={period} className={`plan-period ${id ? "ok" : "missing"}`}>
                          <div className="plan-period-head">
                            <span className="plan-period-label">{period}</span>
                            <span className={`plan-period-status ${id ? "ok" : "missing"}`}>
                              {id ? "✓ Linked" : "Not linked"}
                            </span>
                          </div>
                          <div className="plan-price">{display}</div>
                          <input
                            value={id}
                            onChange={e => setCfg({ ...cfg, [fieldKey(tier, period)]: e.target.value } as any)}
                            placeholder="LS variant ID"
                            spellCheck={false}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            <div className="settings-actions">
              <button className="primary" disabled={saving} onClick={() => {
                const patch: Record<string, unknown> = {}
                for (const t of ["personal", "pro", "studio"] as const) {
                  patch[fieldKey(t, "monthly")] = valueOf(t, "monthly")
                  patch[fieldKey(t, "yearly")] = valueOf(t, "yearly")
                }
                save(patch as Partial<PaymentConfigForm>)
              }}>{saving ? "Saving…" : "Save plans"}</button>
            </div>
          </div>
        )
      })()}

      {tab === "subscriptions" && (
        <div style={{ marginTop: 16 }}>
          {subs.length === 0 && <div style={{ color: "var(--muted)", fontSize: 14 }}>No active subscriptions yet.</div>}
          <div className="admin-list">
            {subs.map(s => (
              <div key={s.id} className="admin-row">
                <div className="admin-row-main">
                  <div className="admin-row-line">
                    <strong>@{s.username}</strong>
                    <span className="admin-row-name">{s.email}</span>
                    <span className="admin-pill admin-pill-owner">{s.tier}</span>
                    {s.subscription_status && <span className="admin-pill">{s.subscription_status}</span>}
                    {s.subscription_renews_at && <span className="admin-row-when">renews {new Date(s.subscription_renews_at).toLocaleDateString()}</span>}
                  </div>
                </div>
                <div className="admin-row-actions">
                  <select value={s.tier} onChange={e => setTier(s.id, e.target.value as any)} style={{ padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--panel)", color: "var(--text)", fontSize: 12 }}>
                    <option value="free">free</option>
                    <option value="personal">personal</option>
                    <option value="pro">pro</option>
                    <option value="studio">studio</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "events" && (
        <div style={{ marginTop: 16 }}>
          {events.length === 0 && <div style={{ color: "var(--muted)", fontSize: 14 }}>No webhook events yet.</div>}
          <div className="admin-list">
            {events.map(e => (
              <div key={e.id} className="admin-row">
                <div className="admin-row-main">
                  <div className="admin-row-line">
                    <strong>{e.event_name}</strong>
                    <span className={`admin-pill ${e.signature_valid ? "admin-pill-used" : ""}`} style={{ background: e.signature_valid ? undefined : "var(--err-bg)", color: e.signature_valid ? undefined : "var(--err-fg)", borderColor: e.signature_valid ? undefined : "var(--err-border)" }}>
                      {e.signature_valid ? "verified" : "bad signature"}
                    </span>
                    {e.user_id && <span className="admin-row-name">user #{e.user_id}</span>}
                    {e.ls_subscription_id && <span className="admin-row-name">sub {e.ls_subscription_id}</span>}
                    <span className="admin-row-when">{new Date(e.received_at).toLocaleString()}</span>
                  </div>
                  {e.error && <div className="admin-row-reason" style={{ color: "var(--danger)" }}>{e.error}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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

type AuditEvent = {
  id: number
  user_id: number | null
  event: string
  metadata: string | null
  ip: string | null
  user_agent: string | null
  created_at: string
  username?: string | null
  user_email?: string | null
}

const AdminAudit: React.FC = () => {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [eventFilter, setEventFilter] = useState("")
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const data = await api.adminListAuditEvents({ event: eventFilter || undefined, limit: 200 })
    setEvents(Array.isArray(data) ? data : [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const tone = (event: string): string => {
    if (event.includes("fail") || event.includes("rate_limited") || event.includes("locked") || event.includes("disabled")) return "warn"
    if (event.startsWith("login.ok") || event.includes("enabled") || event.endsWith(".created") || event === "signup.ok") return "ok"
    return "info"
  }

  const presets = ["", "login.ok", "login.fail", "login.rate_limited", "login.mfa_required", "mfa.enabled", "mfa.disabled", "signup.ok"]

  return (
    <section className="settings-card">
      <h3>Audit log</h3>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
        Most recent 200 security-relevant events.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <select value={eventFilter} onChange={e => setEventFilter(e.target.value)} style={{ minWidth: 220 }}>
          {presets.map(p => <option key={p} value={p}>{p === "" ? "All events" : p}</option>)}
        </select>
        <input
          placeholder="Or type a custom event…"
          value={eventFilter}
          onChange={e => setEventFilter(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <button onClick={load}>Refresh</button>
      </div>
      {loading && <div style={{ color: "var(--muted)" }}>Loading…</div>}
      {!loading && events.length === 0 && <div style={{ color: "var(--muted)" }}>No events</div>}
      {!loading && events.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {events.map(ev => (
            <div key={ev.id} className={`audit-row audit-${tone(ev.event)}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <code style={{ fontSize: 12, fontWeight: 600 }}>{ev.event}</code>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  {new Date(ev.created_at).toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {ev.username && <span>@{ev.username}</span>}
                {!ev.username && ev.user_email && <span>{ev.user_email}</span>}
                {!ev.username && !ev.user_email && ev.user_id === null && <span>anonymous</span>}
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
    api.adminGetStats().then(setS).catch(() => setS(null))
  }, [])

  if (!s) return <section className="settings-card"><h3>Stats</h3><div style={{ color: "var(--muted)", fontSize: 14 }}>Loading…</div></section>

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

const InviteRequestForm: React.FC = () => {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [reason, setReason] = useState("")
  const [status, setStatus] = useState<"idle" | "submitting" | "success">("idle")
  const [error, setError] = useState("")

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (status === "submitting") return
    if (!email.trim()) { setError("Email is required"); return }

    setStatus("submitting")
    setError("")
    try {
      const res = await api.requestInvite({
        email: email.trim(),
        name: name.trim() || undefined,
        reason: reason.trim() || undefined,
      })
      if (!res.ok) {
        setError(res.error ?? "Something went wrong. Try again?")
        setStatus("idle")
        return
      }
      setStatus("success")
    } catch {
      setError("Network error. Try again?")
      setStatus("idle")
    }
  }

  if (status === "success") {
    return (
      <div className="lp-invite-card lp-invite-success">
        <div className="lp-invite-check" aria-hidden="true">✓</div>
        <h3>You're on the list</h3>
        <p>We'll email <strong>{email}</strong> when there's space. No spam, ever.</p>
      </div>
    )
  }

  return (
    <form className="lp-invite-card" onSubmit={submit}>
      <div className="lp-invite-head">
        <h3>Request an invite</h3>
        <p>We'll email you when there's space.</p>
      </div>

      <label className="lp-field">
        <span>Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
      </label>

      <label className="lp-field">
        <span>Name <span className="lp-field-opt">(optional)</span></span>
        <input
          type="text"
          autoComplete="name"
          placeholder="What should we call you?"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </label>

      <label className="lp-field">
        <span>Why? <span className="lp-field-opt">(optional)</span></span>
        <textarea
          rows={3}
          placeholder="What are you hoping to use stohr for?"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
      </label>

      {error && <div className="lp-invite-error" role="alert">{error}</div>}

      <button
        type="submit"
        className="lp-btn lp-btn-primary lp-btn-block lp-btn-lg"
        disabled={status === "submitting"}
      >
        {status === "submitting" ? "Sending…" : "Request invite"}
      </button>
    </form>
  )
}

const HeroMock: React.FC = () => (
  <div className="lp-mock lp-mock-hero" aria-hidden="true">
    <div className="lp-mock-chrome">
      <span className="lp-mock-dot" /><span className="lp-mock-dot" /><span className="lp-mock-dot" />
      <div className="lp-mock-url">stohr.io / app</div>
    </div>
    <div className="lp-mock-shell">
      <aside className="lp-mock-sidebar">
        <div className="lp-mock-brand">stohr</div>
        <ul>
          <li className="active"><FolderOpen size={14} strokeWidth={1.75} /> My Files</li>
          <li><Users size={14} strokeWidth={1.75} /> Shared</li>
          <li><Link2 size={14} strokeWidth={1.75} /> Public links</li>
          <li><Trash2 size={14} strokeWidth={1.75} /> Trash</li>
          <li><SettingsIcon size={14} strokeWidth={1.75} /> Settings</li>
        </ul>
      </aside>
      <div className="lp-mock-main">
        <div className="lp-mock-toolbar">
          <span>My Files</span>
          <span className="lp-mock-sep">/</span>
          <span>Photos</span>
          <span className="lp-mock-sep">/</span>
          <strong>Trips</strong>
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
      Public link copied <code>stohr.io/p/wess/photos</code>
    </div>
  </div>
)

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

const TerminalMock: React.FC = () => (
  <div className="lp-mock lp-mock-card lp-mock-term" aria-hidden="true">
    <div className="lp-mock-term-head">
      <span className="lp-mock-dot lp-mock-dot-r" />
      <span className="lp-mock-dot lp-mock-dot-y" />
      <span className="lp-mock-dot lp-mock-dot-g" />
      <span className="lp-mock-term-title">~/stohr</span>
    </div>
    <div className="lp-mock-term-body">
      <div><span className="lp-mock-prompt">$</span> cp .env.example .env</div>
      <div><span className="lp-mock-prompt">$</span> bun install</div>
      <div><span className="lp-mock-prompt">$</span> bun run dev</div>
      <div className="lp-mock-term-ok">▸ api on http://localhost:3000</div>
      <div className="lp-mock-term-ok">▸ web on http://localhost:3001</div>
      <div className="lp-mock-term-cursor"><span className="lp-mock-prompt">$</span> <span className="lp-mock-caret">▍</span></div>
    </div>
  </div>
)

type Feature = {
  num: string
  eyebrow: string
  title: React.ReactNode
  body: React.ReactNode
  visual: React.ReactNode
}

const FEATURES: Feature[] = [
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
    eyebrow: "Self-host",
    title: <>Self-host <em>or</em> hosted.</>,
    body: <>Same code on both sides. Run it yourself on a $6 droplet with one command, or let us host it. Migrate either way whenever you want — your files are S3-compatible.</>,
    visual: <TerminalMock />,
  },
]

const LandingPage: React.FC = () => {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      const a = t.closest("a")
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
    <div className="lp">
      <div className="lp-banner" role="status">
        <span className="lp-banner-pulse" aria-hidden="true" />
        Currently in <em>beta</em> — invite only
      </div>
      <header className="lp-nav">
        <a href="/" className="lp-brand"><Logo /></a>
        <nav className="lp-nav-links">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#beta">Beta</a>
          <a href="https://github.com/wess/stohr" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <div className="lp-nav-cta">
          <a href="/login" className="lp-link">Sign in</a>
          <a href="#beta" className="lp-btn lp-btn-primary">Get an invite</a>
        </div>
      </header>

      <section className="lp-hero">
        <div className="lp-hero-text">
          <p className="lp-eyebrow">Self-hostable cloud storage</p>
          <h1>
            Your files.<br />
            <em>Your storage.</em><br />
            Your rules.
          </h1>
          <p className="lp-lede">
            Photo galleries, scriptable folders, public sharing — without the
            surveillance, the upsells, or the dark patterns. Run it on a $6
            droplet, or pay us to.
          </p>
          <div className="lp-cta-row">
            <a href="#beta" className="lp-btn lp-btn-primary lp-btn-lg">Get on the beta list</a>
            <a href="#features" className="lp-btn lp-btn-ghost lp-btn-lg">See what's inside <ChevronRight size={16} strokeWidth={2} /></a>
          </div>
        </div>
        <div className="lp-hero-vis">
          <HeroMock />
        </div>
      </section>

      <section className="lp-trust" aria-label="Open source and stack">
        <a href="https://github.com/wess/stohr" target="_blank" rel="noreferrer" className="lp-trust-item lp-trust-link">
          <Github size={16} strokeWidth={1.75} /> github.com/wess/stohr
        </a>
        <span className="lp-trust-item">MIT licensed</span>
        <span className="lp-trust-item">$6/mo droplet</span>
        <span className="lp-trust-item">S3-compatible</span>
        <span className="lp-trust-item">Bun · React · Postgres</span>
      </section>

      <section className="lp-features" id="features">
        <header className="lp-section-head">
          <p className="lp-eyebrow">Features</p>
          <h2>Built for the way <em>you</em> store.</h2>
          <p className="lp-section-lede">Five things that make Stohr feel different the moment you start using it.</p>
        </header>

        <div className="lp-feature-rows">
          {FEATURES.map((f, i) => (
            <article key={f.num} className={`lp-feature-row${i % 2 === 1 ? " lp-feature-row-rev" : ""}`}>
              <div className="lp-feature-text">
                <div className="lp-feature-tag">
                  <span className="lp-num">{f.num}</span>
                  <span className="lp-feature-eyebrow">{f.eyebrow}</span>
                </div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
              <div className="lp-feature-vis">
                {f.visual}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-beta" id="beta">
        <div className="lp-beta-text">
          <p className="lp-eyebrow">Beta · invite only</p>
          <h2>Get on the <em>list</em>.</h2>
          <p className="lp-section-lede">
            We're rolling access out in waves so we can support every account
            properly. No spam, no marketing emails — we'll write once when
            there's space.
          </p>
          <ul className="lp-beta-points">
            <li><Check size={14} strokeWidth={2.5} /> Free tier on day one</li>
            <li><Check size={14} strokeWidth={2.5} /> Migrate out anytime — files are S3-compatible</li>
            <li><Check size={14} strokeWidth={2.5} /> Self-host stays open source forever</li>
          </ul>
        </div>
        <div className="lp-beta-form">
          <InviteRequestForm />
        </div>
      </section>

      <section className="lp-pricing" id="pricing">
        <header className="lp-section-head">
          <p className="lp-eyebrow">Pricing</p>
          <h2>Pay for storage. <em>Not features.</em></h2>
          <p className="lp-section-lede">Every plan includes everything you saw above. The only thing that changes between tiers is how much room you get.</p>
        </header>

        <div className="lp-tiers">
          <article className="lp-tier">
            <header className="lp-tier-head">Free</header>
            <div className="lp-price"><span className="lp-amount">$0</span></div>
            <div className="lp-storage">5 GB</div>
            <a href="#beta" className="lp-btn lp-btn-ghost lp-btn-block">Start free</a>
            <ul>
              <li>Photo galleries</li>
              <li>Action folders</li>
              <li>Public sharing</li>
            </ul>
          </article>

          <article className="lp-tier">
            <header className="lp-tier-head">Personal</header>
            <div className="lp-price"><span className="lp-amount">$6</span><span className="lp-period">/mo</span></div>
            <div className="lp-storage">50 GB</div>
            <a href="#beta" className="lp-btn lp-btn-primary lp-btn-block">Choose Personal</a>
            <ul>
              <li>Everything in Free</li>
              <li>Unlimited collaborators</li>
              <li>Version history</li>
            </ul>
          </article>

          <article className="lp-tier lp-tier-pop">
            <header className="lp-tier-head">Pro <span className="lp-pop">popular</span></header>
            <div className="lp-price"><span className="lp-amount">$14</span><span className="lp-period">/mo</span></div>
            <div className="lp-storage">250 GB</div>
            <a href="#beta" className="lp-btn lp-btn-primary lp-btn-block">Choose Pro</a>
            <ul>
              <li>Everything in Personal</li>
              <li>Custom domains <em>(soon)</em></li>
              <li>Priority support</li>
            </ul>
          </article>

          <article className="lp-tier">
            <header className="lp-tier-head">Studio</header>
            <div className="lp-price"><span className="lp-amount">$34</span><span className="lp-period">/mo</span></div>
            <div className="lp-storage">1 TB</div>
            <a href="#beta" className="lp-btn lp-btn-primary lp-btn-block">Choose Studio</a>
            <ul>
              <li>Everything in Pro</li>
              <li>API access</li>
              <li>Direct line for issues</li>
            </ul>
          </article>
        </div>

        <p className="lp-pricing-foot">
          Yearly: $60 / $140 / $340 — saves two months. Cancel anytime. <strong>Self-host stays free, forever.</strong>
        </p>
      </section>

      <footer className="lp-footer">
        <div className="lp-footer-brand">
          <Logo />
          <span>Self-hostable cloud storage.</span>
        </div>
        <div className="lp-footer-cols">
          <div>
            <h4>Product</h4>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#beta">Beta access</a>
          </div>
          <div>
            <h4>Open source</h4>
            <a href="https://github.com/wess/stohr" target="_blank" rel="noreferrer">GitHub</a>
            <a href="https://github.com/wess/stohr/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT license</a>
            <a href="https://github.com/wess/stohr/tree/main/docs" target="_blank" rel="noreferrer">Docs</a>
          </div>
          <div>
            <h4>Account</h4>
            <a href="/login">Sign in</a>
            <a href="#beta">Request invite</a>
          </div>
        </div>
        <div className="lp-footer-foot">stohr · 2026 · Built with Bun.</div>
      </footer>
    </div>
  )
}

const App: React.FC = () => {
  const [loggedIn, setLoggedIn] = useState(!!api.getToken())
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location))
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    if (loggedIn) { setNeedsSetup(false); return }
    api.getSetupStatus().then(s => setNeedsSetup(!!s?.needsSetup)).catch(() => setNeedsSetup(false))
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
  if (route.kind === "oauthAuthorize") {
    if (!loggedIn) {
      return <Auth onLogin={() => setLoggedIn(true)} initialInvite={null} needsSetup={false} initialMode="login" oauthNext={`/oauth/authorize${route.query}`} />
    }
    return <OAuthConsent query={route.query} />
  }
  if (route.kind === "pair") {
    if (!loggedIn) {
      return <Auth onLogin={() => setLoggedIn(true)} initialInvite={null} needsSetup={false} initialMode="login" oauthNext={`/pair${route.query}`} />
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
    return <Auth onLogin={() => setLoggedIn(true)} initialInvite={initialInvite} needsSetup={false} initialMode="signup" />
  }
  if (path === "/login") {
    return <Auth onLogin={() => setLoggedIn(true)} initialInvite={null} needsSetup={false} initialMode="login" />
  }
  return <LandingPage />
}

createRoot(document.getElementById("app")!).render(<App />)
