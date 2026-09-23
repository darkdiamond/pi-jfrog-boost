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
