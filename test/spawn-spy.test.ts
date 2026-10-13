/**
 * Self-test for the never-spawn guard: a guard that silently stopped
 * intercepting would let the suite pass while the extension ran
 * `boost retrieve` or `boost init` against someone's machine.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { createBoostClient } from "../src/boost-client.ts";
import { boostSubcommand, isForbiddenSpawn, takeViolations, violations } from "./helpers/spawn-spy.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-boost.mjs");

test("the forbidden set is exactly the state-mutating Boost commands", () => {
	for (const sub of ["retrieve", "feature-flags", "init", "filters"]) {
		assert.equal(isForbiddenSpawn([sub, "--x"]), true, sub);
	}
	for (const args of [
		[],
		["version"],
		["read", "a.pdf"],
		["hook", "claude"],
		["sync"],
		["-c", "boost retrieve 1"],
	]) {
		assert.equal(isForbiddenSpawn(args), false, args.join(" "));
	}
	assert.equal(isForbiddenSpawn(undefined), false);
});

test("the Node stand-in is judged by the argument after its script", () => {
	assert.equal(boostSubcommand([FAKE, "init"]), "init");
	assert.equal(isForbiddenSpawn([FAKE, "retrieve", "3"]), true);
	assert.equal(isForbiddenSpawn([FAKE, "version"]), false);
});

test("a forbidden spawn is blocked before it runs, through the ESM binding src/ uses", () => {
	assert.deepEqual(violations(), []);
	// The ESM named import, the same binding `src/boost-client.ts` holds.
	assert.throws(() => spawn(process.execPath, [FAKE, "init"]), /forbidden Boost command `.*init`/);
	assert.throws(() => spawnSync("boost", ["feature-flags", "refresh"]), /forbidden/);
	const caught = takeViolations();
	assert.equal(caught.length, 2);
	assert.deepEqual(caught[0]?.args.slice(1), ["init"]);
	assert.deepEqual(violations(), [], "taken violations no longer fail the process");
});

test("the fail-open client cannot hide a forbidden spawn", async () => {
	const client = createBoostClient({
		env: { PATH: process.env.PATH ?? "" },
		home: import.meta.dirname,
		resolveBinary: () => FAKE,
		launcher: (exe) => ({ file: process.execPath, args: [exe] }),
	});
	// The client swallows the spy's throw and fails open, exactly as it would
	// for a broken binary — the recorded violation is what fails the run.
	assert.deepEqual(await client.exec(["retrieve", "1"], import.meta.dirname), { code: null, stdout: "" });
	const caught = takeViolations();
	assert.equal(caught.length, 1);
	assert.deepEqual(caught[0]?.args.slice(1), ["retrieve", "1"]);
});

test("allowed spawns pass through untouched", () => {
	const result = spawnSync(process.execPath, [FAKE, "version"], { encoding: "utf8" });
	assert.equal(result.stdout, "boost v0.15.4\n");
	assert.deepEqual(violations(), []);
});
