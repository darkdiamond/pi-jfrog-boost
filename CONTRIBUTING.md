# Contributing

## Getting set up

```sh
npm install
npm run check                 # biome, tsc --noEmit, node:test
pi -e ./src/index.ts          # run pi against the working tree
```

You'll want the [Boost CLI](https://boost.jfrog.com/) binary to exercise
anything end to end. The unit tests don't need it — they drive a Node stand-in.
With it, `npm run test:e2e` runs pi's real tools through the real extension and
Boost binary, inside a throwaway HOME (see [End to end](#end-to-end)).

## House rules

- **No runtime dependencies.** The package ships TypeScript sources that pi
  loads through jiti; `@earendil-works/pi-coding-agent` is a peer, type-only
  import. Keep it that way.
- **Fail open, always.** A missing, slow, or broken Boost must never change what
  the agent sees. `tool_call` handlers in particular are not wrapped by pi — a
  throw there blocks the tool call outright.
- **Verify against the real binary.** Boost's behaviour is not always what its
  docs imply; several decisions here came from probing `boost` directly. If you
  change protocol handling, say in the PR what you observed and how.
- **Never let the extension run `boost retrieve`, `feature-flags`, `init` or
  `filters`.** They change Boost's state for every agent on the machine: a
  retrieve counts towards Boost switching a filter off globally,
  `feature-flags` rewrites `~/.boost/config.toml`, `init` accepts JFrog's
  agreement and installs hooks into other agents. Only the model (through its
  own shell) or the user runs them. `test/helpers/spawn-spy.ts` enforces this
  across the whole test suite: a forbidden spawn is blocked and fails the run,
  even when fail-open code swallows the error.
- **Never run Boost against your real HOME from tests.** Not in a unit test,
  not in a probe script, not "just once". Use the hermetic helper below.
- **Use Boost's agent-neutral surfaces.** The `boost hook <agent>` dialects
  stamp spans with the agent named by the subcommand, which mislabels pi. See
  the comment at the top of `src/tools.ts`.

## Tests

`node:test`, no framework. `npm run check` runs lint, typecheck and the unit
tests; it must pass before a PR.

Pure logic gets unit tests. Anything involving process behaviour (timeouts,
non-zero exits, a boost that closes stdin early, oversized replies) drives a
real child process, because a stubbed `spawn` would only prove the stub works.
The child is `test/fixtures/fake-boost.mjs`, a Node stand-in for Boost scripted
through `FAKE_BOOST_*` variables (echo, compact-to, sleep, hang, exit code,
huge output, read advisory, hook reply; see its header). The client runs it
through the injectable `BoostClientDeps.launcher` (`node fake-boost.mjs …`),
so these tests run on Windows too. Don't add `#!/bin/sh` stand-ins.

Extension-level suites drive `createBoostExtension` through the pi host stub
in `test/helpers/harness.ts`. It has event factories for both supported pi
lines — 0.86-shaped (no `structuredContent`, `parentToolCallId`, `durationMs`,
`aborted` or `messageType`) and 1.2-shaped — and replays pi's runner patch
semantics, including pi 1.x dropping `structuredContent` when a handler
replaces `content` without it. Test both shapes when behaviour differs.

`npm test` loads `test/helpers/spawn-spy.ts` into every test file with
`node --import`; suites that spawn Boost also import it directly.

### End to end

`test/e2e.test.ts` is the exception to stand-ins: pi's real `read` and `bash`
tools, the real extension, and the real Boost binary. It checks the
assumptions everything else rests on — what pi's tools actually return, what
Boost actually does with it — and asserts only what this integration
guarantees, not how much a given Boost release compresses.

It is **hermetic** (`test/helpers/hermetic.ts`). Before anything spawns, it:

- resolves the binary from `BOOST_BIN` (or the normal search) while HOME is
  still real, then passes it on through `BOOST_BIN` and the front of PATH;
- creates a temp HOME with a synthesized `~/.boost/config.toml`: fresh flag
  metadata (without it every Boost call stalls ~5 s) and
  `boost-cli-filtering` `user = true`;
- copies **only** the three Preview Agreement lines (`accept_terms`,
  `accept_terms_at`, `terms_version`), read-only, from `BOOST_E2E_TERMS_FROM`
  (default: your `~/.boost/config.toml`), or the whole config from
  `BOOST_E2E_HOME/.boost/config.toml`. The suite never accepts the agreement;
  without it the document and retrieve cases skip (`boost read` and
  `boost retrieve` refuse to run without it), or fail with
  `PI_BOOST_E2E_STRICT=1`;
- points HOME/USERPROFILE, `BOOST_DB_PATH`, TMPDIR/TEMP/TMP and XDG_* into the
  temp HOME, every proxy variable at a refused port, and sets
  `BOOST_FEATURE_FLAGS_TTL=24h` and `PI_BOOST_SYNC=0`;
- fingerprints (sha256, size, mtime) your real `~/.boost/config.toml`, history
  DB and Boost data directories, and its last test fails if any of them
  changed or a `.boost/` or `install_id` appeared.

The 0.3.0 suite did not do this: it isolated only `XDG_DATA_HOME`, which Boost
ignores on macOS, so each run wrote your real Boost history and counted its
retrieve towards Boost disabling a filter for every agent. If you ran it,
check `~/.boost/config.toml` for `[filters] disabled`.

```sh
npm run test:e2e                     # Boost found on PATH / ~/.local/bin, or:
BOOST_BIN=/path/to/boost BOOST_E2E_TERMS_FROM=/path/to/config.toml npm run test:e2e
npm run test:e2e:min                 # the same suite against pi 0.86.1
```

It skips when no Boost binary is found; `npm run test:e2e` sets
`PI_BOOST_E2E=1`, which makes a missing Boost a failure instead.
`test:e2e:min` copies the tree to a temp directory and installs pi 0.86.1
there with `--no-save`, so nothing here changes (`--check` adds typecheck and
unit tests). Run both before a release, and whenever pi or Boost changes
version.

### CI

The `check` job runs typecheck and unit tests on Linux, Windows and macOS ×
Node 22.19 and 24 × pi `dev` (the ^1.2.0 devDependency) and `min` (0.86.1,
installed with `npm install --no-save --ignore-scripts`); min × Node 22.19 runs
on Linux only. Lint runs once. The `package` job verifies registry signatures
and runs `npm run check:pack`, which asserts the tarball holds exactly
`src/`, `skills/`, the settings schema, README, LICENSE, CHANGELOG and
`package.json`, with no install-time lifecycle scripts and no runtime
dependencies.

### Running Boost in CI

CI does not run the e2e suite, so it skips there. That is a maintainer policy
decision about JFrog's Preview Agreement, not a technical limit: the binary
can be downloaded without its installer, and shell and MCP filtering work
without the agreement recorded (only document conversion needs it). The
question is whether running JFrog's preview binary in this project's CI is
acceptable under its terms. If it is, a job would download a pinned release,
check its SHA-256, and run the suite with no terms, so the document and
retrieve cases skip.

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Merge to `main` with CI green.
3. Tag `vX.Y.Z` and push it. The publish workflow re-runs the full matrix and
   checks the tag matches `package.json`.
4. Approve the `npm` environment deployment in the workflow run.
5. The job *stages* the release. Once npm's malware scan finishes, approve it
   at npmjs.com (package → Versions → Staged) or with
   `npm stage list pi-jfrog-boost` and `npm stage approve <id>`. Either way
   you'll get a 2FA prompt. Inspect the tarball first with
   `npm stage download <id>` if you want to.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
in stage-only mode. npm accepts a staged release only from this repository, via
`.github/workflows/publish.yml`, in the `npm` environment. There is no publish
token anywhere, and npm attaches provenance on its own. See
[SECURITY.md](SECURITY.md#supply-chain) for the full chain.

## Dependencies

`.npmrc` rejects git and remote-URL dependencies, and it fails the install on
any package whose install scripts haven't been reviewed. If a dependency update
adds one, CI fails with `install scripts not covered by allowScripts`. Check
what the script does, then record your decision:

```sh
npm install-scripts deny <pkg>      # the default answer: nothing here needs them
npm install-scripts approve <pkg>   # only if something breaks without it
```
