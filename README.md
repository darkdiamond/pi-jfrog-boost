# pi-jfrog-boost

[JFrog Boost](https://boost.jfrog.com/) for the [pi coding agent](https://pi.dev).

Boost is a free CLI that compacts noisy tool output before it reaches the model.
This package pipes pi's tool results through it, so the output that would
otherwise burn your context gets filtered first — and tells the model how to
recover anything Boost dropped.

> A community project. Not affiliated with, endorsed by, or supported by JFrog.

## What it covers

| pi tool | What Boost does |
|---|---|
| `bash`, `powershell` | Compacts the command's output |
| `read` | Compacts file contents; retries PDFs and Office files through `boost read`, which pi cannot open at all |
| `grep`, `find`, `ls` | Compacts the results |
| `edit`, `write` | Nothing — pi already summarises these as diffs |

On top of that the extension adds a short block to the system prompt telling the
model how to use `boost retrieve`, ships a `boost` skill with the longer version,
and runs `boost sync` when the agent goes idle so `boost report` has data.

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

### Session telemetry is opt-in

Boost's `boost report` can also show session timing — which tools ran, how long
they took, where the session stalled. Feeding it that data means calling
`boost hook observe <agent>`, and **Boost has no `pi` agent type**: it files
whatever it receives under whichever agent the subcommand names, so pi's
sessions would show up in your Claude Code numbers and skew them.

Token savings do not have this problem — those go through Boost's agent-neutral
filter, which records pi as `pi` — so they are always reported.

Set `PI_BOOST_OBSERVE=1` if you want the timing data anyway and don't mind the
label. It will be removed once Boost recognises pi.

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
   returns something shorter, that replaces the text the model sees.
2. **A failed `read` of a document** is retried through `boost read`, which can
   extract text from PDFs and Office files that pi rejects as binary. The result
   is marked as converted so the model does not cite its line numbers as source
   lines.
3. **`before_agent_start`** adds a short block to the system prompt about
   `boost retrieve <id>`.
4. **`boost sync`** runs 8 seconds after the agent goes idle, flushed
   immediately on shutdown, so measurements reach `boost report`.

The trade-off of using only agent-neutral surfaces is that output is filtered
after a tool runs rather than streamed through Boost while it runs. That is the
same trade-off Boost's own OpenCode plugin makes on Windows, and pi bounds tool
output before handing it over anyway.

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
- As with any pi package, read the source before installing. It is under 900
  lines across seven files, with no runtime dependencies.

## Development

```sh
npm install
npm run check          # lint, typecheck, tests
pi -e ./src/index.ts   # run pi against the working tree
```

## License

[MIT](./LICENSE)
