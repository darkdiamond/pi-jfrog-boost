/**
 * Readiness (spec §8.1) and the breaker (§8.2), on a fake clock — plus one
 * readiness run against the real process layer, where a stalled `boost
 * version` has to fail the probe rather than hold up anything.
 */
import "./helpers/spawn-spy.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { BinaryStamp } from "../src/boost-binary.ts";
import { createBoostClient } from "../src/boost-client.ts";
import type { RunResult } from "../src/boost-process.ts";
import {
	BREAKER_MAX_MS,
	BREAKER_OPEN_MS,
	classifyCall,
	classifyProbe,
	createBreaker,
	createCounters,
	createReadiness,
	expectedMs,
	MISSING_RECHECK_MS,
	PROBE_BACKOFF_MS,
	processBreaker,
	type ReadinessDeps,
} from "../src/health.ts";
import { fixedConfig } from "./helpers/runtime.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-boost.mjs");
const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-health-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const ran = (over: Partial<RunResult> = {}): RunResult => ({
	code: 0,
	stdout: "",
	ms: 100,
	timedOut: false,
	aborted: false,
	...over,
});
const banner = (v: string) => ran({ stdout: `boost v${v}\n` });
const timeout = ran({ code: null, timedOut: true, ms: 8_000 });

/** Let queued promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A readiness over scripted probes, a fake clock and a mutable binary. */
function scripted(replies: RunResult[], init: { path?: string | undefined; enabled?: boolean } = {}) {
	const world = {
		now: 0,
		enabled: init.enabled ?? true,
		path: "path" in init ? init.path : "/bin/boost",
		stamp: { mtimeMs: 1, size: 100 } as BinaryStamp | undefined,
		probes: 0,
		resolves: 0,
	};
	const deps: ReadinessDeps = {
		enabled: () => world.enabled,
		resolve: () => {
			world.resolves++;
			return world.path;
		},
		stamp: () => (world.path ? world.stamp : undefined),
		probe: async () => {
			world.probes++;
			return replies.shift() ?? banner("0.15.4");
		},
		now: () => world.now,
	};
	return { readiness: createReadiness(deps), world };
}

test("probe outcomes: ready, too old, unknown version, not responding", () => {
	assert.deepEqual(classifyProbe(banner("0.15.4")), { kind: "ready", version: [0, 15, 4] });
	assert.deepEqual(classifyProbe(banner("0.12.1")), { kind: "too-old", version: [0, 12, 1] });
	assert.deepEqual(classifyProbe(ran({ stdout: "boost dev build" })), { kind: "unknown-version" });
	// A failed run with no banner is a failure that is retried, not a cached verdict.
	assert.deepEqual(classifyProbe(ran({ code: 1 })), { kind: "not-responding" });
	assert.deepEqual(classifyProbe(ran({ code: 2, stdout: "panic: boom" })), { kind: "not-responding" });
	assert.deepEqual(classifyProbe(timeout), { kind: "not-responding" });
	assert.deepEqual(classifyProbe(ran({ code: null, spawnError: true })), { kind: "not-responding" });
});

test("start() probes in the background; state is probing until it settles", async () => {
	const { readiness, world } = scripted([banner("0.15.4")]);
	assert.equal(readiness.state().kind, "probing", "nothing known yet");
	readiness.start();
	assert.equal(readiness.state().kind, "probing");
	assert.equal(world.probes, 1);
	await settle();
	assert.deepEqual(readiness.state(), { kind: "ready", version: [0, 15, 4] });
	assert.deepEqual(readiness.version(), [0, 15, 4]);
	readiness.start();
	readiness.check();
	assert.equal(world.probes, 1, "memoized while the binary is unchanged");
});

test("a failed probe is retried no sooner than 30 s, then 2 min, then every 10 min", async () => {
	const { readiness, world } = scripted([timeout, timeout, timeout, timeout, banner("0.15.4")]);
	readiness.start();
	await settle();
	assert.equal(readiness.state().kind, "not-responding");

	world.now = 29_999;
	readiness.check();
	assert.equal(world.probes, 1, "not before 30 s");
	world.now = 30_000;
	readiness.check();
	assert.equal(world.probes, 2, "retried at 30 s");
	await settle();

	world.now = 30_000 + 119_999;
	readiness.check();
	assert.equal(world.probes, 2, "second backoff is 2 min");
	world.now = 30_000 + 120_000;
	readiness.check();
	assert.equal(world.probes, 3);
	await settle();

	world.now += 599_999;
	readiness.check();
	assert.equal(world.probes, 3, "then 10 min");
	world.now += 1;
	readiness.check();
	assert.equal(world.probes, 4);
	await settle();
	world.now += 600_000;
	readiness.check();
	assert.equal(world.probes, 5, "and every 10 min after that");
	await settle();
	assert.equal(readiness.state().kind, "ready", "a later success makes it ready");
});

