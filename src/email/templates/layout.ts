/* Minimal email shell — Nord-flavored, table-free, single column.
 * Most modern clients render flexbox/grid fine; we keep it conservative
 * with inline-friendly styles in case Outlook ever gets opened. */

export const layout = (input: { title: string; body: string }): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <style>
      body { background: #ECEFF4; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #2E3440; }
      .container { max-width: 560px; margin: 0 auto; padding: 32px 16px; }
      .card { background: #ffffff; border: 1px solid #D8DEE9; border-radius: 14px; padding: 32px; }
      .brand { font-size: 28px; font-weight: 700; letter-spacing: -0.04em; color: #2E3440; margin: 0 0 24px; }
      .btn { display: inline-block; background: #5E81AC; color: #ECEFF4; text-decoration: none; padding: 12px 22px; border-radius: 9px; font-weight: 600; }
      .footer { text-align: center; font-size: 12px; color: #4C566A; margin-top: 24px; }
      a { color: #5E81AC; }
      p { line-height: 1.55; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <p class="brand">stohr</p>
        ${input.body}
      </div>
      <div class="footer">Stohr · self-hostable cloud storage</div>
    </div>
  </body>
</html>`
