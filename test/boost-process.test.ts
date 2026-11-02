/**
 * The process layer against real child processes (the Node stand-in), since
 * what it guards against — hangs, aborts, floods, early exits — are process
 * behaviours a stubbed `spawn` cannot reproduce.
 */
import "./helpers/spawn-spy.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createProcessRunner, type RunOptions } from "../src/boost-process.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-boost.mjs");
const launcher = (exe: string) => ({ file: process.execPath, args: [exe] });
const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-proc-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

let logs = 0;
const logFile = () => join(root, `proc-${logs++}.jsonl`);

function options(env: NodeJS.ProcessEnv = {}, extra: Partial<RunOptions> = {}): RunOptions {
	return {
		cwd: root,
		env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT, ...env },
		timeoutMs: 10_000,
		maxStdout: 1024 * 1024,
		...extra,
	};
}

/** Whether a process id is still alive. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 5));
	}
	return predicate();
}

/** The pid the stand-in logged once it had read its stdin. */
async function loggedPid(log: string): Promise<number> {
	assert.ok(await until(() => existsSync(log) && readFileSync(log, "utf8").includes("\n"), 5_000));
	const first = readFileSync(log, "utf8").split("\n")[0] ?? "{}";
	return (JSON.parse(first) as { pid: number }).pid;
}

test("a run returns code, stdout, duration and no flags", async () => {
	let tick = 0;
	const runner = createProcessRunner({ launcher, now: () => (tick += 40) });
	const result = await runner.run(
		FAKE,
		[],
		options({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "ok" }),
	);
	assert.deepEqual(result, { code: 0, stdout: "ok", ms: 40, timedOut: false, aborted: false });
});

test("abort kills the child within 100 ms and resolves as aborted", async () => {
	const runner = createProcessRunner({ launcher });
	const log = logFile();
	const controller = new AbortController();
	const pending = runner.run(
		FAKE,
		[],
		options({ FAKE_BOOST_MODE: "hang", FAKE_BOOST_LOG: log }, { signal: controller.signal }),
	);
	const pid = await loggedPid(log);
	assert.ok(alive(pid), "the child is running before the abort");
	const aborted = performance.now();
	controller.abort();
	const result = await pending;
	assert.equal(result.aborted, true);
	assert.equal(result.timedOut, false);
	assert.equal(result.stdout, "");
	assert.ok(await until(() => !alive(pid), 100), "the child outlived the abort by more than 100 ms");
	assert.ok(performance.now() - aborted < 1_000);
	assert.equal(runner.active(), 0, "its slot is free again");
});

test("an already-aborted signal never spawns", async () => {
	const runner = createProcessRunner({ launcher });
	const log = logFile();
	const result = await runner.run(
		FAKE,
		[],
		options({ FAKE_BOOST_LOG: log }, { signal: AbortSignal.abort() }),
	);
	assert.equal(result.aborted, true);
	assert.equal(result.ms, 0);
	assert.equal(existsSync(log), false);
});

test("the 5th concurrent call returns busy at once and is never queued", async () => {
	const runner = createProcessRunner({ launcher });
	const log = logFile();
	const hung = Array.from({ length: 4 }, () =>
		runner.run(FAKE, [], options({ FAKE_BOOST_MODE: "hang", FAKE_BOOST_LOG: log })),
	);
	assert.equal(runner.active(), 4);
	const started = performance.now();
	const fifth = await runner.run(FAKE, [], options({ FAKE_BOOST_LOG: log }));
	assert.equal(fifth.busy, true);
	assert.equal(fifth.code, null);
	assert.ok(performance.now() - started < 50, "busy is answered immediately");
	runner.killAll();
	const results = await Promise.all(hung);
	assert.ok(
		results.every((r) => r.aborted),
		"killAll ends the hung ones as aborted",
	);
	assert.equal(runner.active(), 0);
	const after = await runner.run(FAKE, ["version"], options());
	assert.equal(after.code, 0, "a slot frees up once a child settles");
});

test("a hung child is killed at the timeout", async () => {
	const runner = createProcessRunner({ launcher });
	const log = logFile();
	const pending = runner.run(
		FAKE,
		[],
		options({ FAKE_BOOST_MODE: "hang", FAKE_BOOST_LOG: log }, { timeoutMs: 300 }),
	);
	const pid = await loggedPid(log);
	const result = await pending;
	assert.equal(result.timedOut, true);
	assert.equal(result.aborted, false);
	assert.ok(await until(() => !alive(pid), 1_000), "the timed-out child was not killed");
});

