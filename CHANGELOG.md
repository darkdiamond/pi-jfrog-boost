# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/darkdiamond/pi-jfrog-boost/releases/tag/v0.1.0
