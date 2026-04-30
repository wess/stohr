// Thin wrappers around Bun.spawnSync so scripts read like a sequence
// of commands rather than spawn boilerplate. Every wrapper:
//   - inherits stdio so the operator sees output live
//   - throws on non-zero exit (caller catches if it's expected)
//   - prints the command first as a "$ ..." line so the log is replayable

const greenArrow = "\x1b[32m›\x1b[0m"
const redCross = "\x1b[31m✗\x1b[0m"
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

export const step = (msg: string): void => {
  process.stdout.write(`${greenArrow} ${msg}\n`)
}

export const die = (msg: string, code = 1): never => {
  process.stderr.write(`${redCross} ${msg}\n`)
  process.exit(code)
}

export const run = (cmd: string[], opts: { cwd?: string; env?: Record<string, string>; allowFail?: boolean } = {}): number => {
  process.stdout.write(dim(`  $ ${cmd.join(" ")}\n`))
  const proc = Bun.spawnSync({
    cmd,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (proc.exitCode !== 0 && !opts.allowFail) {
    die(`command failed (exit ${proc.exitCode}): ${cmd.join(" ")}`)
  }
  return proc.exitCode ?? 1
}

export const runOut = (cmd: string[], opts: { cwd?: string; allowFail?: boolean } = {}): { code: number; stdout: string } => {
  const proc = Bun.spawnSync({
    cmd,
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = proc.exitCode ?? 1
  if (code !== 0 && !opts.allowFail) {
    die(`command failed (exit ${code}): ${cmd.join(" ")}\n${new TextDecoder().decode(proc.stderr)}`)
  }
  return { code, stdout: new TextDecoder().decode(proc.stdout) }
}
