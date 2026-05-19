import React, { useEffect } from "react"
import { Github, ChevronRight } from "lucide-react"
import { Nav } from "../components/nav"
import { Footer } from "../components/footer"
import { HeroMock } from "../components/hero"
import { TerminalMock } from "../components/terminal"
import { FEATURES } from "../components/features"

const REPO = "https://github.com/wess/stohr"

export const Landing: React.FC = () => {
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
      <Nav />

      <section className="lp-hero">
        <div className="lp-hero-text">
          <p className="lp-eyebrow">Open-source cloud storage</p>
          <h1>
            Your files.<br />
            <em>Your storage.</em><br />
            Your rules.
          </h1>
          <p className="lp-lede">
            Photo galleries, scriptable folders, encrypted federation with
            friends, mount-as-a-drive WebDAV, an S3-compatible API — without
            the surveillance, the upsells, or the dark patterns. Free and
            open source; run it yourself on a $6 droplet.
          </p>
          <div className="lp-cta-row">
            <a href={REPO} target="_blank" rel="noreferrer" className="lp-btn lp-btn-primary lp-btn-lg"><Github size={16} strokeWidth={2} /> View on GitHub</a>
            <a href="/setup" className="lp-btn lp-btn-ghost lp-btn-lg">Get started <ChevronRight size={16} strokeWidth={2} /></a>
          </div>
        </div>
        <div className="lp-hero-vis">
          <HeroMock />
        </div>
      </section>

      <section className="lp-trust" aria-label="Open source and stack">
        <a href={REPO} target="_blank" rel="noreferrer" className="lp-trust-item lp-trust-link">
          <Github size={16} strokeWidth={1.75} /> github.com/wess/stohr
        </a>
        <span className="lp-trust-item">Apache 2.0</span>
        <span className="lp-trust-item">Self-hosted</span>
        <span className="lp-trust-item">Federated</span>
        <span className="lp-trust-item">WebDAV</span>
        <span className="lp-trust-item">S3-compatible</span>
        <span className="lp-trust-item">Bun · React · Postgres</span>
      </section>

      <section className="lp-features" id="features">
        <header className="lp-section-head">
          <p className="lp-eyebrow">Features</p>
          <h2>Built for the way <em>you</em> store.</h2>
          <p className="lp-section-lede">Four things that make Stohr feel different the moment you start using it.</p>
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

      <section className="lp-features" id="self-host">
        <header className="lp-section-head">
          <p className="lp-eyebrow">Self-host</p>
          <h2>Yours to <em>run</em>.</h2>
          <p className="lp-section-lede">
            One command brings up the API and the web app. Postgres for
            metadata, any S3-compatible bucket — or local disk — for the
            bytes. Apache 2.0, no telemetry, no accounts but the ones you
            create.
          </p>
        </header>

        <div className="lp-feature-rows">
          <article className="lp-feature-row">
            <div className="lp-feature-text">
              <div className="lp-feature-tag">
                <span className="lp-feature-eyebrow">Quick start</span>
              </div>
              <h3>Up in three commands.</h3>
              <p>
                Clone the repo, copy <code>.env.example</code>, run{" "}
                <code>bun run dev</code>. The first account you create becomes
                the owner; everyone after is invite-only. Ship it to a droplet
                with the included <code>compose.yaml</code> and Caddy config.
              </p>
              <div className="lp-cta-row">
                <a href={REPO} target="_blank" rel="noreferrer" className="lp-btn lp-btn-primary lp-btn-lg"><Github size={16} strokeWidth={2} /> Get the source</a>
                <a href="/docs/" className="lp-btn lp-btn-ghost lp-btn-lg">Read the docs <ChevronRight size={16} strokeWidth={2} /></a>
              </div>
            </div>
            <div className="lp-feature-vis">
              <TerminalMock />
            </div>
          </article>
        </div>
      </section>

      <Footer />
    </div>
  )
}
