# Contributing

## Getting set up

```sh
npm install
npm run check                 # biome, tsc --noEmit, node:test
pi -e ./src/index.ts          # run pi against the working tree
```

You'll want the [Boost CLI](https://boost.jfrog.com/) installed to exercise
anything end to end. The unit tests don't need it — they drive stand-in binaries.
With it installed, `npm run test:e2e` runs pi's real tools through the real
extension and Boost binary.

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
- **Use Boost's agent-neutral surfaces.** The `boost hook <agent>` dialects
  stamp spans with the agent named by the subcommand, which mislabels pi. See
  the comment at the top of `src/tools.ts`.

## Tests

`node:test`, no framework. Pure logic gets unit tests; anything involving
process behaviour (timeouts, non-zero exits, a boost that closes stdin early)
drives a real child process, because a stubbed `spawn` would only prove the stub
works. Those are POSIX-only and skip on Windows.

`test/e2e.test.ts` is the exception to stand-ins: pi's real `read`, `bash`, and
`find` tools, the real extension, and the real Boost binary. It checks the
assumptions everything else rests on — what pi's tools actually return, what
Boost actually does with it — and asserts only what this integration
guarantees, not how much a given Boost release compresses. It skips when Boost
is not installed; `npm run test:e2e` makes a missing Boost a failure instead.
Run it before a release, and whenever pi or Boost changes version.

CI runs the suite on Linux and Windows across Node 22.19 and 24. The Boost
installer asks the user to accept JFrog's preview agreement, so CI cannot
install Boost and the end-to-end suite skips there.

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
