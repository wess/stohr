import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

// Locates the prebuilt native library.
//
// Search order:
//   1. BAI_LIB env var (absolute path, for development)
//   2. <package-root>/native/dist/<platform>/libbai.<suffix>
//   3. ~/.cache/bai/lib/libbai.<suffix> (placed by scripts/postinstall.ts)
//
// suffix is provided by Bun: 'so' on linux, 'dylib' on macos, 'dll' on
// windows. The postinstall script knows the same convention.

const PKG_ROOT = resolve(import.meta.dir, "..")

const platformDir = (): string => {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch
  const os = process.platform
  return `${os}-${arch}`
}

export const resolveLibPath = (suffix: string): string => {
  const fromEnv = process.env.BAI_LIB
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const inRepo = join(PKG_ROOT, "native", "dist", platformDir(), `libbai.${suffix}`)
  if (existsSync(inRepo)) return inRepo

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  const inCache = join(home, ".cache", "bai", "lib", `libbai.${suffix}`)
  if (existsSync(inCache)) return inCache

  throw new Error(
    `bai: native library not found. Expected one of:\n` +
      `  $BAI_LIB\n` +
      `  ${inRepo}\n` +
      `  ${inCache}\n` +
      `Run \`bun install\` to fetch it via the postinstall script, or build from source in libs/bai/native/rust.`,
  )
}
