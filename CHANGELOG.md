# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-15

Validated against Boost v0.15.4 and pi 1.2.0; the oldest supported pi is now
0.86.1. Boost 0.13.13 is still the oldest Boost accepted.

### Fixed

- On pi 1.x, compacting a result dropped its `structuredContent`, and tool
  calls made from inside codemode were compacted as well. `structuredContent`
  now always passes through, and nested calls are left alone.
- `read index.html` and `bash cat index.html` reached the model as Boost's
  Markdown rendering of the page, so the model could not see or `edit` the
  real file. HTML is now passed through unless the command is a web fetch
  (`curl`, `wget`, …).
- Converted documents were unbounded, ignored `offset`/`limit`, and were
  converted even after pi had refused the read. They are now paged exactly
  like pi's `read` (2000 lines / 50 KB, `offset` continues, from a cache), and
  a refused read stays refused.
- Document paths starting with `~`, `@` or `-` were resolved wrongly or taken
  as Boost options.
- Boost's advisory for legacy `.doc`/`.xls`/`.ppt` files was presented to the
  model as if it were the file's text. It is now an error that says what to
  ask the user for.
- `/path/to/boost retrieve …` (a path-qualified Boost command) was compacted
  again, replacing the recovered original with another marker.
- Offline, every Boost call stalled about 5 s on a feature-flag refresh that
  could not succeed, and a slow first `boost version` turned the extension off
  for the rest of the session. pi's calls now skip the refresh when the cached
  flags are missing or older than their TTL (24 h, or your own
  `BOOST_FEATURE_FLAGS_TTL`), readiness is checked without blocking any tool,
  and a Boost that did not answer is retried. Flags are refreshed by the
  idle-time `boost sync` or by other Boost integrations instead; with sync off
  (`sync: false`, `PI_BOOST_SYNC=0`) and no other Boost agent on the machine
  they are not refreshed until you run Boost yourself, and `/boost status`
  says so.
- `/boost-install`'s confirmation described JFrog's installer as only
  installing the binary. It can also edit shell rc files and run
  `boost init --accept-terms`, which accepts the Preview Agreement and adds
  hooks to other agents; the new `/boost install` says so, and its default
  option no longer runs the installer at all.
- **The 0.3.0 e2e suite was not isolated, contrary to its changelog entry.**
  It redirected only `XDG_DATA_HOME`, which Boost ignores on macOS, so each run
  wrote the maintainer's real Boost history and config, and its retrieve
  counted towards Boost switching a filter off for every agent on the machine.
  The suite is now hermetic (a throwaway HOME, DB and temp dir, refused
  proxies) and fails if the real Boost state changes. **If you ran
  `npm run test:e2e` from 0.3.0, check `~/.boost/config.toml` for a
  `[filters] disabled` list; `/boost status` shows it** (re-enable with
  `boost filters enable <name>`).
- A reply that differed only in whitespace or ANSI colour was applied as a
  "compaction". A reply must now save at least 256 bytes and 5%, and when it
  does not, the original bytes, colour included, are kept.
- With two copies of the extension loaded into one pi (a global install plus
  a local path, or `pi -e` while developing), the second sent the first's
  compacted output through Boost again and could drop its `boost retrieve`
  marker. A result already changed by pi-jfrog-boost is now left alone.
- Moving to another point with `/tree` kept the previous branch's savings in
  the footer and wrote them onto the new branch.
- The binary-only install confirm promised that shell compaction works right
  away, but Boost ≥ 0.14.6 has it off by default. It now says so and how to
  turn it on for pi. The shell-off notice, at startup and after an install,
  names documents and MCP results as still handled only when they really are
  (the setting is on, the terms are accepted for documents, Boost is ≥ 0.15.3
  for MCP).

### Changed

- File reads are exact: `read` of text files (source, JSON, Markdown, HTML,
  CSV, logs) is never changed, and `grep`, `find` and `ls` are no longer
  filtered (pi's output for them never compacts on Boost 0.15.4).
- Shell compaction follows Boost's `boost-cli-filtering` flag, which has been
  off by default since Boost 0.14.6; with it off, shell output is not even
  sent. `/boost settings` → Shell output: on turns it on for pi alone, through
  the environment of pi's own Boost calls (Boost's config is never written).
- Legacy `.doc`, `.xls` and `.ppt` produce an advisory error; `.csv`, `.html`,
  `.htm` and `.rtf` are no longer converted (lossy with no retrieve, or
  already text).
- `boost sync` runs when the agent settles (`agent_settled`), single-flight,
  with `--max-batches 20` and a 120 s watchdog, and can be turned off.
