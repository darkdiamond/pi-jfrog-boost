<div align="center">

<img src="https://raw.githubusercontent.com/darkdiamond/pi-jfrog-boost/main/.github/assets/preview.png" alt="pi-jfrog-boost: JFrog Boost for the pi coding agent" width="640">

# pi-jfrog-boost

**[JFrog Boost](https://boost.jfrog.com/) for the [pi coding agent](https://pi.dev)** — compacts noisy tool output before it reaches the model.

[![npm](https://img.shields.io/npm/v/pi-jfrog-boost?logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-jfrog-boost)
[![CI](https://github.com/darkdiamond/pi-jfrog-boost/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/darkdiamond/pi-jfrog-boost/actions/workflows/ci.yml)
[![provenance](https://img.shields.io/badge/provenance-attested-2ea44f?logo=github)](https://search.sigstore.dev/?q=pi-jfrog-boost)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/darkdiamond/pi-jfrog-boost/badge)](https://scorecard.dev/viewer/?uri=github.com/darkdiamond/pi-jfrog-boost)
[![node](https://img.shields.io/node/v/pi-jfrog-boost?logo=nodedotjs&color=5fa04e)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/pi-jfrog-boost?color=blue)](./LICENSE)
[![install size](https://img.shields.io/badge/dependencies-none-2ea44f)](./package.json)

</div>

```sh
pi install npm:pi-jfrog-boost
```

> A community project. Not affiliated with, endorsed by, or supported by JFrog.

## What it covers

| pi tool | What Boost does |
|---|---|
| `bash`, `powershell` | Compacts the command's output, failing commands included |
| `read` | Compacts file contents; converts PDFs and Office files through `boost read`, which pi can only return as raw bytes |
| `grep`, `find`, `ls` | Compacts the results |
| `edit`, `write` | Nothing — pi already summarises these as diffs |

pi's own trailing notices — `Use offset=2001 to continue`, `Full output: /tmp/…`,
`Command exited with code 1` — are kept verbatim, so compaction never costs the
model its way to the rest of the output.

On top of that the extension adds a short section to the system prompt telling
the model how to use `boost retrieve`, ships a `boost` skill with the longer
version, shows a running estimate of the tokens saved in pi's footer, and runs
`boost sync` when the agent goes idle so `boost report` has data.

**Fail-open by design.** If Boost is missing, too old, slow, or silent, every
tool result passes through untouched. A broken Boost cannot break your session.

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

### The Boost CLI

The extension needs the `boost` binary. It does **not** install anything on its
own: if Boost is missing, pi says so once and `/boost-install` will show you the
exact command and run it after you confirm.

To do it yourself:

```sh
curl -fsSL https://boost.jfrog.com/install.sh | bash
```

Boost will ask you to accept its
[Online Preview Agreement](https://boost.jfrog.com/preview-agreement/) the first
time it needs to. This package never accepts it for you and never touches any
other agent's configuration.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `DISABLE_BOOST` | unset | `1` disables the integration, for one command or a whole session |
| `BOOST_BIN` | auto-detected | Path to the Boost binary |
| `PI_BOOST_OBSERVE` | unset | `1` enables session telemetry — see the caveat below |

Boost is auto-detected from `$BOOST_BIN`, then `~/.local/bin`, then
`%LOCALAPPDATA%\boost\bin` on Windows, then `PATH` — the same order Boost's own
hooks use.

What Boost compacts is configured with `boost filters` and
`~/.boost/config.toml`. This package only hands Boost the output; Boost decides.
Plenty of output passes through unchanged, and that is normal.

### Session telemetry is opt-in, and costs this session its identity

Boost's `boost report` can also show per-tool timing. Feeding it that data means
calling `boost hook observe <agent>`, and **Boost has no `pi` agent type** — it
takes the agent from the subcommand name and falls back to `claude_code` for
anything it does not recognise. No environment variable overrides it.

Attribution is last-writer-wins, so this is not merely extra rows in the wrong
bucket: an observe call **overwrites** the correct `pi` attribution that the
filter just recorded for the same session.

Measured against Boost v0.13.24:

| observe event | effect on attribution | what it records |
|---|---|---|
| `sessionStart`, `PreToolUse`, `stop` | rewrites the session to `claude_code` | `PreToolUse` opens the tool-call row |
| `PostToolUse`, `afterAgentResponse` | leaves it alone | `PostToolUse` closes the row with its duration |
| `boost sync` | leaves it alone | — |

There is no safe subset: `PreToolUse` is what creates the record, and it is one
of the events that rewrites attribution. So telemetry is off by default, and
turning it on prints a warning at session start rather than changing your
numbers quietly. Token savings are unaffected either way — those go through
Boost's agent-neutral filter, which records pi as `pi`.

Set `PI_BOOST_OBSERVE=1` if you want per-tool timing and do not mind this
session being labelled `claude_code`. This goes away if Boost ever recognises
pi.

## Usage

Nothing to do — output is filtered automatically. Useful companions:

- `boost report -t` — measured token savings
- `boost retrieve <id>` — recover the original of something Boost compacted
- `boost read <path>` — read a PDF or Office file
- `boost doctor` — diagnose the install
- `/boost-install` — install the Boost CLI from inside pi

## How it works

Boost exposes two kinds of surface. The `boost hook <agent>` dialects speak each
editor's hook protocol but stamp every span with the agent the subcommand names
— `boost hook claude` rewrites `agent_type` to `claude_code` even when the
payload says `pi`. The agent-neutral surfaces take their identity from
`BOOST_HOOK_META`. This integration uses only the latter, so pi's work is
recorded as pi's.

1. **`tool_result`** pipes the output of a covered tool through Boost's stdin
   filter, tagged with the shell command it stands in for (`ls -la <path>` for
   the `ls` tool, and so on) because Boost's filters key on commands. If Boost
   returns something shorter, that replaces the text the model sees. pi's
   trailing notices are split off first and put back afterwards. Commands
   carrying `DISABLE_BOOST=1`, and commands that run `boost` themselves, are
   passed through untouched — the same rules Boost's OpenCode plugin applies.
2. **A `read` of a PDF or Office file** is converted through `boost read`. pi
   special-cases only images, so on its own it hands the model the file's raw
   bytes. The result is marked as converted so the model does not cite its line
   numbers as source lines.
3. **`before_agent_start`** sets a `jfrog-boost` system prompt section about
   `boost retrieve <id>`. pi diffs named sections, so an unchanged one keeps the
   provider's prompt cache.
4. **`boost sync`** runs 8 seconds after the agent goes idle, flushed
   immediately on shutdown, so measurements reach `boost report`.

The trade-off of using only agent-neutral surfaces is that output is filtered
after a tool runs rather than streamed through Boost while it runs. In practice
little is lost: on POSIX, `boost rewrite` turns a command into
`(cmd) | boost`, the very stdin filter used here, and pi bounds tool output
before handing it over anyway.

Filter calls have a 15-second kill timeout and a 4 MiB ceiling; anything larger,
binary, or empty is passed straight through. `boost sync` is detached and
unref'd, so it never delays a turn or holds up shutdown.

### Not covered

pi has no built-in MCP client. If you add one through a third-party package, its
output is not routed through Boost — the tool names and payload shapes belong to
that package, not pi, so there is nothing stable to key on.

## Security

- This package runs the locally installed `boost` binary and passes it tool
  output and arguments. It sends nothing anywhere on its own; Boost's network
  behaviour is governed by the
  [JFrog Online Preview Agreement](https://boost.jfrog.com/preview-agreement/).
- Nothing is installed, and no configuration is written, without you asking.
- Boost wraps commands; it does not sandbox them. Its redaction is best effort,
  not a security boundary.
- As with any pi package, read the source before installing. It is about 1,000
  lines across seven files, with no runtime dependencies.

## Development

```sh
npm install
npm run check          # lint, typecheck, tests
pi -e ./src/index.ts   # run pi against the working tree
```

## License

[MIT](./LICENSE)
