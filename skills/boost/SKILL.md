---
name: boost
description: Use JFrog Boost to recover output it compacted, read documents pi cannot open, measure token savings, bypass filtering for a command that needs exact output, or diagnose the Boost install. Use when you see a "boost retrieve <id>" marker, when output looks compacted or truncated, or when asked about Boost, token savings, or context waste.
---

# JFrog Boost

Boost compacts noisy tool output before it reaches the model. In pi it filters
the results of `bash`, `powershell`, `read`, `grep`, `find`, and `ls` after the
tool runs. `edit` and `write` are untouched.

## Recovering what was dropped

Compacted output is intentional and normally complete enough — prefer it.
When it ends in a marker like `boost retrieve 147` and you need a detail it
dropped, recover that instead of re-running the original command:

```sh
boost retrieve 147                     # the whole original output
boost retrieve 147 --query "timeout"   # BM25 search within it
boost retrieve 147 --lines 40-80       # a 1-indexed line range
```

Prefer `--query` or `--lines` over a full dump: the point is to spend fewer
tokens, not to undo the compaction.

## Reading documents

pi's `read` tool rejects PDFs and Office files as binary. A failed read of one
is retried through Boost automatically, but you can also ask directly:

```sh
boost read ./quarterly-report.xlsx
boost read --max-lines 200 ./long-spec.pdf
```

Converted text is not source lines — do not cite line numbers from it.

## Turning it off for one command

When a command must return exact, unfiltered output, prefix it:

```sh
DISABLE_BOOST=1 diff -u expected.txt actual.txt
```

Start pi with `DISABLE_BOOST=1` to turn the integration off for a whole session.

## Measuring and diagnosing

```sh
boost report -t   # token savings and what slowed the session down
boost doctor      # check the local install, hooks, and data paths
boost filters     # list, enable, and disable individual filters
```

## Limits worth knowing

- Never prefix a command with `boost` yourself; the integration handles it.
- Boost decides what to compact. Plenty of output passes through unchanged, and
  that is normal — not a sign the integration is broken.
- Boost wraps commands. It does not sandbox them or make them safe.
- Redaction is best effort, not a security boundary. Binary output and partial
  reads may still contain secrets.
- Everything fails open: if Boost is missing or errors, the original output is
  what you get.
