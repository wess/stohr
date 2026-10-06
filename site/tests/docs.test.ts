import { describe, expect, test } from "bun:test"
import { findDoc, renderDocPage } from "../src/docs/render"

describe("published documentation links", () => {
  test("creates stable unique heading anchors without losing inline markup", () => {
    const html = renderDocPage(findDoc("configuration")!, [
      "### Antivirus scanning (ClamAV)",
      "## **Same** heading",
      "## **Same** heading",
      "## Same heading-1",
      "[scanner](#antivirus-scanning-clamav)",
    ].join("\n\n"))
    expect(html).toContain('<h3 id="antivirus-scanning-clamav">Antivirus scanning (ClamAV)</h3>')
    expect(html).toContain('<h2 id="same-heading"><strong>Same</strong> heading</h2>')
    expect(html).toContain('<h2 id="same-heading-1"><strong>Same</strong> heading</h2>')
    expect(html).toContain('<h2 id="same-heading-1-1">Same heading-1</h2>')
    expect(html).toContain('href="#antivirus-scanning-clamav"')
  })

  test("resolves source-relative guides, anchors, index, and unpublished files", () => {
    const html = renderDocPage(findDoc("search")!, [
      "[configuration](CONFIGURATION.md#antivirus-scanning-clamav)",
      "[security](../SECURITY.md#authentication)",
      "[index](README.md)",
      "[hosting](../site/README.md)",
    ].join("\n\n"))
    expect(html).toContain('href="/docs/configuration/#antivirus-scanning-clamav"')
    expect(html).toContain('href="/docs/security/#authentication"')
    expect(html).toContain('href="/docs/"')
    expect(html).toContain('href="https://github.com/wess/stohr/blob/main/site/README.md"')
    expect(html).not.toContain("repo.invalid")
  })

  test("resolves root-level sources and preserves external and page links", () => {
    const html = renderDocPage(findDoc("security")!, [
      "[teams](docs/TEAMS.md?from=security#custom-domains)",
      "[external](https://example.com/docs?x=1#section)",
      "[mail](mailto:me@wess.io)",
      "[section](#authentication)",
      "[home](/)",
    ].join("\n\n"))
    expect(html).toContain('href="/docs/teams/?from=security#custom-domains"')
    expect(html).toContain('href="https://example.com/docs?x=1#section"')
    expect(html).toContain('href="mailto:me@wess.io"')
    expect(html).toContain('href="#authentication"')
    expect(html).toContain('href="/"')
  })
})
