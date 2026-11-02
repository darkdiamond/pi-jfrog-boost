#!/usr/bin/env node
/**
 * `npm run test:e2e:min`: the hermetic e2e suite against the oldest supported
 * pi (0.86.1) instead of the devDependency (1.x).
 *
 * The two lines differ where it matters most to this extension — pi 1.x
 * returns a failing command as an `isError` result with `structuredContent`,
 * 0.86 throws — so "works on 1.2" says little about 0.86. The working tree is
 * copied into a temp directory and pi 0.86.1 installed there with
 * `--no-save`, so neither package.json, the lockfile nor node_modules here
 * change. Install scripts stay off, as in CI.
 *
 *   node scripts/e2e-min.mjs           e2e only (PI_BOOST_E2E=1)
 *   node scripts/e2e-min.mjs --check   typecheck + unit tests too, like CI's min leg
 *
 * Everything the e2e suite needs from the environment (BOOST_BIN,
 * BOOST_E2E_TERMS_FROM, …) passes through; the suite builds its own hermetic
 * HOME. PI_MIN_VERSION overrides the version under test.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_PI = process.env.PI_MIN_VERSION || "0.86.1";
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd, env = process.env) {
	process.stderr.write(`\n$ ${command} ${args.join(" ")}\n`);
	// npm.cmd needs a shell on Windows; the arguments here are all fixed.
	const result = spawnSync(command, args, {
		cwd,
		env,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
	}
}

const work = mkdtempSync(join(tmpdir(), "pi-boost-min-"));
let failed = false;
try {
	for (const entry of [
		"package.json",
		"package-lock.json",
		".npmrc",
		"tsconfig.json",
		"settings.schema.json",
		"src",
		"skills",
		"test",
	]) {
		if (existsSync(join(repo, entry))) cpSync(join(repo, entry), join(work, entry), { recursive: true });
	}
	run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], work);
	run(
		npm,
		[
			"install",
			"--no-save",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			`@earendil-works/pi-coding-agent@${MIN_PI}`,
		],
		work,
	);
	const spy = ["--import", "./test/helpers/spawn-spy.ts"];
	if (check) {
		run(process.execPath, [join(work, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], work);
		run(process.execPath, [...spy, "--test", "test/*.test.ts"], work);
	}
	run(process.execPath, [...spy, "--test", "test/e2e.test.ts", "test/session.e2e.test.ts"], work, {
		...process.env,
		PI_BOOST_E2E: "1",
	});
} catch (error) {
	failed = true;
	process.stderr.write(`\ne2e-min: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