test("a fake binary stalling 5.2 s on `version` fails the probe, retried ≥ 30 s later", async () => {
	// The real process layer and the Node stand-in: `version` sleeps 5.2 s (the
	// F2 stall), longer than the probe's timeout — injected short here so the
	// test does not wait; production uses 8 s.
	const client = createBoostClient({
		env: {
			PATH: process.env.PATH ?? "",
			SYSTEMROOT: process.env.SYSTEMROOT,
			FAKE_BOOST_VERSION_SLEEP_MS: "5200",
		},
		home: root,
		resolveBinary: () => FAKE,
		launcher: (exe) => ({ file: process.execPath, args: [exe] }),
		timeouts: { version: 300 },
		config: fixedConfig().read,
	});
	let now = 0;
	let probes = 0;
	const readiness = createReadiness({
		enabled: () => true,
		resolve: () => client.binary(),
		stamp: () => ({ mtimeMs: 1, size: 1 }),
		probe: () => {
			probes++;
			return client.version();
		},
		now: () => now,
	});
	const started = Date.now();
	readiness.start();
	const state = await readiness.wait(10_000);
	assert.equal(state.kind, "not-responding");
	assert.ok(Date.now() - started < 5_000, "the stalled probe was cut off at its timeout");
	now = 29_000;
	readiness.check();
	assert.equal(probes, 1, "not retried within 30 s");
	now = 30_000;
	readiness.check();
	assert.equal(probes, 2, "retried at 30 s");
	await readiness.wait(10_000);
});

test("a changed binary stamp (Boost updated itself) triggers a re-probe", async () => {
	const { readiness, world } = scripted([banner("0.12.1"), banner("0.15.4")]);
	readiness.start();
	await settle();
	assert.equal(readiness.state().kind, "too-old");
	readiness.check();
	assert.equal(world.probes, 1, "too-old is cached while the stamp is unchanged");
	world.stamp = { mtimeMs: 2, size: 100 };
	readiness.check();
	assert.equal(world.probes, 2);
	await settle();
	assert.equal(readiness.state().kind, "ready");
});

test("unknown-version is cached until retry()", async () => {
	const { readiness, world } = scripted([ran({ stdout: "?" }), banner("0.15.4")]);
	readiness.start();
	await settle();
	assert.equal(readiness.state().kind, "unknown-version");
	world.now += 3_600_000;
	readiness.check();
	assert.equal(world.probes, 1);
	readiness.retry();
	assert.equal(world.probes, 2);
	await settle();
	assert.equal(readiness.state().kind, "ready");
});

test("a missing binary is looked for again at most every 60 s, and on every session start", () => {
	const { readiness, world } = scripted([], { path: undefined });
	readiness.start();
	assert.equal(readiness.state().kind, "missing");
	assert.equal(world.resolves, 1);
	world.now = MISSING_RECHECK_MS - 1;
	readiness.check();
	assert.equal(world.resolves, 1, "no filesystem search on every tool result");
	world.now = MISSING_RECHECK_MS;
	readiness.check();
	assert.equal(world.resolves, 2);
	readiness.start();
	assert.equal(world.resolves, 3, "session_start always looks");
	world.path = "/bin/boost";
	world.now += MISSING_RECHECK_MS;
	readiness.check();
	assert.equal(world.probes, 1, "found: probed");
});

test("a binary deleted after resolving is looked for again", async () => {
	const { readiness, world } = scripted([banner("0.15.4")]);
	readiness.start();
	await settle();
	world.path = undefined;
	readiness.check();
	assert.equal(readiness.state().kind, "missing");
	assert.equal(readiness.binary(), undefined);
});

test("disabled: nothing is resolved or probed", () => {
	const { readiness, world } = scripted([], { enabled: false });
	readiness.start();
	readiness.check();
	assert.deepEqual(readiness.state(), { kind: "disabled" });
	assert.equal(world.resolves + world.probes, 0);
});

