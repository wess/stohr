// Minimal XML rendering for WebDAV PROPFIND responses. We deliberately do
// NOT use a full XML parser/builder — DAV responses are well-defined and
// our properties subset is small. xml-escape everything we put into text
// or attribute positions.

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")

const rfc1123 = (iso: string): string => {
  try {
    return new Date(iso).toUTCString()
  } catch {
    return new Date().toUTCString()
  }
}

const iso8601 = (iso: string): string => {
  try {
    return new Date(iso).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

export type PropfindEntry = {
  href: string
  isCollection: boolean
  name: string
  size: number
  mime: string
  created_at: string
  updated_at?: string
}

// Wraps an entry's properties as <D:response>. We always include the core
// RFC 4918 properties; OS-level clients (Finder, Explorer) need at least
// resourcetype, getcontentlength, getcontenttype, getlastmodified,
// creationdate, displayname.
export const renderResponse = (entry: PropfindEntry): string => {
  const resourcetype = entry.isCollection ? "<D:collection/>" : ""
  const contentLength = entry.isCollection ? "" : `<D:getcontentlength>${entry.size}</D:getcontentlength>`
  const contentType = entry.isCollection ? "" : `<D:getcontenttype>${xmlEscape(entry.mime)}</D:getcontenttype>`
  return `<D:response>
  <D:href>${xmlEscape(entry.href)}</D:href>
  <D:propstat>
    <D:prop>
      <D:displayname>${xmlEscape(entry.name)}</D:displayname>
      <D:resourcetype>${resourcetype}</D:resourcetype>
      ${contentLength}
      ${contentType}
      <D:creationdate>${iso8601(entry.created_at)}</D:creationdate>
      <D:getlastmodified>${rfc1123(entry.updated_at ?? entry.created_at)}</D:getlastmodified>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`
}

export const renderMultistatus = (entries: PropfindEntry[]): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${entries.map(renderResponse).join("\n")}
</D:multistatus>`
