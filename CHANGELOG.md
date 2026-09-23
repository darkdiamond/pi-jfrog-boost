# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.4] - 2026-09-23

No runtime changes; this is release and repository hardening.

### Changed

- Releases go through [npm staged publishing](https://docs.npmjs.com/cli/commands/npm-stage):
  CI stages the tarball and a maintainer approves it with 2FA once npm's
  malware scan has passed. CI cannot ship a version on its own.
- The `npm` deployment environment requires a maintainer's approval and accepts
  only `v*` tags.
- `.npmrc` sets npm v12's install-time policy explicitly: no git or remote-URL
  dependencies, and an install fails on any package whose install scripts have
  not been reviewed in `allowScripts`. The three dev-tree packages that ship
  scripts (`esbuild`, `protobufjs`, `@google/genai`) are denied; nothing needs
  them.
- Every workflow action is pinned to a full commit SHA, checkouts no longer
  persist credentials, and the release job restores no cache.
- Dependabot waits seven days before proposing a new release (security updates
  are exempt) and groups GitHub Actions updates.

### Added

- CodeQL (TypeScript and workflows), zizmor and OpenSSF Scorecard scanning.
- Dependency review on pull requests, and `npm audit signatures` in CI and before
  every release.
- `CODEOWNERS`.

## [0.2.3] - 2026-09-20

No runtime changes. This release exists to exercise the publish path end to end
now that it uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
rather than a long-lived write token — the configuration cannot be verified from
outside npm, so an actual release is the only test.

### Changed

- Releases are published with a short-lived OIDC credential; there is no publish
  token in the repository's secrets.

## [0.2.2] - 2026-09-20

### Added

- A gallery preview card, wired up as `pi.image` so the package renders with
  artwork at https://pi.dev/packages instead of as plain text. pi accepts
  PNG/JPEG/GIF/WebP there, not SVG, and fetches it by URL.

### Changed

- Bumped the `@earendil-works/pi-coding-agent` dev dependency to 0.86.1, so
  typechecking runs against the SDK users actually have.
- The README header now leads with the preview card.
- Dropped `.github/assets` from the published `files`: both the gallery and the
  README fetch the art by URL, so there was no reason to carry it in every
  install.

## [0.2.1] - 2026-09-20

### Changed

- `author` is now `DarkDiamonD (https://github.com/darkdiamond)` with no email
  address, and the licence names the same. Earlier releases carried a personal
  address in `package.json`.

## [0.2.0] - 2026-09-20

### Changed

- Telemetry: probing Boost v0.13.24 showed `boost hook observe` does not merely
  file pi's rows under Claude Code — attribution is last-writer-wins, so
  `sessionStart`, `PreToolUse`, and `stop` **overwrite** the correct `pi`
  attribution the filter just recorded. `PI_BOOST_OBSERVE=1` now prints a
  warning at session start instead of changing `boost report` quietly, and
  README documents the measured per-event behaviour.

### Removed

- The `stop` observe on shutdown. It recorded nothing measurable and
  reattributed the session; `boost sync` already handles shutdown and leaves
  attribution alone.

### Fixed

- The "Boost is not installed" path fell through on the second and later
  sessions, so a session could warn about telemetry for a Boost that was not
  installed.

### Added

- `SECURITY.md`, `CONTRIBUTING.md`, issue templates, Dependabot, a logo, and
  README badges.

## [0.1.0] - 2026-09-20

### Added

- Initial release: JFrog Boost integration for the pi coding agent.
- Output filtering for `bash`, `powershell`, `read`, `grep`, `find`, and `ls`,
  tagged with the equivalent shell command so Boost's command-keyed filters
  apply.
- Document extraction: a `read` that pi rejects as binary is retried through
  `boost read`, so PDFs and Office files become readable.
- Boost awareness in the system prompt plus a `boost` skill, so the model runs
  `boost retrieve <id>` instead of re-running a command.
- Debounced `boost sync` on idle, flushed on shutdown, so `boost report` has
  data.
- Binary auto-detection across `$BOOST_BIN`, `~/.local/bin`,
  `%LOCALAPPDATA%\boost\bin`, and `PATH`, matching Boost's own hooks.
- `/boost-install` — installs the Boost CLI after showing the exact command and
  asking for confirmation.
- Fail-open everywhere: a 15s timeout, a 4 MiB ceiling, a one-shot version gate,
  and `DISABLE_BOOST=1` as a runtime kill switch.
- Opt-in session telemetry behind `PI_BOOST_OBSERVE=1`. It is off by default
  because Boost has no `pi` agent type and would file pi's sessions under
  Claude Code.

[Unreleased]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/darkdiamond/pi-jfrog-boost/releases/tag/v0.1.0
