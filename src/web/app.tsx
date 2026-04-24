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
  Monitor,
  Moon,
  Music,
  Search,
  Settings as SettingsIcon,
  Sun,
  Share2,
  Trash2,
  Upload as UploadIcon,
  X,
} from "lucide-react"
import * as api from "./api.ts"
import { applyTheme, getTheme, setTheme as setThemePref, type Theme } from "./theme.ts"

type Folder = { id: number; name: string; parent_id: number | null; created_at: string }
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

const thumbCache = new Map<number, string>()

const ImageThumb: React.FC<{ fileId: number; alt: string }> = ({ fileId, alt }) => {
  const [url, setUrl] = useState<string | null>(thumbCache.get(fileId) ?? null)
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (url || failed) return
    const node = ref.current
    if (!node) return

    const io = new IntersectionObserver(async entries => {
      if (!entries[0]?.isIntersecting) return
      io.disconnect()
      const cached = thumbCache.get(fileId)
      if (cached) { setUrl(cached); return }
      try {
        const res = await fetch(api.downloadUrl(fileId), {
          headers: { authorization: `Bearer ${api.getToken()}` },
        })
        if (!res.ok) throw new Error()
        const blob = await res.blob()
        const obj = URL.createObjectURL(blob)
        thumbCache.set(fileId, obj)
        setUrl(obj)
      } catch {
        setFailed(true)
      }
    }, { rootMargin: "200px" })
    io.observe(node)
    return () => io.disconnect()
  }, [fileId, url, failed])

  return (
    <div className="thumb" ref={ref}>
      {url
        ? <img src={url} alt={alt} loading="lazy" />
        : failed
          ? <div className="thumb-fallback"><FileImage size={32} strokeWidth={1.5} /></div>
          : <div className="thumb-skeleton" />
      }
    </div>
  )
}

const Auth: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")

  const submit = async () => {
    setError("")
    const res = mode === "signup"
      ? await api.signup(name, email, password)
      : await api.login(email, password)
    if (res.error) return setError(res.error)
    if (!res.token) return setError("Authentication failed")
    onLogin()
  }

  return (
    <div className="auth">
      <h1>Stohr</h1>
      <h2>{mode === "login" ? "Sign in to your cloud storage" : "Create your account"}</h2>
      {error && <div className="error">{error}</div>}
      {mode === "signup" && (
        <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
      )}
      <input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password}
        onChange={e => setPassword(e.target.value)}
        onKeyDown={e => e.key === "Enter" && submit()}
      />
      <button className="primary" onClick={submit}>{mode === "login" ? "Sign in" : "Create account"}</button>
      <div className="toggle" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
        {mode === "login" ? "Don't have an account? Sign up" : "Already have an account? Sign in"}
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

const Files: React.FC = () => {
  const [folders, setFolders] = useState<Folder[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const [search, setSearch] = useState("")
  const [dragOver, setDragOver] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [sharing, setSharing] = useState<FileItem | null>(null)
  const [shareResult, setShareResult] = useState<{ url: string } | null>(null)
  const [shareExpiry, setShareExpiry] = useState("")
  const [renaming, setRenaming] = useState<{ kind: "folder" | "file"; id: number; name: string } | null>(null)
  const [previewing, setPreviewing] = useState<FileItem | null>(null)
  const [viewingVersions, setViewingVersions] = useState<FileItem | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastClicked, setLastClicked] = useState<string | null>(null)
  const [movingOpen, setMovingOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = async () => {
    const [fo, fi] = await Promise.all([
      api.listFolders(currentId),
      api.listFiles(currentId, search || undefined),
    ])
    setFolders(Array.isArray(fo) ? fo : [])
    setFiles(Array.isArray(fi) ? fi : [])
    if (currentId == null) setCrumbs([])
    else {
      const data = await api.getFolder(currentId)
      setCrumbs(data.trail ?? [])
    }
  }

  useEffect(() => { load() }, [currentId, search])
  useEffect(() => { setSelected(new Set()); setLastClicked(null) }, [currentId, search])

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

  const share = async () => {
    if (!sharing) return
    const secs = shareExpiry ? Number(shareExpiry) * 3600 : undefined
    const res = await api.createShare(sharing.id, secs)
    if (res.token) {
      setShareResult({ url: `${window.location.origin}/s/${res.token}` })
    } else alert(res.error ?? "Failed to share")
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
        <input className="search" placeholder="Search files..." value={search} onChange={e => setSearch(e.target.value)} />
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
                onClick={(e) => selected.size > 0 ? toggleSelect(key, e) : setCurrentId(f.id)}
              >
                <div className={`check${sel ? " on" : ""}`} onClick={e => toggleSelect(key, e)}>
                  <div className="check-box" />
                </div>
                <div className="icon"><FolderIcon size={32} strokeWidth={1.5} /></div>
                <div className="name">{f.name}</div>
                <div className="meta">Folder</div>
                <div className="row" onClick={e => e.stopPropagation()}>
                  <button onClick={() => setRenaming({ kind: "folder", id: f.id, name: f.name })}>Rename</button>
                  <button className="danger" onClick={() => del("folder", f.id)}>Delete</button>
                </div>
              </div>
            )
          })}
          {files.map(f => {
            const key = `fi-${f.id}`
            const sel = selected.has(key)
            const isImage = f.mime.startsWith("image/")
            return (
              <div
                key={key}
                className={`card${sel ? " selected" : ""}${isImage ? " image-card" : ""}`}
                onClick={(e) => selected.size > 0 ? toggleSelect(key, e) : setPreviewing(f)}
              >
                <div className={`check${sel ? " on" : ""}`} onClick={e => toggleSelect(key, e)}>
                  <div className="check-box" />
                </div>
                {isImage
                  ? <ImageThumb fileId={f.id} alt={f.name} />
                  : <div className="icon"><MimeIcon mime={f.mime} size={32} /></div>
                }
                <div className="name">{f.name}</div>
                <div className="meta">
                  {formatBytes(f.size)}
                  {f.version > 1 && <span className="badge">v{f.version}</span>}
                </div>
                <div className="row" onClick={e => e.stopPropagation()}>
                  <button onClick={() => downloadFile(f)}>Download</button>
                  <button onClick={() => { setSharing(f); setShareResult(null); setShareExpiry("") }}>Share</button>
                  {f.version > 1 && <button onClick={() => setViewingVersions(f)}>Versions</button>}
                  <button onClick={() => setRenaming({ kind: "file", id: f.id, name: f.name })}>Rename</button>
                  <button className="danger" onClick={() => del("file", f.id)}>Delete</button>
                </div>
              </div>
            )
          })}
        </div>
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
        <Modal title={`Share "${sharing.name}"`} onClose={() => { setSharing(null); setShareResult(null) }}>
          {shareResult ? (
            <>
              <div>Your share link:</div>
              <div className="share-link">{shareResult.url}</div>
              <div className="actions">
                <button onClick={() => navigator.clipboard.writeText(shareResult.url)}>Copy</button>
                <button className="primary" onClick={() => { setSharing(null); setShareResult(null) }}>Done</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 8, color: "var(--muted)" }}>Expires in (hours, blank = never)</div>
              <input type="number" min="0" placeholder="e.g. 24" value={shareExpiry} onChange={e => setShareExpiry(e.target.value)} />
              <div className="actions">
                <button onClick={() => setSharing(null)}>Cancel</button>
                <button className="primary" onClick={share}>Create link</button>
              </div>
            </>
          )}
        </Modal>
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

