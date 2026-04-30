// Runs once per `bun install`. Downloads the platform-specific
// `libbai.<so|dylib|dll>` from the bai release artifacts on GitHub and
// drops it into ~/.cache/bai/lib so the FFI loader can find it.
//
// We intentionally don't fail the install if the download fails — many
// CI / build environments don't have network. The runtime loader will
// raise a clearer error if the library is genuinely missing.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { libCacheDir } from "../util/cache.ts"
import { download } from "../util/download.ts"

const VERSION = "0.0.1"
const RELEASE_BASE = `https://github.com/wess/bai/releases/download/v${VERSION}`

const platformAsset = (): { name: string; suffix: string } | null => {
  const arch = process.arch
  switch (process.platform) {
    case "darwin":
      if (arch === "arm64") return { name: "libbai-darwin-arm64.dylib", suffix: "dylib" }
      if (arch === "x64") return { name: "libbai-darwin-x64.dylib", suffix: "dylib" }
      return null
    case "linux":
      if (arch === "arm64") return { name: "libbai-linux-arm64.so", suffix: "so" }
      if (arch === "x64") return { name: "libbai-linux-x64.so", suffix: "so" }
      return null
    case "win32":
      if (arch === "x64") return { name: "libbai-windows-x64.dll", suffix: "dll" }
      return null
    default:
      return null
  }
}

const main = async () => {
  if (process.env.BAI_SKIP_POSTINSTALL === "1") {
    process.stderr.write("bai: postinstall skipped (BAI_SKIP_POSTINSTALL=1)\n")
    return
  }

  const asset = platformAsset()
  if (!asset) {
    process.stderr.write(
      `bai: no prebuilt binary for ${process.platform}/${process.arch}; build from source in libs/bai/native/rust.\n`,
    )
    return
  }

  const dest = join(libCacheDir(), `libbai.${asset.suffix}`)
  if (existsSync(dest)) return // already in cache

  const url = `${RELEASE_BASE}/${asset.name}`
  try {
    await download({ url, destPath: dest })
    process.stderr.write(`bai: fetched native lib → ${dest}\n`)
  } catch (err) {
    process.stderr.write(
      `bai: postinstall download failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Set BAI_LIB to a local libbai path, or build from source. The runtime loader will fail until then.\n`,
    )
  }
}

void main()
