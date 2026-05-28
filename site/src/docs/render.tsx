import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { marked } from "marked"
import { Nav } from "../components/nav"
import { Footer } from "../components/footer"

export type DocEntry = {
  slug: string        // url slug, e.g. "api"
  file: string        // source filename in docs/ or repo root, e.g. "API.md"
  title: string       // sidebar label, e.g. "REST API"
  group: string       // sidebar group, e.g. "Reference"
}

export const DOCS_INDEX: DocEntry[] = [
  { slug: "architecture",  file: "docs/ARCHITECTURE.md",  title: "Architecture",       group: "Overview" },
  { slug: "configuration", file: "docs/CONFIGURATION.md", title: "Configuration",      group: "Overview" },
  { slug: "deploy",        file: "docs/DEPLOY.md",        title: "Deploy",             group: "Overview" },

  { slug: "api",            file: "docs/API.md",           title: "REST API",          group: "Reference" },
  { slug: "oauth",          file: "docs/OAUTH.md",         title: "OAuth 2.0",         group: "Reference" },
  { slug: "auth-external",  file: "docs/AUTH-EXTERNAL.md", title: "OIDC + LDAP",       group: "Reference" },
  { slug: "federation",     file: "docs/FEDERATION.md",    title: "Federation",        group: "Reference" },
  { slug: "webdav",         file: "docs/WEBDAV.md",        title: "WebDAV",            group: "Reference" },
  { slug: "actions",        file: "docs/ACTIONS.md",       title: "Action folders",    group: "Reference" },
  { slug: "s3",             file: "docs/S3.md",            title: "S3-compatible API", group: "Reference" },
  { slug: "sdks",           file: "docs/SDKS.md",          title: "SDKs",              group: "Reference" },
  { slug: "admin",          file: "docs/ADMIN.md",         title: "Admin panel",       group: "Reference" },

  { slug: "search",         file: "docs/SEARCH.md",        title: "Search",            group: "Features" },
  { slug: "spaces",         file: "docs/SPACES.md",        title: "Spaces",            group: "Features" },
  { slug: "messaging",      file: "docs/MESSAGING.md",     title: "Messaging",         group: "Features" },
  { slug: "photo-backup",   file: "docs/PHOTO-BACKUP.md",  title: "Photo backup",      group: "Features" },

  { slug: "security",     file: "SECURITY.md",      title: "Security model",       group: "Project" },
  { slug: "integrations", file: "INTEGRATIONS.md",  title: "Integrations roadmap", group: "Project" },
]

// Find a doc by slug; null when not found.
export const findDoc = (slug: string): DocEntry | null =>
  DOCS_INDEX.find(d => d.slug === slug) ?? null

const Sidebar: React.FC<{ activeSlug: string }> = ({ activeSlug }) => {
  const groups = new Map<string, DocEntry[]>()
  for (const d of DOCS_INDEX) {
    const arr = groups.get(d.group) ?? []
    arr.push(d)
    groups.set(d.group, arr)
  }
  return (
    <aside className="docs-side">
      {[...groups.entries()].map(([group, items]) => (
        <React.Fragment key={group}>
          <h4>{group}</h4>
          {items.map(item => (
            <a
              key={item.slug}
              href={`/docs/${item.slug}`}
              className={item.slug === activeSlug ? "active" : undefined}
            >
              {item.title}
            </a>
          ))}
        </React.Fragment>
      ))}
    </aside>
  )
}

// Render a single doc to a complete HTML page string.
export const renderDocPage = (entry: DocEntry, markdown: string): string => {
  const bodyHtml = marked.parse(markdown, { async: false }) as string

  const page = (
    <div className="lp devp-page">
      <Nav links={[
        { href: "/", label: "Home" },
        { href: "/setup", label: "Get started" },
        { href: "/developers", label: "Developers" },
        { href: "/docs/", label: "Docs" },
      ]} />
      <div className="docs-wrap">
        <Sidebar activeSlug={entry.slug} />
        <main className="docs-main" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      </div>
      <Footer />
    </div>
  )

  const inner = renderToStaticMarkup(page)
  const title = `Stohr — ${entry.title}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeAttr(entry.title)} — Stohr docs.">
  <title>${escapeAttr(title)}</title>
  <script>
    (function(){
      var t = localStorage.getItem('stohr_theme');
      var dark = t === 'dark' || ((t !== 'light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    })();
  </script>
  <link rel="icon" type="image/png" href="/assets/logo.png">
  <link rel="apple-touch-icon" href="/assets/logo.png">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="app">${inner}</div>
</body>
</html>
`
}

// Render the docs index page (list of all docs).
export const renderDocsIndex = (): string => {
  const page = (
    <div className="lp devp-page">
      <Nav links={[
        { href: "/", label: "Home" },
        { href: "/setup", label: "Get started" },
        { href: "/developers", label: "Developers" },
        { href: "/docs/", label: "Docs" },
      ]} />
      <section className="lp-hero">
        <div className="lp-hero-text">
          <p className="lp-eyebrow">Documentation</p>
          <h1>Read the <em>fine</em> manual.</h1>
          <p className="lp-lede">
            Architecture, configuration, deploy, the full REST surface, OAuth,
            S3-compatible bucket, action folders, SDKs.
          </p>
        </div>
      </section>

      <section className="devp-section">
        {[...new Set(DOCS_INDEX.map(d => d.group))].map(group => (
          <React.Fragment key={group}>
            <h2>{group}</h2>
            <div className="devp-grid-3">
              {DOCS_INDEX.filter(d => d.group === group).map(d => (
                <a key={d.slug} className="devp-card devp-card-link" href={`/docs/${d.slug}`}>
                  <h3>{d.title}</h3>
                  <p>{`${d.file}`}</p>
                </a>
              ))}
            </div>
          </React.Fragment>
        ))}
      </section>

      <Footer />
    </div>
  )

  const inner = renderToStaticMarkup(page)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Stohr documentation index.">
  <title>Stohr — Docs</title>
  <script>
    (function(){
      var t = localStorage.getItem('stohr_theme');
      var dark = t === 'dark' || ((t !== 'light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    })();
  </script>
  <link rel="icon" type="image/png" href="/assets/logo.png">
  <link rel="apple-touch-icon" href="/assets/logo.png">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="app">${inner}</div>
</body>
</html>
`
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
