# Contributing

## Getting set up

```sh
npm install
npm run check                 # biome, tsc --noEmit, node:test
pi -e ./src/index.ts          # run pi against the working tree
```

You'll want the [Boost CLI](https://boost.jfrog.com/) installed to exercise
anything end to end. The unit tests don't need it — they drive stand-in binaries.

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

CI runs the suite on Linux and Windows across Node 22.19 and 24.

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Merge to `main` with CI green.
3. Tag `vX.Y.Z` and push it. The publish workflow re-runs the full matrix,
   checks the tag matches `package.json`, and publishes.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm is configured to accept releases from this repository via
`.github/workflows/publish.yml`, and the OIDC token GitHub mints for that run is
exchanged for a short-lived credential. There is no publish token in the repo's
secrets, and npm attaches provenance on its own.
