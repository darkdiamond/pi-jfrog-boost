# Security

## Reporting a vulnerability

Report privately through
[GitHub security advisories](https://github.com/darkdiamond/pi-jfrog-boost/security/advisories/new).
Please don't open a public issue for anything exploitable. Expect a first reply
within a few days.

## What this package can do

It is a pi extension, so it runs in-process with your agent and has whatever
access pi has. Concretely, it:

- runs the locally installed `boost` binary: its stdin filter on shell, log
  and (through `boost hook claude`) MCP results; `boost read` on binary
  documents (PDF, Office, OpenDocument) and large notebooks; `boost version`
  to check readiness; and `boost report -t` / `boost doctor` only when you
  ask with `/boost report` or `/boost doctor`. Every call has a timeout, and
  what it pipes to Boost is capped at 1 MiB (2 MiB for pi's full-output
  file);
- replaces tool output with Boost's reply when it is a real reduction, and
  adds a `jfrog-boost` section to the system prompt;
- reads `~/.boost/config.toml` (feature flags, whether the Preview Agreement
  is recorded, filters Boost disabled) and **never writes it**;
- writes only its own settings file (`~/.pi/agent/jfrog-boost.json`, and only
  from `/boost settings`), numbers-only `jfrog-boost-stats` entries and
  `jfrog-boost-session` on/off entries (from `/boost on|off`) in the pi
  session, apart from a confirmed binary-only `/boost install`, which
  downloads and extracts the release in a private temp directory, copies the
  binary to `~/.local/bin/boost.tmp-<pid>` and renames it to
  `~/.local/bin/boost`;
- triggers `boost sync` when the agent settles and on shutdown. Sync uploads
  Boost's local measurements to JFrog, and then prunes them locally. Turn it
  off with `sync: false` or `PI_BOOST_SYNC=0`. Boost's own opt-out
  (`boost init --no-telemetry`, or `BOOST_TELEMETRY=0`) stops Boost recording
  trace rows at all, leaving sync nothing to upload (measured on v0.16.11).
  A `boost sync` also runs Boost's own update check (updating the binary
  while its `boost-auto-update` flag is on, the default) and refreshes the
  Boost skills of agent integrations installed with `boost init`; that is
  Boost's behaviour, which pi's idle sync triggers like any other;
- with the opt-in `observe` setting, sends tool argument and output excerpts
  (up to 16k characters each) and the assistant's last reply to Boost, which
  stores them and sync uploads them;
- causes Boost to store the full request and response of every MCP call it
  filters in its local database (sync uploads them too). `mcpExclude` and
  `mcp: false` keep a server, or all of MCP, away from Boost;
- causes Boost to store the full original output of every shell command (and,
  with `readLogs`, log read) it filters in its local database, together with
  the command line; that is what `boost retrieve` reads. Whether `boost sync`
  uploads these rows has not been verified. Shell output: off (the default
  while Boost's CLI filtering is off), `readLogs: false` and `DISABLE_BOOST=1`
  on a command keep that output away from Boost;
- has **no network access of its own**, except a `/boost install` you
  confirm: the binary-only option calls the GitHub API for the latest
  release and downloads that asset from github.com/jfrog/boost, checking it
  against the SHA-256 GitHub publishes for it (with no published digest it
  installs nothing and shows the manual steps instead); the download URL
  must parse to `https://github.com/jfrog/boost/releases/download/…`, and the
  binary is verified before it replaces anything; the official option runs
  JFrog's `install.sh`,
  which the confirm text describes;
- **never** runs `boost init`, `boost retrieve`, `boost feature-flags` or
  `boost filters`, and never accepts JFrog's Preview Agreement. A test-suite
  spy (`test/helpers/spawn-spy.ts`) fails any run that tries.

Boost's own network behaviour is governed by the
[JFrog Online Preview Agreement](https://boost.jfrog.com/preview-agreement/).

## What it is not

Boost wraps commands; it does not sandbox them or make them safe to run. Its
redaction is best effort and **not a security boundary** — binary output and
partial reads may still contain secrets. Use `DISABLE_BOOST=1` for anything that
must not pass through a filter.

## Supported versions

Only the latest release gets fixes. The package is small and has no runtime
dependencies, so upgrading is always the remedy.

## Supply chain

**No runtime dependencies.** Installing the package runs no scripts of its own
and pulls nothing else from the registry.

**How a release reaches npm:**

1. A maintainer pushes a `vX.Y.Z` tag. Tag rulesets restrict who can create
   `v*` tags and stop them being moved or deleted.
2. [The publish workflow](.github/workflows/publish.yml) re-runs the full CI
   matrix and checks that the tag matches `package.json`.
3. The job runs in the `npm` deployment environment, which accepts only `v*`
   tags and waits for a maintainer's approval.
4. It authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers).
   GitHub mints a short-lived OIDC token for this repository, this workflow file
   and this environment. There is no npm token in the repository's secrets.
5. It runs `npm stage publish`. npm stages the tarball with
   [provenance](https://docs.npmjs.com/generating-provenance-statements) and
   scans it for malware. The trusted-publisher config allows staging only, so
   the tarball cannot be installed yet.
6. A maintainer approves the staged version on npmjs.com, which requires 2FA.

A compromised CI run, workflow or dependency can therefore stage a tarball but
never publish it. The npm account uses 2FA, and the package setting *Require
two-factor authentication and disallow tokens* is on, so no token can publish
either.

Verify what you installed:

```sh
npm audit signatures
```

**The repository itself:**

- Every action is pinned to a full commit SHA. Workflows default to read-only
  tokens and don't persist checkout credentials.
- CodeQL (TypeScript and workflows), [zizmor](https://docs.zizmor.sh/) and
  [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/darkdiamond/pi-jfrog-boost)
  run on every change. Pull requests also get dependency review.
- `.npmrc` applies npm v12's install-time policy on every npm version: no git
  or remote-URL dependencies, and the install fails if any package's install
  scripts have not been reviewed. Every dev dependency with install scripts is
  denied in `allowScripts`.
- Dependabot waits seven days before proposing a new release, so a compromised
  version is usually pulled before it reaches this repository. Security updates
  skip the wait.
- Secret scanning and push protection are on.
