import React from "react"
import { Logo } from "./logo"

const REPO = "https://github.com/wess/stohr"

export const Footer: React.FC = () => (
  <footer className="lp-footer">
    <div className="lp-footer-brand">
      <Logo />
      <span>Self-hostable cloud storage.</span>
    </div>
    <div className="lp-footer-cols">
      <div>
        <h4>Project</h4>
        <a href="/">Home</a>
        <a href="/setup">Get started</a>
        <a href="/developers">Developers</a>
        <a href="/docs/">Docs</a>
      </div>
      <div>
        <h4>Open source</h4>
        <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
        <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">Apache 2.0</a>
        <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">Issues</a>
      </div>
      <div>
        <h4>Docs</h4>
        <a href="/docs/architecture">Architecture</a>
        <a href="/docs/api">REST API</a>
        <a href="/docs/oauth">OAuth 2.0</a>
        <a href="/docs/deploy">Deploy</a>
      </div>
    </div>
    <div className="lp-footer-foot">stohr · Apache 2.0 · Built with Bun.</div>
  </footer>
)
