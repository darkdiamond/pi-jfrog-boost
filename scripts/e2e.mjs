#!/usr/bin/env node
/**
 * `npm run test:e2e`: the hermetic e2e suite against the installed pi.
 *
 * Exists only to set PI_BOOST_E2E=1 portably. The POSIX `VAR=1 cmd` prefix
 * an npm script would use fails under cmd.exe, so Windows contributors could
 * not run the suite; `test:e2e:min` (scripts/e2e-min.mjs) does the same for
 * the same reason. Everything else the suite reads from the environment
 * (BOOST_BIN, BOOST_E2E_TERMS_FROM, BOOST_E2E_HOME, PI_BOOST_E2E_STRICT)
 * passes through unchanged; the suite builds its own hermetic HOME.
 */
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(
	process.execPath,
	["--import", "./test/helpers/spawn-spy.ts", "--test", "test/e2e.test.ts"],
	{ cwd: repo, env: { ...process.env, PI_BOOST_E2E: "1" }, stdio: "inherit" },
);
if (result.error) process.stderr.write(`e2e: ${result.error.message}\n`);
process.exitCode = result.status ?? 1;