const SharePage: React.FC<{ token: string }> = ({ token }) => {
  const [meta, setMeta] = useState<{ name: string; size: number; mime: string; error?: string } | null>(null)

  useEffect(() => {
    api.shareMeta(token).then(setMeta)
  }, [token])

  if (!meta) return <div className="share-page">Loading...</div>
  if (meta.error) return <div className="share-page"><div className="file-icon"><AlertTriangle size={64} strokeWidth={1.5} /></div><div className="filename">{meta.error}</div></div>

  return (
    <div className="share-page">
      <div style={{ color: "var(--brand)", fontSize: 22, fontWeight: 700 }}>Stohr</div>
      <div className="file-icon"><MimeIcon mime={meta.mime} size={64} /></div>
      <div className="filename">{meta.name}</div>
      <div className="filemeta">{formatBytes(meta.size)} • {meta.mime}</div>
      <a className="dl-btn" href={api.shareDownloadUrl(token)}>
        <button className="primary">Download</button>
      </a>
    </div>
  )
}

const Shell: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const [tab, setTab] = useState<"files" | "shares" | "trash" | "settings">("files")
  const [userSnapshot, setUserSnapshot] = useState(api.getUser())

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Stohr</div>
        <div className={`nav${tab === "files" ? " active" : ""}`} onClick={() => setTab("files")}>
          <FolderOpen size={18} strokeWidth={1.75} /> <span>My Files</span>
        </div>
        <div className={`nav${tab === "shares" ? " active" : ""}`} onClick={() => setTab("shares")}>
          <Link2 size={18} strokeWidth={1.75} /> <span>Shared</span>
        </div>
        <div className={`nav${tab === "trash" ? " active" : ""}`} onClick={() => setTab("trash")}>
          <Trash2 size={18} strokeWidth={1.75} /> <span>Trash</span>
        </div>
        <div className={`nav${tab === "settings" ? " active" : ""}`} onClick={() => setTab("settings")}>
          <SettingsIcon size={18} strokeWidth={1.75} /> <span>Settings</span>
        </div>
        <div className="user-footer">
          <div className="who">{userSnapshot?.name ?? ""}</div>
          <div className="who">{userSnapshot?.email ?? ""}</div>
          <div className="logout" onClick={onLogout}>Sign out</div>
        </div>
      </aside>
      {tab === "files" && <Files />}
      {tab === "shares" && <SharesView />}
      {tab === "trash" && <TrashView />}
      {tab === "settings" && (
        <Settings
          onProfileUpdate={() => setUserSnapshot(api.getUser())}
          onAccountDeleted={onLogout}
        />
      )}
    </div>
  )
}

const Settings: React.FC<{ onProfileUpdate: () => void; onAccountDeleted: () => void }> = ({ onProfileUpdate, onAccountDeleted }) => {
  const current = api.getUser()
  const [name, setName] = useState(current?.name ?? "")
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
    const patch: { name?: string; email?: string } = {}
    if (name.trim() && name.trim() !== current?.name) patch.name = name.trim()
    if (email.trim() && email.trim() !== current?.email) patch.email = email.trim()
    if (!patch.name && !patch.email) {
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
            <label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
            {profileMsg && <div className={`msg ${profileMsg.kind}`}>{profileMsg.text}</div>}
            <div className="settings-actions">
              <button className="primary" onClick={saveProfile}>Save changes</button>
            </div>
          </section>

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
  const sharePath = useMemo(() => {
    const m = window.location.pathname.match(/^\/s\/(.+)$/)
    return m ? m[1] : null
  }, [])

  if (sharePath) return <SharePage token={sharePath} />

  const logout = () => {
    api.setToken(null)
    setLoggedIn(false)
  }

  return loggedIn
    ? <Shell onLogout={logout} />
    : <Auth onLogin={() => setLoggedIn(true)} />
}

createRoot(document.getElementById("app")!).render(<App />)