- Observe events moved to `tool_execution_start`/`end`, gained compaction
  events and durations, and skip nested calls. The daily tip and the
  "recorded as claude_code" observe warning are gone (Boost v0.15.4 keeps pi's
  span attribution; see the README's attribution table, which replaces the
  v0.13.24 one).
- The largest output sent to Boost is 1 MiB (was 4 MiB), with timeouts that
  scale with size instead of a flat 15 s.
- The oldest supported pi is 0.86.1. Only types are imported from pi, and
  1.x features are detected at runtime.

### Added

- MCP compaction: `mcp__*` results go through Boost's MCP filters (Slack,
  GitHub, browser snapshots and more), keeping images and
  `structuredContent`. `mcpExclude` keeps chosen servers away from Boost.
- Full-output re-filter: when pi truncated `bash` output, Boost filters pi's
  full output file, so early failures in a long run reach the model.
- Notebook conversion for whole reads of `.ipynb` files of 16 KiB or more
  (`offset=1` returns the raw JSON), and opt-in compaction of whole `*.log`/
  `*.out` reads (`readLogs`).
- The `/boost` hub (`status`, `on`, `off`, `settings`, `stats`, `report`,
  `doctor`, `install`, `help`, with completions), a footer that always shows
  the state, per-result transcript badges (pi ≥ 1.0.1), and savings that
  persist across resume.
- A global settings file (`~/.pi/agent/jfrog-boost.json`, with
  `settings.schema.json`), the `--no-boost` flag, `BOOST_DISABLED=1` as a
  second kill switch, and `BOOST_EXE` as an alias of `BOOST_BIN`.
- A circuit breaker that pauses Boost after three calls in a row that timed
  out, crashed or were very slow,
  abort support, at most four concurrent Boost processes, and size gates.
- `/boost install`'s binary-only option: the release asset from GitHub,
  checked against GitHub's published SHA-256 when GitHub publishes one (the
  confirm text says when it does not), placed in `~/.local/bin`, with
  no installer script, rc edits, hooks or terms.
- A hermetic e2e suite with a tripwire on the real Boost state, run against
  pi 1.2.0 (`npm run test:e2e`) and 0.86.1 (`npm run test:e2e:min`); a CI
  matrix over pi 0.86.1 and ^1.2.0; and a weekly canary against pi@latest
  that opens a `canary` issue when it fails.

### Security

- The install consent text is accurate, and the default install path runs no
  third-party script and verifies what it downloads against GitHub's
  published SHA-256 when one is published, and tells you when none is.
- README and SECURITY.md say what `boost sync` uploads, that Boost stores and
  syncs MCP bodies, and how to turn each off. The "makes no network requests"
  wording is replaced by the exact list of what the package can do.

## [0.3.0] - 2026-09-23

### Fixed

- PDFs and Office files read with `read` are converted through `boost read`.
  pi does not reject them as binary, as earlier releases assumed: it returns
  their raw bytes, so the conversion never ran and the model got garbage.
- `DISABLE_BOOST=1 <command>` now returns exact output. pi runs the shell in
  its own process, so the variable never reached the extension and the output
  was compacted anyway.
- `boost retrieve` and other commands that run Boost are no longer compacted a
  second time, which replaced the recovered original with yet another marker.
- The awareness text told a PowerShell-only model to prefix commands with
  `DISABLE_BOOST=1`, which PowerShell cannot parse. It now gives
  `$env:DISABLE_BOOST=1;` there, and both forms when both shells are visible.
- With pi's `deferred` MCP exposure, the awareness text left MCP out for the
  prompt in which `tool_search` loads an `mcp__*` tool, although its results
  were already shortened. Deferred MCP tools now count once `tool_search` is
  visible.

### Changed

- Failed `bash` and `powershell` commands are compacted too, and stay errors.
  A failing test run or build is the noisiest output there is.
- pi's trailing notices (`Use offset=… to continue`, `Full output: …`,
  `Command exited with code …`, `limit reached`) are split off before
  filtering and restored verbatim, so they can never be dropped.
- The awareness text is set as a `jfrog-boost` system prompt section where pi
  supports it, so it is diffed rather than replacing the whole prompt and the
  prompt cache survives. Older pi releases keep the previous behaviour.
- `grep`'s `ignoreCase`, `literal`, and `glob` options are reflected in the
  command Boost is told the output came from.

### Added

- A running estimate of the tokens Boost saved this session, in pi's footer.
- An end-to-end suite (`test/e2e.test.ts`, `npm run test:e2e`) driving pi's
  real tools through the extension and the real Boost binary. It skips where
  Boost is not installed, which includes CI, and gives each run a throwaway
  Boost history so it never counts towards Boost switching a filter off.

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

[Unreleased]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/darkdiamond/pi-jfrog-boost/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/darkdiamond/pi-jfrog-boost/releases/tag/v0.1.0
