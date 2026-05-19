import React from "react"
import { FolderOpen, Users, Link2, Trash2, Settings as SettingsIcon, Check } from "lucide-react"

export const HeroMock: React.FC = () => (
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
