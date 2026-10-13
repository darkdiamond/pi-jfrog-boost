---
name: boost
description: Use JFrog Boost in pi to recover output it shortened, read PDF and Office files, get exact output for one command, check token savings, or find out why Boost is idle. Use when a result ends with a "boost retrieve <id>" line, when output looks shortened, or when asked about Boost, token savings or context use.
---

# JFrog Boost in pi

pi-jfrog-boost hands some tool output to JFrog Boost after the tool runs and gives
you Boost's shorter version. The `jfrog-boost` section of your system prompt says
what is active in this session. At most:

- `bash` / `powershell` output, when Boost's shell filtering is on;
- MCP tool results (`mcp__<server>__<tool>`), when Boost has a filter for the tool;
- `read` of PDF, Word, Excel, PowerPoint and OpenDocument files, and of large
  notebooks read whole, which arrive as converted text.

Ordinary reads (source, JSON, Markdown, HTML, CSV, logs), `edit`, `write`, `grep`,
`find` and `ls` are never changed. Plenty of output passes through unchanged; that
is normal.

## Recovering what was dropped

Shortened output is intentional and usually enough; prefer it. A shortened result
may end with `[Boost compressed ~84%. Get the full original output simply with: boost retrieve 147]`.
When you need a detail it dropped, recover just that instead of re-running the command:

    boost retrieve 147 --query "timeout"   # matching lines only
    boost retrieve 147 --lines 40-80       # a 1-indexed range
    boost retrieve 147                     # everything (last resort)

Boost learns from retrieves: after a few, it switches that filter off on this
machine for every agent. Retrieve when you genuinely need the detail, narrowly.
If there is no marker and you need everything, re-run with `DISABLE_BOOST=1`.
If `boost` is not found, use the full path given in the system prompt.

## Exact output

- One shell command: `DISABLE_BOOST=1 <command>` (or `BOOST_DISABLED=1 <command>`).
  Commands that run `boost` themselves are never shortened.
- Web pages: curl/wget output that is a whole HTML page may arrive as readable
  text. `DISABLE_BOOST=1 curl …` gives raw HTML.
- Files: `read` is exact for text files. A notebook read with any `offset` or
  `limit` returns its raw JSON.

## Documents

Converted documents start with a `[Converted from … by JFrog Boost …]` line and are
paged like any read: use `offset` to continue. Line numbers refer to the
conversion, not the file; never `edit` from converted text. Legacy `.doc`, `.xls`
and `.ppt` cannot be converted; ask the user for a modern or text export. For
formats `read` does not convert, you may run `boost read <file>` yourself, e.g.
`boost read page.html` (article text, not source) or `boost read data.csv` (only
the first 40 lines: a preview, not the data).

## Savings and diagnosis

The user can run `/boost status`, `/boost stats` and `/boost report` in pi. In the
shell: `boost report -t` (measured savings), `boost doctor`, `boost filters show`.
Never run `boost init` or edit `~/.boost/config.toml` for the user.

## Limits

- Never pipe a command into `boost` yourself; pi already sends output to it.
- Boost wraps output; it does not sandbox commands. Secret redaction is best
  effort, not a security boundary.
- If Boost is missing, slow or failing, you get the original output.
