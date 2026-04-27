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
  Search,
  Settings as SettingsIcon,
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

type Route =
  | { kind: "root" }
  | { kind: "folder"; id: number; ownerUsername?: string }
  | { kind: "file"; id: number; ownerUsername?: string }
  | { kind: "shared" }
  | { kind: "links" }
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "share"; token: string }
  | { kind: "publicFolder"; username: string; folderId: number }

const parseRoute = (loc: { pathname: string; search: string }): Route => {
  const path = loc.pathname
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
type Share = { id: number; token: string; expires_at: string | null; created_at: string; name: string; size: number; mime: string; file_id: number }
type TrashedFolder = Folder & { deleted_at: string }
type TrashedFile = FileItem & { deleted_at: string }
type FileVersion = { version: number; mime: string; size: number; uploaded_by: number | null; uploaded_at: string; is_current: boolean }

const formatBytes = (b: number) => {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
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

const Auth: React.FC<{ onLogin: () => void; initialInvite?: string | null; needsSetup: boolean }> = ({ onLogin, initialInvite, needsSetup }) => {
  const [mode, setMode] = useState<"login" | "signup">(needsSetup || initialInvite ? "signup" : "login")
  const [name, setName] = useState("")
  const [username, setUsername] = useState("")
  const [identity, setIdentity] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [inviteToken, setInviteToken] = useState(initialInvite ?? "")
  const [inviteEmailLock, setInviteEmailLock] = useState<string | null>(null)
  const [error, setError] = useState("")

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
    const res = mode === "signup"
      ? await api.signup({ name, username, email, password, inviteToken: needsSetup ? undefined : inviteToken })
      : await api.login(identity, password)
    if (res.error) return setError(res.error)
    if (!res.token) return setError("Authentication failed")
    if (window.location.pathname === "/signup") {
      history.replaceState(null, "", "/")
    }
    onLogin()
  }

  const heading = needsSetup
    ? "Set up your Stohr"
    : mode === "login" ? "Sign in to your cloud storage" : "Create your account"

  return (
    <div className="auth">
      <h1>Stohr</h1>
      <h2>{heading}</h2>
      {needsSetup && (
        <div style={{ background: "var(--accent-bg)", color: "var(--brand)", border: "1px solid var(--brand)", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          No accounts yet. The first user becomes the owner and can invite others.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {mode === "signup" ? (
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
      <button className="primary" onClick={submit}>
        {needsSetup ? "Create owner account" : mode === "login" ? "Sign in" : "Create account"}
      </button>
      {!needsSetup && (
        <div className="toggle" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Have an invite? Create your account" : "Already have an account? Sign in"}
        </div>
      )}
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
    if (!list || (list as FileList).length === 0) return
    const res = await api.uploadFiles(list, currentId)
    if (Array.isArray(res)) await load()
    else if (res.error) alert(res.error)
  }

  const onDrop: React.DragEventHandler = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files)
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
        <button className="primary" onClick={() => fileInput.current?.click()}>
          <UploadIcon size={14} /> <span>Upload</span>
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={e => e.target.files && upload(e.target.files)} />
      </div>

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
                <div className="icon"><FolderIcon size={32} strokeWidth={1.5} /></div>
                <div className="name">{f.name}</div>
                <div className="meta">Folder</div>
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
          {currentKind !== "photos" && files.map(f => {
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

        {currentKind === "photos" && (
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
  const [publicLink, setPublicLink] = useState<{ url: string } | null>(null)
  const [publicExpiry, setPublicExpiry] = useState("")

  const createPublic = async () => {
    if (target.kind !== "file") return
    const secs = publicExpiry ? Number(publicExpiry) * 3600 : undefined
    const res = await api.createShare(target.id, secs)
    if (res.token) setPublicLink({ url: `${window.location.origin}/s/${res.token}` })
    else alert(res.error ?? "Failed to share")
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
              <div>Anyone with this link can download:</div>
              <div className="share-link">{publicLink.url}</div>
              <div className="actions">
                <button onClick={() => navigator.clipboard.writeText(publicLink.url)}>Copy</button>
                <button className="primary" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 8, color: "var(--muted)" }}>Expires in (hours, blank = never)</div>
              <input type="number" min="0" placeholder="e.g. 24" value={publicExpiry} onChange={e => setPublicExpiry(e.target.value)} />
              <div className="actions">
                <button onClick={onClose}>Cancel</button>
                <button className="primary" onClick={createPublic}>Create link</button>
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
                  <td><span className="inline-icon"><MimeIcon mime={s.mime} size={16} /></span> {s.name}</td>
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

const AuthedImage: React.FC<{ src: string; alt: string; useAuth: boolean; className?: string }> = ({ src, alt, useAuth, className }) => {
  const [resolved, setResolved] = useState<string | null>(useAuth ? null : src)
  useEffect(() => {
    if (!useAuth) { setResolved(src); return }
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
  }, [src, useAuth])
  if (!resolved) return <div className={`thumb-skeleton ${className ?? ""}`} />
  return <img src={resolved} alt={alt} loading="lazy" className={className} />
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
        <div className="public-brand" onClick={() => window.location.assign("/")}>Stohr</div>
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

const SharePage: React.FC<{ token: string }> = ({ token }) => {
  const [meta, setMeta] = useState<{ name: string; size: number; mime: string; error?: string } | null>(null)

  useEffect(() => {
    api.shareMeta(token).then(setMeta)
  }, [token])

  if (!meta) return <div className="share-page">Loading…</div>
  if (meta.error) {
    return (
      <div className="share-page">
        <div className="file-icon"><AlertTriangle size={64} strokeWidth={1.5} /></div>
        <div className="filename">{meta.error}</div>
      </div>
    )
  }

  const kind = kindFor(meta.mime)
  const inlineUrl = api.shareInlineUrl(token)
  const downloadUrl = api.shareDownloadUrl(token)

  return (
    <div className="public-folder">
      <header className="public-header">
        <div className="public-brand" onClick={() => window.location.assign("/")}>Stohr</div>
        <div className="public-meta">
          <div className="public-title">{meta.name}</div>
          <div className="public-owner">{formatBytes(meta.size)} • {meta.mime}</div>
        </div>
        <a href={downloadUrl} download={meta.name}>
          <button className="primary"><Download size={14} /> <span>Download</span></button>
        </a>
      </header>
      <div className="public-content share-viewer">
        {kind === "image" && <img className="share-media" src={inlineUrl} alt={meta.name} />}
        {kind === "video" && <video className="share-media" src={inlineUrl} controls />}
        {kind === "audio" && (
          <div className="share-audio">
            <div className="preview-audio-icon"><Music size={72} strokeWidth={1.25} /></div>
            <audio src={inlineUrl} controls />
          </div>
        )}
        {kind === "pdf" && <iframe className="share-pdf" src={inlineUrl} title={meta.name} />}
        {kind === "text" && <ShareText url={inlineUrl} />}
        {kind === "other" && (
          <div className="empty">
            <div className="big"><MimeIcon mime={meta.mime} size={64} /></div>
            <div>No inline preview for this file type</div>
            <a href={downloadUrl} download={meta.name} style={{ marginTop: 16, display: "inline-block" }}>
              <button className="primary">Download {meta.name}</button>
            </a>
          </div>
        )}
      </div>
    </div>
  )
}

const ShareText: React.FC<{ url: string }> = ({ url }) => {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let aborted = false
    fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    }).then(t => { if (!aborted) setText(t) })
      .catch(e => { if (!aborted) setError(e.message) })
    return () => { aborted = true }
  }, [url])
  if (error) return <div className="empty">Could not load: {error}</div>
  if (text === null) return <div className="empty">Loading…</div>
  return <pre className="preview-text">{text}</pre>
}

const Shell: React.FC<{ onLogout: () => void; route: Route }> = ({ onLogout, route }) => {
  const [userSnapshot, setUserSnapshot] = useState(api.getUser())

  const activeTab: "files" | "shared" | "links" | "trash" | "settings" = (() => {
    if (route.kind === "shared") return "shared"
    if (route.kind === "links") return "links"
    if (route.kind === "trash") return "trash"
    if (route.kind === "settings") return "settings"
    return "files"
  })()

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Stohr</div>
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

  const logout = () => {
    api.setToken(null)
    setLoggedIn(false)
    history.replaceState(null, "", "/")
  }

  if (loggedIn) return <Shell onLogout={logout} route={route} />
  if (needsSetup === null) return null
  return <Auth onLogin={() => setLoggedIn(true)} initialInvite={initialInvite} needsSetup={needsSetup} />
}

createRoot(document.getElementById("app")!).render(<App />)