test("stdout over the cap is abandoned: the child is killed and nothing is used", async () => {
	const runner = createProcessRunner({ launcher });
	const result = await runner.run(
		FAKE,
		[],
		options(
			{ FAKE_BOOST_MODE: "huge-output", FAKE_BOOST_BYTES: String(256 * 1024) },
			{ maxStdout: 64 * 1024 },
		),
	);
	assert.equal(result.overflow, true);
	assert.equal(result.stdout, "");
	assert.equal(result.code, null);
});

test("output exactly at the cap is kept", async () => {
	const runner = createProcessRunner({ launcher });
	const result = await runner.run(
		FAKE,
		[],
		options(
			{ FAKE_BOOST_MODE: "huge-output", FAKE_BOOST_BYTES: String(64 * 1024) },
			{ maxStdout: 64 * 1024 },
		),
	);
	assert.equal(result.code, 0);
	assert.equal(result.stdout.length, 64 * 1024);
});

test("an early exit does not crash the process with EPIPE", async () => {
	const runner = createProcessRunner({ launcher });
	const result = await runner.run(
		FAKE,
		[],
		options({ FAKE_BOOST_NO_STDIN: "1" }, { input: "x".repeat(2 * 1024 * 1024) }),
	);
	assert.equal(result.code, 0);
});

test("multi-byte characters split across chunks decode intact", async () => {
	const runner = createProcessRunner({ launcher });
	const text = "€".repeat(100_000);
	const result = await runner.run(FAKE, [], options({ FAKE_BOOST_MODE: "echo" }, { input: text }));
	assert.equal(result.stdout, text);
});

test("a binary that cannot start is a spawn error, not a throw", async () => {
	const runner = createProcessRunner();
	const result = await runner.run(join(root, "no-such-boost"), [], options());
	assert.equal(result.spawnError, true);
	assert.equal(result.code, null);
	assert.equal(runner.active(), 0);
});

test("a child killed by a signal it was not sent is reported as such", {
	skip: process.platform === "win32" && "Windows has no POSIX signals to die from",
}, async () => {
	const runner = createProcessRunner({ launcher });
	const result = await runner.run(FAKE, [], options({ FAKE_BOOST_MODE: "crash" }));
	assert.equal(result.killedBy, "SIGKILL");
	assert.equal(result.timedOut, false);
	assert.equal(result.aborted, false);
});

test("detached children report their exit, and a watchdog kills a hung one", async () => {
	const runner = createProcessRunner({ launcher });
	// The child and watchdog are unref'd so they never keep pi alive; keep the
	// test's loop alive while it waits.
	const keep = setInterval(() => {}, 1_000);
	try {
		const ok = await new Promise((resolve) =>
			runner.detached(FAKE, ["sync"], { env: options().env, onExit: resolve }),
		);
		assert.equal(ok, 0);
		const started = Date.now();
		const hung = await new Promise((resolve) =>
			runner.detached(FAKE, [], {
				env: { ...options().env, FAKE_BOOST_MODE: "hang" },
				input: "",
				watchdogMs: 200,
				onExit: resolve,
			}),
		);
		assert.equal(hung, null);
		assert.ok(Date.now() - started < 5_000);
		assert.equal(runner.active(), 0, "detached children do not take foreground slots");
	} finally {
		clearInterval(keep);
	}
});

test("detached children are spawned detached and hidden on every platform", () => {
	// On Windows only `detached: true` keeps the child out of the job object
	// libuv kills when pi exits, so the shutdown `boost sync` survives pi.
	const seen: Array<Record<string, unknown>> = [];
	let unrefd = false;
	const spawn = ((_file: string, _args: readonly string[], options: Record<string, unknown>) => {
		seen.push(options);
		return { on: () => {}, unref: () => (unrefd = true), stdin: null };
	}) as unknown as typeof import("node:child_process").spawn;
	createProcessRunner({ launcher, spawn }).detached(FAKE, ["sync"], { env: options().env });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.detached, true);
	assert.equal(seen[0]?.windowsHide, true);
	assert.ok(unrefd, "the child is unref'd so it never keeps pi alive");
});
