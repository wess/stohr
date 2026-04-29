export type MimeClass = "image" | "video" | "audio" | "document" | "text" | "archive" | "other"

export const mimeClass = (mime: string): MimeClass => {
  if (!mime) return "other"
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("text/")) return "text"
  if (
    mime === "application/pdf" ||
    mime === "application/msword" ||
    mime.includes("officedocument") ||
    mime.includes("opendocument")
  ) return "document"
  if (
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/x-bzip2" ||
    mime === "application/x-rar-compressed"
  ) return "archive"
  return "other"
}
