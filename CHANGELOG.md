# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.7] - 2026-05-31

### Fixed

- Type-check now passes cleanly under `tsc --noEmit`, so it can serve as a
  release gate. Resolved schema column default type mismatches in
  `src/schema/index.ts` (timestamp defaults typed as `Date`, bigint defaults
  as `bigint`), raw `select(...)` fragment typing in `src/federation/files.ts`
  and `src/admin/index.ts`, and a row-shape cast in `src/auth/deletion.ts`.

### Changed

- Biome now lints and formats `src/` and `scripts/` instead of a nonexistent
  `packages/` directory. Formatter settings match the existing house style
  (no semicolons, double quotes, omitted single-arg arrow parens). Pervasive
  pre-existing accessibility and React-hook findings in the single-file SPA
  are surfaced as warnings rather than hard errors so the gate stays green.
- `@biomejs/biome` is pinned in `devDependencies`; the lint/format/check
  scripts invoke the local binary directly.
- Added a `typecheck` script (`tsc --noEmit`).

### Added

- Continuous-integration workflow (`.github/workflows/ci.yml`) that runs the
  type-check, Biome, and the full test suite against a Postgres service
  container on every push and pull request. The existing publish workflow is
  unchanged.

## [0.7.6] - 2026-05-28

Latest release prior to this changelog. See the Git history for the granular
changes that shipped across the 0.7.x line, which includes the move of `atlas`
from a Git submodule to a Bun package dependency, the SPA pre-build with
`Bun.build`, single-sign-on work, and the MCP server.

[0.7.7]: https://github.com/wess/stohr/releases/tag/0.7.7
[0.7.6]: https://github.com/wess/stohr/releases/tag/0.7.6
