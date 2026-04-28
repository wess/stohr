import React, { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  AlertTriangle,
  ChevronRight,
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
  Inbox,
  Link2,
  Mail,
  Monitor,
  Moon,
  Music,
  Camera,
  Search,
  Settings as SettingsIcon,
  Smartphone,
  Sun,
  Share2,
  Trash2,
  Upload as UploadIcon,
  UserPlus,
  Users,
  X,
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
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "admin" }
  | { kind: "share"; token: string }
  | { kind: "publicFolder"; username: string; folderId: number }
  | { kind: "oauthAuthorize"; query: string }

const parseRoute = (loc: { pathname: string; search: string }): Route => {
  const path = loc.pathname
  if (path === "/oauth/authorize") return { kind: "oauthAuthorize", query: loc.search }
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

const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={e => e.stopPropagation()}>
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

  return (
    <div className="main">
      <div className="toolbar">
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
          {crumbs.map((c, i) => {
            const ownerSlug = currentOwner && me && currentOwner.id !== me.id ? currentOwner.username : undefined
            return (
              <React.Fragment key={c.id}>
                <span className="sep"><ChevronRight size={14} /></span>
                {i === crumbs.length - 1
                  ? <span className="current">{c.name}</span>
                  : <span className="crumb" onClick={() => navigate(folderHref(c.id, ownerSlug))}>{c.name}</span>}
              </React.Fragment>
            )
          })}
        </div>
        <input className="search" placeholder="Search files..." value={search} onChange={e => setSearch(e.target.value)} />
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
                <div className="icon">
                  {f.kind === "screenshots"
                    ? <Camera size={32} strokeWidth={1.5} />
                    : <FolderIcon size={32} strokeWidth={1.5} />}
                </div>
                <div className="name">{f.name}</div>
                <div className="meta">
                  {f.kind === "photos" ? "Photos" : f.kind === "screenshots" ? "Screenshots" : "Folder"}
                </div>
                <div className="row" onClick={e => e.stopPropagation()}>
                  {currentRole === "owner" && (
                    <button onClick={() => setSharing({ kind: "folder", id: f.id, name: f.name })}>Share</button>
                  )}
                  {canEdit && <button onClick={() => setRenaming({ kind: "folder", id: f.id, name: f.name })}>Rename</button>}
                  {canEdit && <button className="danger" onClick={() => del("folder", f.id)}>Delete</button>}
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
                <FileThumb file={f} />
                <div className="name">{f.name}</div>
                <div className="meta">
                  {formatBytes(f.size)}
                  {f.version > 1 && <span className="badge">v{f.version}</span>}
                </div>
                <div className="row" onClick={e => e.stopPropagation()}>
                  <button onClick={() => downloadFile(f)}>Download</button>
                  {currentRole === "owner" && (
                    <button onClick={() => setSharing({ kind: "file", id: f.id, name: f.name })}>Share</button>
                  )}
                  {f.version > 1 && <button onClick={() => setViewingVersions(f)}>Versions</button>}
                  {canEdit && <button onClick={() => setRenaming({ kind: "file", id: f.id, name: f.name })}>Rename</button>}
                  {canEdit && <button className="danger" onClick={() => del("file", f.id)}>Delete</button>}
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

const FolderSettingsModal: React.FC<{
  folderId: number
  folderName: string
  ownerUsername: string
  initialKind: string
  initialIsPublic: boolean
  onClose: () => void
  onSaved: () => void
}> = ({ folderId, folderName, ownerUsername, initialKind, initialIsPublic, onClose, onSaved }) => {
  const [kind, setKind] = useState(initialKind === "photos" ? "photos" : "standard")
  const [isPublic, setIsPublic] = useState(initialIsPublic)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const publicUrl = `${window.location.origin}/p/${ownerUsername}/${folderId}`
  const dirty = kind !== initialKind || isPublic !== initialIsPublic

  const save = async () => {
    setBusy(true)
    setError("")
    const res = await api.updateFolder(folderId, {
      kind: kind as "standard" | "photos",
      is_public: isPublic,
    })
    setBusy(false)
    if (res.error) return setError(res.error)
    onSaved()
  }

  return (
    <Modal title={`Folder settings — ${folderName}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={kind === "photos"}
            onChange={e => setKind(e.target.checked ? "photos" : "standard")}
            style={{ width: 18, height: 18 }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>Photos folder</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Render this folder as an image gallery with a lightbox.
            </div>
          </div>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={isPublic}
            onChange={e => setIsPublic(e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>Public access</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              Anyone with the link can view (no sign-in required).
            </div>
          </div>
        </label>

        {isPublic && (
          <div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Public link:</div>
            <div className="share-link">{publicUrl}</div>
            <button onClick={() => navigator.clipboard.writeText(publicUrl)} style={{ marginTop: 6 }}>
              Copy link
            </button>
          </div>
        )}

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

const Shell: React.FC<{ onLogout: () => void; route: Route }> = ({ onLogout, route }) => {
  const [userSnapshot, setUserSnapshot] = useState(api.getUser())

  const activeTab: "files" | "shared" | "links" | "trash" | "settings" | "admin" = (() => {
    if (route.kind === "shared") return "shared"
    if (route.kind === "links") return "links"
    if (route.kind === "trash") return "trash"
    if (route.kind === "settings") return "settings"
    if (route.kind === "admin") return "admin"
    return "files"
  })()

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><Logo /></div>
        <div className={`nav${activeTab === "files" ? " active" : ""}`} onClick={() => navigate("/")}>
          <FolderOpen size={18} strokeWidth={1.75} /> <span>My Files</span>
        </div>
        <div className={`nav${activeTab === "shared" ? " active" : ""}`} onClick={() => navigate("/app/shared")}>
          <Users size={18} strokeWidth={1.75} /> <span>Shared with me</span>
        </div>
        <div className={`nav${activeTab === "links" ? " active" : ""}`} onClick={() => navigate("/app/links")}>
          <Link2 size={18} strokeWidth={1.75} /> <span>Public links</span>
        </div>
        <div className={`nav${activeTab === "trash" ? " active" : ""}`} onClick={() => navigate("/app/trash")}>
          <Trash2 size={18} strokeWidth={1.75} /> <span>Trash</span>
        </div>
        <div className={`nav${activeTab === "settings" ? " active" : ""}`} onClick={() => navigate("/app/settings")}>
          <SettingsIcon size={18} strokeWidth={1.75} /> <span>Settings</span>
        </div>
        {userSnapshot?.is_owner && (
          <div className={`nav${activeTab === "admin" ? " active" : ""}`} onClick={() => navigate("/app/admin")}>
            <AlertTriangle size={18} strokeWidth={1.75} /> <span>Admin</span>
          </div>
        )}
        <div className="user-footer">
          <div className="who">{userSnapshot?.name ?? ""}</div>
          <div className="who">@{userSnapshot?.username ?? ""}</div>
          <div className="logout" onClick={onLogout}>Sign out</div>
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
            placeholder="butter://oauth/callback&#10;http://localhost:5173/callback"
            rows={3}
            style={{ width: "100%", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
          />
          <label style={{ marginTop: 10 }}>Scopes</label>
          <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={scopeRead} onChange={e => setScopeRead(e.target.checked)} /> read
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={scopeWrite} onChange={e => setScopeWrite(e.target.checked)} /> write
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={scopeShare} onChange={e => setScopeShare(e.target.checked)} /> share
            </label>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 13 }}>
            <input type="checkbox" checked={isOfficial} onChange={e => setIsOfficial(e.target.checked)} />
            <span>First-party app (skips consent screen)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 13 }}>
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
                  <code>{c.client_id}</code>
                  {c.is_official && <span className="badge" style={{ background: "var(--brand)", color: "white" }}>official</span>}
                  {c.revoked_at && <span className="badge" style={{ background: "var(--muted)" }}>revoked</span>}
                </div>
                {c.description && <div className="dev-row-desc">{c.description}</div>}
                <div className="dev-row-meta">
                  Scopes: {c.allowed_scopes.join(", ")} · Redirects: {c.redirect_uris.length}
                  {c.is_public_client ? " · public (PKCE)" : " · confidential"}
                </div>
              </div>
              {!c.revoked_at && (
                <button className="danger" onClick={() => revoke(c.id)}>Revoke</button>
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

const Settings: React.FC<{ onProfileUpdate: () => void; onAccountDeleted: () => void }> = ({ onProfileUpdate, onAccountDeleted }) => {
  const current = api.getUser()
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

  return (
    <div className="main">
      <div className="toolbar">
        <div className="crumbs"><span className="current">Settings</span></div>
      </div>
      <div className="content">
        <div className="settings">
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

          <SubscriptionPanel />

          <DeveloperPanel />

          <SecurityPanel />

          <InvitesPanel />

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
          <a href="https://github.com/wess/stohr" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <div className="lp-nav-cta">
          <a href="/login" className="lp-link">Sign in</a>
          <a href="/signup" className="lp-btn lp-btn-primary">Get started</a>
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
            Photo galleries, real-time collaboration, public sharing — without
            the surveillance, the upsells, or the dark patterns. Run it on a
            $6 droplet, or pay us to.
          </p>
          <div className="lp-cta-row">
            <a href="/signup" className="lp-btn lp-btn-primary lp-btn-lg">Start free</a>
            <a href="#pricing" className="lp-btn lp-btn-ghost lp-btn-lg">See pricing</a>
          </div>
        </div>
        <div className="lp-hero-form">
          <InviteRequestForm />
        </div>
      </section>

      <section className="lp-features" id="features">
        <h2>Built for the way <em>you</em> store.</h2>
        <ol className="lp-feature-list">
          <li>
            <span className="lp-num">01</span>
            <div>
              <h3>Photo galleries, instantly.</h3>
              <p>Mark any folder as a Photos folder and the view becomes a tight square grid with click-to-lightbox keyboard navigation. Zero plugins, zero config — just toggle a checkbox.</p>
            </div>
          </li>
          <li>
            <span className="lp-num">02</span>
            <div>
              <h3>Real collaboration.</h3>
              <p>Share folders by username or email, with viewer or editor roles. Pending invites resolve automatically when the other person signs up — no copying tokens around.</p>
            </div>
          </li>
          <li>
            <span className="lp-num">03</span>
            <div>
              <h3>Public links without the chrome.</h3>
              <p>Flip on public access and you get a clean <code>/p/you/123</code> URL anyone can browse — no signup wall, no upsells, no email capture before they see your work.</p>
            </div>
          </li>
          <li>
            <span className="lp-num">04</span>
            <div>
              <h3>Self-host or hosted.</h3>
              <p>Same code on both sides. Run it yourself on a $6 droplet with one command, or let us host it. Migrate either way whenever you want — your files are S3-compatible.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className="lp-pricing" id="pricing">
        <div className="lp-pricing-head">
          <h2>Simple pricing.</h2>
          <p>Pay for storage, not for features. Every plan includes everything below.</p>
        </div>

        <div className="lp-tiers">
          <article className="lp-tier">
            <header className="lp-tier-head">Free</header>
            <div className="lp-price"><span className="lp-amount">$0</span></div>
            <div className="lp-storage">5 GB</div>
            <a href="/signup" className="lp-btn lp-btn-ghost lp-btn-block">Start free</a>
            <ul>
              <li>Photo galleries</li>
              <li>Public sharing</li>
              <li>Up to 5 collaborators</li>
            </ul>
          </article>

          <article className="lp-tier">
            <header className="lp-tier-head">Personal</header>
            <div className="lp-price"><span className="lp-amount">$6</span><span className="lp-period">/mo</span></div>
            <div className="lp-storage">50 GB</div>
            <a href="/signup" className="lp-btn lp-btn-primary lp-btn-block">Choose Personal</a>
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
            <a href="/signup" className="lp-btn lp-btn-primary lp-btn-block">Choose Pro</a>
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
            <a href="/signup" className="lp-btn lp-btn-primary lp-btn-block">Choose Studio</a>
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
        <div className="lp-footer-brand">stohr · 2026</div>
        <div className="lp-footer-links">
          <a href="https://github.com/wess/stohr" target="_blank" rel="noreferrer">Open source</a>
          <a href="/login">Sign in</a>
          <a href="#pricing">Pricing</a>
        </div>
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
  if (route.kind === "oauthAuthorize") {
    if (!loggedIn) {
      const next = encodeURIComponent("/oauth/authorize" + route.query)
      return <Auth onLogin={() => setLoggedIn(true)} initialInvite={null} needsSetup={false} initialMode="login" oauthNext={`/oauth/authorize${route.query}`} />
    }
    return <OAuthConsent query={route.query} />
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
