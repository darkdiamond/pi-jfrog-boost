# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-20

### Added

- Initial release: JFrog Boost integration for the pi coding agent.
- `PreToolUse` relay (`tool_call`): Boost Bash auto-rewrite and Read document
  conversion via `updatedInput`.
- `PostToolUse` relay (`tool_result`): compressed output (`updatedOutput`) and
  additional context (`additionalContext`).
- Observe telemetry: `sessionStart`, `afterAgentResponse`, `preCompact`,
  `postCompact`, `SessionEnd` via `boost hook observe claude`.
- Fail-open everywhere; `DISABLE_BOOST=1` runtime kill switch; `BOOST_BIN`
  override; 15s hook timeout.
- First-run auto-install: when the Boost binary is missing, the extension
  installs it via the official installer (https://boost.jfrog.com/llms-install.txt)
  and runs `boost init --accept-terms` for detected editors. Opt out with
  `PI_JFROG_BOOST_AUTOINSTALL=0`.
