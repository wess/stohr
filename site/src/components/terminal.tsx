import React from "react"

export const TerminalMock: React.FC = () => (
  <div className="lp-mock lp-mock-card lp-mock-term" aria-hidden="true">
    <div className="lp-mock-term-head">
      <span className="lp-mock-dot lp-mock-dot-r" />
      <span className="lp-mock-dot lp-mock-dot-y" />
      <span className="lp-mock-dot lp-mock-dot-g" />
      <span className="lp-mock-term-title">~/stohr</span>
    </div>
    <div className="lp-mock-term-body">
      <div><span className="lp-mock-prompt">$</span> cp .env.example .env</div>
      <div><span className="lp-mock-prompt">$</span> bun install</div>
      <div><span className="lp-mock-prompt">$</span> bun run dev</div>
      <div className="lp-mock-term-ok">▸ api on http://localhost:3000</div>
      <div className="lp-mock-term-ok">▸ web on http://localhost:3001</div>
      <div className="lp-mock-term-cursor"><span className="lp-mock-prompt">$</span> <span className="lp-mock-caret">▍</span></div>
    </div>
  </div>
)
