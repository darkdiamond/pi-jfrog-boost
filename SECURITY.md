# Security

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/darkdiamond/pi-jfrog-boost/security/advisories/new).
Please don't open a public issue for anything exploitable. Expect a first reply
within a few days.

## What this package can do

It is a pi extension, so it runs in-process with your agent and has whatever
access pi has. Concretely, it:

- runs the locally installed `boost` binary and pipes tool output to it on
  stdin, with a 15-second timeout and a 4 MiB ceiling;
- replaces tool output with whatever Boost returns;
- adds a block to the system prompt;
- runs `boost sync` when the agent goes idle.

It installs nothing, writes no configuration, and makes no network requests of
its own. `/boost-install` runs the official installer only after you confirm it.
Boost's own network behaviour is governed by the
[JFrog Online Preview Agreement](https://boost.jfrog.com/preview-agreement/).

## What it is not

Boost wraps commands; it does not sandbox them or make them safe to run. Its
redaction is best effort and **not a security boundary** — binary output and
partial reads may still contain secrets. Use `DISABLE_BOOST=1` for anything that
must not pass through a filter.

## Supply chain

Releases are published from tagged commits by
[a GitHub Actions workflow](.github/workflows/publish.yml) with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), so
every tarball is cryptographically linked to the commit and run that produced
it. Verify with:

```sh
npm audit signatures
```

The package has no runtime dependencies.
