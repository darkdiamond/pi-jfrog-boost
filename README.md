# pi-jfrog-boost

[JFrog Boost](https://boost.jfrog.com/) integration for the [pi coding agent](https://pi.dev).

Boost is a free CLI that compresses noisy tool output (and converts documents)
before it reaches the model. This package wires Boost into pi using the same
hook methodology as Boost's official integrations for Claude Code, Codex,
Cursor, and OpenCode — so every tool result that would waste context gets
filtered first.

## What it does

| pi event | Boost hook | Effect |
|---|---|---|
| `tool_call` | `PreToolUse` → `boost hook claude` | Rewrites Bash commands so their output is piped through Boost; swaps `read` paths to pre-converted Markdown for HTML/docs |
| `tool_result` | `PostToolUse` → `boost hook claude` | Replaces output with Boost's compressed version, appends context (e.g. `boost retrieve` hints) |
| session / turn / compaction lifecycle | `boost hook observe claude` | Telemetry that powers `boost report` |

**Fail-open by design:** if the Boost binary is missing, slow, or returns
nothing, every tool call and result passes through untouched. A broken Boost
can never break your session.

## First run: automatic Boost install

You don't need Boost pre-installed. On first load, the extension checks for
the binary and, if missing, installs it via the **official installer** from
<https://boost.jfrog.com/llms-install.txt>:

```sh
curl -fsSL https://boost.jfrog.com/install.sh | bash
boost init --accept-terms
```

- The install runs once, at extension load, before the session starts, and is
  skipped when the binary already exists.
- `boost init --accept-terms` (which records the
  [Online Preview Agreement](https://boost.jfrog.com/preview-agreement/)) is
  run with explicit flags for the editors detected on the machine; with none
  detected it is skipped — the binary works fine for pi alone.
- Every failure is non-fatal: the extension fail-opens and you can install
  Boost manually at any time.
- **Opt out** by setting `PI_JFROG_BOOST_AUTOINSTALL=0` (or
  `BOOST_AUTOINSTALL=0`) before starting pi.

## Requirements

- [pi](https://pi.dev) coding agent
- JFrog Boost CLI — installed automatically on first run (see above), or
  manually:

```sh
curl -fsSL https://boost.jfrog.com/install.sh | bash
boost init --accept-terms
```

## Install

```sh
pi install npm:pi-jfrog-boost
```

Or from git:

```sh
pi install git:github.com/darkdiamond/pi-jfrog-boost
```

Restart pi (or run `/reload`) so the extension loads. To try it without
installing:

```sh
pi -e npm:pi-jfrog-boost
```

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `DISABLE_BOOST` | unset | Set to `1` to disable the extension at runtime |
| `BOOST_BIN` | `~/.local/bin/boost` | Path to the Boost binary |
| `PI_JFROG_BOOST_AUTOINSTALL` | unset | Set to `0` to disable first-run auto-install |
| `BOOST_AUTOINSTALL` | unset | Alias opt-out for first-run auto-install |

Boost itself is configured via `boost filters` and `~/.boost/config.toml` —
this package only relays decisions; Boost decides what to compress.

## Usage

Nothing to do — tool output is filtered automatically. Useful companions:

- `boost report` — measured token savings and what slowed your agents down
- `boost retrieve <id>` — recover original output that Boost compressed (run
  it in the chat from the marker Boost left behind)
- `boost doctor` — diagnose the install

## How it works

The extension speaks the exact JSON hook protocol Boost's editor integrations
use (verified against `boost hook claude` / `boost hook observe claude` from
Boost v0.13.x):

1. Before a `bash` or `read` tool runs, the extension sends a `PreToolUse`
   payload. If Boost replies with `updatedInput`, the tool arguments are
   patched in place (Bash commands get wrapped so output streams through
   Boost; document reads get swapped to converted Markdown).
2. After the tool finishes, the extension sends the result as `PostToolUse`.
   Boost may reply with a compressed `updatedOutput` and/or
   `additionalContext`, which replace/extend the tool result.
3. Session lifecycle events (`sessionStart`, `afterAgentResponse`,
   `preCompact`/`postCompact`, `SessionEnd`) are relayed to Boost's observe
   hook, fire-and-forget, to feed `boost report`.

Hook calls have a 15-second kill timeout. Observe calls are detached and
unref'ed so they never slow down or block shutdown.

## Security

- This package runs the locally installed `boost` binary and passes it tool
  names, arguments, and output. It does not send anything anywhere on its own;
  Boost's own network behavior is governed by the
  [JFrog Online Preview Agreement](https://boost.jfrog.com/preview-agreement/).
- As with any pi package, review the source before installing. It's short.

## License

[MIT](./LICENSE)
