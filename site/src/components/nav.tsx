import React from "react"
import { Github, Menu, X } from "lucide-react"
import { Logo } from "./logo"

const REPO = "https://github.com/wess/stohr"

export type NavLink = { href: string; label: string; external?: boolean }

type Props = {
  links?: NavLink[]
}

const DEFAULT_LINKS: NavLink[] = [
  { href: "/", label: "Home" },
  { href: "/setup", label: "Get started" },
  { href: "/developers", label: "Developers" },
  { href: "/docs/", label: "Docs" },
  { href: REPO, label: "GitHub", external: true },
]

export const Nav: React.FC<Props> = ({ links = DEFAULT_LINKS }) => (
  <header className="lp-nav">
    <a href="/" className="lp-brand"><Logo /></a>
    <nav className="lp-nav-links">
      {links.map(l => (
        <a
          key={l.href + l.label}
          href={l.href}
          {...(l.external ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          {l.label}
        </a>
      ))}
    </nav>
    <div className="lp-nav-cta">
      <a
        href={REPO}
        target="_blank"
        rel="noreferrer"
        className="lp-btn lp-btn-primary lp-nav-star"
      >
        <Github size={15} strokeWidth={2} /> Star on GitHub
      </a>
      {/* CSS-only mobile menu — <details> works on the statically
          SSR'd docs pages, which ship no client JS. */}
      <details className="lp-nav-menu">
        <summary className="lp-nav-burger" aria-label="Toggle menu">
          <Menu size={20} strokeWidth={2} className="lp-burger-icon lp-burger-open" />
          <X size={20} strokeWidth={2} className="lp-burger-icon lp-burger-close" />
        </summary>
        <div className="lp-nav-menu-panel">
          {links.map(l => (
            <a
              key={l.href + l.label}
              href={l.href}
              {...(l.external ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {l.label}
            </a>
          ))}
        </div>
      </details>
    </div>
  </header>
)