test("lastKnown keeps what the last look found once Boost is turned off", () => {
	const never = scripted([], { enabled: false, path: undefined });
	never.readiness.start();
	assert.deepEqual(never.readiness.lastKnown(), { kind: "probing" }, "never looked: not claimed missing");

	const { readiness, world } = scripted([], { path: undefined });
	readiness.start();
	world.enabled = false;
	assert.deepEqual(readiness.state(), { kind: "disabled" });
	assert.deepEqual(readiness.lastKnown(), { kind: "missing" });
});

test("wait() is bounded and resolves at once when nothing is running", async () => {
	let release: ((r: RunResult) => void) | undefined;
	const readiness = createReadiness({
		enabled: () => true,
		resolve: () => "/b",
		stamp: () => ({ mtimeMs: 1, size: 1 }),
		probe: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	assert.equal((await readiness.wait(10_000)).kind, "probing", "nothing started: no wait");
	readiness.start();
	// wait()'s timer is unref'd so it never keeps pi alive; this test has
	// nothing else pending, so hold the loop open itself.
	const keep = setInterval(() => {}, 1_000);
	try {
		const started = Date.now();
		assert.equal((await readiness.wait(30)).kind, "probing");
		assert.ok(Date.now() - started < 1_000);
		release?.(banner("0.15.4"));
		assert.equal((await readiness.wait(1_000)).kind, "ready");
	} finally {
		clearInterval(keep);
	}
});

test("a probe refused as busy is forgotten, not counted as a failure", async () => {
	const { readiness, world } = scripted([ran({ code: null, busy: true })]);
	readiness.start();
	await settle();
	assert.equal(readiness.state().kind, "probing");
	readiness.check();
	assert.equal(world.probes, 2, "probed again on the next check, no backoff");
});

test("a probe killed at shutdown (aborted) is forgotten, not counted as a failure", async () => {
	const { readiness, world } = scripted([ran({ code: null, aborted: true })]);
	readiness.start();
	await settle();
	assert.equal(readiness.state().kind, "probing");
	readiness.check();
	assert.equal(world.probes, 2, "probed again on the next check, no 30 s backoff");
	await settle();
	assert.equal(readiness.state().kind, "ready");
});

test("a transient non-zero probe exit backs off and recovers instead of sticking", async () => {
	const { readiness, world } = scripted([ran({ code: 1 })]);
	readiness.start();
	await settle();
	assert.equal(readiness.state().kind, "not-responding");
	world.now = PROBE_BACKOFF_MS[0] as number;
	readiness.check();
	await settle();
	assert.equal(world.probes, 2);
	assert.equal(readiness.state().kind, "ready");
});

// ---------------------------------------------------------------------------
// Breaker

test("call classification: non-zero exit is not bad, abort is neutral", () => {
	assert.equal(classifyCall(ran({ code: 1 }), 0).outcome, "good");
	assert.equal(classifyCall(ran({ code: null, aborted: true, ms: 60_000 }), 0).outcome, "neutral");
	assert.equal(classifyCall(ran({ code: null, busy: true }), 0).outcome, "neutral");
	assert.deepEqual(classifyCall(timeout, 0), { outcome: "bad", reason: "timeout" });
	assert.deepEqual(classifyCall(ran({ code: null, spawnError: true }), 0), {
		outcome: "bad",
		reason: "error",
	});
	assert.deepEqual(classifyCall(ran({ code: null, killedBy: "SIGSEGV" }), 0), {
		outcome: "bad",
		reason: "killed",
	});
	assert.deepEqual(classifyCall(ran({ ms: 2_501 }), 0), { outcome: "bad", reason: "slow" });
	assert.equal(classifyCall(ran({ ms: 2_500 }), 0).outcome, "good", "the floor is 2.5 s");
	// 1 MiB: expected 300 + 4096 ms; slow above 3× that.
	assert.equal(expectedMs(1024 * 1024), 4_396);
	assert.equal(classifyCall(ran({ ms: 13_000 }), 1024 * 1024).outcome, "good");
	assert.equal(classifyCall(ran({ ms: 13_200 }), 1024 * 1024).outcome, "bad");
});

test("3 consecutive bad calls open the breaker for 5 min; a good one in between resets the count", () => {
	let now = 0;
	const breaker = createBreaker({ now: () => now });
	breaker.record(timeout, 0);
	breaker.record(timeout, 0);
	breaker.record(ran(), 0);
	breaker.record(timeout, 0);
	breaker.record(ran({ code: 2 }), 0);
	breaker.record(ran({ aborted: true, code: null }), 0);
	assert.equal(breaker.state().kind, "closed", "never three bad in a row");
	breaker.record(timeout, 0);
	breaker.record(ran({ ms: 9_000 }), 0);
	assert.equal(breaker.state().kind, "closed");
	breaker.record(ran({ code: null, spawnError: true }), 0);
	assert.deepEqual(breaker.state(), { kind: "open", until: BREAKER_OPEN_MS, reason: "error" });
	assert.equal(breaker.allow(), false);
	now = BREAKER_OPEN_MS - 1;
	assert.equal(breaker.allow(), false);
});

test("half-open lets exactly one trial through; a good trial closes", () => {
	let now = 0;
	const breaker = createBreaker({ now: () => now });
	for (let i = 0; i < 3; i++) breaker.record(timeout, 0);
	now = BREAKER_OPEN_MS;
	assert.equal(breaker.state().kind, "half-open");
	assert.equal(breaker.allow(), true, "the trial");
	assert.equal(breaker.allow(), false, "everyone else skips while it runs");
	assert.equal(breaker.allow(), false);
	breaker.record(ran(), 0);
	assert.equal(breaker.state().kind, "closed");
	assert.equal(breaker.allow(), true);
	assert.equal(breaker.allow(), true);
});

test("a bad trial re-opens with the duration doubled, capped at 30 min", () => {
	let now = 0;
	const breaker = createBreaker({ now: () => now });
	/** How long the breaker is open for, from now; undefined when it is not open. */
	const openFor = () => {
		const state = breaker.state();
		return state.kind === "open" ? state.until - now : undefined;
	};
	const opened: (number | undefined)[] = [];
	for (let i = 0; i < 3; i++) breaker.record(timeout, 0);
	opened.push(openFor());
	for (let round = 0; round < 4; round++) {
		const state = breaker.state();
		assert.equal(state.kind, "open");
		now = state.kind === "open" ? state.until : now;
		assert.equal(breaker.allow(), true);
		breaker.record(timeout, 0);
		opened.push(openFor());
	}
	assert.deepEqual(
		opened,
		[5, 10, 20, 30, 30].map((m) => m * 60_000),
	);
	assert.equal(BREAKER_MAX_MS, 30 * 60_000);
	// A good trial resets the duration back to 5 min for the next opening.
	const state = breaker.state();
	now = state.kind === "open" ? state.until : now;
	assert.equal(breaker.allow(), true);
	breaker.record(ran(), 0);
	for (let i = 0; i < 3; i++) breaker.record(timeout, 0);
	assert.equal(openFor(), BREAKER_OPEN_MS);
});

test("a neutral trial (abort) hands the trial to the next call", () => {
	let now = 0;
	const breaker = createBreaker({ now: () => now });
	for (let i = 0; i < 3; i++) breaker.record(timeout, 0);
	now = BREAKER_OPEN_MS;
	assert.equal(breaker.allow(), true);
	breaker.record(ran({ code: null, aborted: true }), 0);
	assert.equal(breaker.state().kind, "half-open");
	assert.equal(breaker.allow(), true, "a new trial");
});

test("reset() closes the breaker and forgets the history", () => {
	const breaker = createBreaker({ now: () => 0 });
	for (let i = 0; i < 3; i++) breaker.record(timeout, 0);
	breaker.reset();
	assert.equal(breaker.state().kind, "closed");
	breaker.record(timeout, 0);
	breaker.record(timeout, 0);
	assert.equal(breaker.state().kind, "closed", "the count started over");
});

test("counters tally skip reasons and errors per session", () => {
	const counters = createCounters();
	counters.skip("small");
	counters.skip("small");
	counters.skip("busy");
	counters.error("timeout");
	counters.error("killed", "SIGSEGV");
	assert.deepEqual(counters.skips(), { small: 2, busy: 1 });
	assert.deepEqual(counters.errors(), { timeout: 1, killed: 1 });
	assert.equal(counters.lastError(), "killed: SIGSEGV");
	counters.reset();
	assert.deepEqual(counters.skips(), {});
	assert.equal(counters.lastError(), undefined);
});

test("the default breaker is process-wide, so a pause outlives a session switch (§8.2)", () => {
	const breaker = processBreaker();
	assert.equal(processBreaker(), breaker, "the next instance gets the same one");
	assert.equal((globalThis as Record<symbol, unknown>)[Symbol.for("pi-jfrog-boost.breaker")], breaker);
});
