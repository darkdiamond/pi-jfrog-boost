/**
 * These drive a real child process rather than a stubbed `spawn`: the failures
 * that matter here — a boost that exits before reading stdin, one that hangs,
 * one that prints something other than expected — are process behaviours, and
 * a stub would only prove the stub works.
 *
 * The stand-in is `test/fixtures/fake-boost.mjs`, run as
 * `node fake-boost.mjs <args>` through the client's injectable launcher and
 * scripted per test through `FAKE_BOOST_*` variables. Being Node rather than
 * `#!/bin/sh`, it runs on Windows too, so this suite runs on every OS in CI.
 *
 * The process layer itself (abort, busy, caps) has its own suite,
 * boost-process.test.ts; this one is about what the client sends and in
 * which environment (spec §8.3, §8.5).
 */
import "./helpers/spawn-spy.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	type BoostClientDeps,
	createBoostClient,
	filterTimeoutMs,
	type HookMeta,
	MAX_INPUT_BYTES,
} from "../src/boost-client.ts";
import { FLAGS_TTL, parseGoDuration } from "../src/boost-config.ts";
import { createProcessRunner, type ProcessRunner, type RunResult } from "../src/boost-process.ts";
import { createBreaker } from "../src/health.ts";
import { fixedConfig } from "./helpers/runtime.ts";
import { removeTempDir } from "./helpers/tmp.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-boost.mjs");
const launcher = (exe: string) => ({ file: process.execPath, args: [exe] });
/** A config whose flags were fetched an hour before {@link NOW}: no FLAGS_DISABLE needed (F2). */
const FRESH = fixedConfig('[feature_flags._metadata]\nlast_updated_at = "2026-10-01T00:00:00Z"\n');
/** The wall clock the clients below see. */
const NOW = Date.parse("2026-10-01T01:00:00Z");

const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-"));
after(() => removeTempDir(root));

let logs = 0;
/** A fresh invocation log for one test. */
function logFile(): string {
	return join(root, `log-${logs++}.jsonl`);
}

interface Invocation {
	argv: string[];
	stdin: string | null;
	cwd: string;
	env: Record<string, string>;
}

function invocations(log: string): Invocation[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Invocation);
}

/**
 * A client whose binary is the Node stand-in, unless `extra.binary` says
 * otherwise. `env` is both the client's environment and therefore the
 * child's, which is how each test scripts the stand-in.
 */
function clientFor(
	env: NodeJS.ProcessEnv = {},
	extra: Partial<BoostClientDeps> & { binary?: string | undefined } = {},
) {
	// `in`, not a destructuring default: an explicit `binary: undefined` means
	// "Boost is not installed" and must not fall back to the stand-in.
	const { binary: _binary, ...deps } = extra;
	const binary = "binary" in extra ? extra.binary : FAKE;
	return createBoostClient({
		env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT, ...env },
		platform: process.platform,
		home: root,
		resolveBinary: () => binary,
		launcher,
		config: FRESH.read,
		wallClock: () => NOW,
		...deps,
	});
}

const meta: HookMeta = { session_id: "s1", cwd: root };

/**
 * Wait for a detached child's exit. The child and its watchdog are unref'd on
 * purpose — they must never keep pi alive — so without this ref'd timer node
 * would see nothing left to wait for and end the test early.
 */
function exitOf(start: (onExit: (code: number | null) => void) => void): Promise<number | null> {
	const alive = setInterval(() => {}, 1_000);
	return new Promise<number | null>((resolve) => start(resolve)).finally(() => clearInterval(alive));
}

test("the client has no surface that mutates Boost's state", () => {
	const client = clientFor();
	for (const name of ["retrieve", "featureFlags", "init", "filters", "read", "observe", "ready"]) {
		assert.equal(name in client, false, name);
	}
});

test("the filter pipes the text to `boost` on stdin, with no arguments", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "c\n", FAKE_BOOST_LOG: log });
	const result = await client.filter(meta, "the original output");
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "c\n");
	const [only] = invocations(log);
	assert.deepEqual(only?.argv, []);
	assert.equal(only?.stdin, "the original output");
});

test("BOOST_HOOK_META identifies the session as pi, which is how Boost attributes it", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "c", FAKE_BOOST_LOG: log });
	await client.filter({ ...meta, tool_use_id: "call-7" }, "output", { toolInput: { command: "ls" } });
	const [only] = invocations(log);
	assert.equal(only?.env.BOOST_AGENT_TYPE, "pi");
	assert.deepEqual(JSON.parse(only?.env.BOOST_HOOK_META ?? "{}"), {
		agent_type: "pi",
		session_id: "s1",
		cwd: root,
		tool_use_id: "call-7",
		tool_input: { command: "ls" },
	});
});

test("a huge tool_input is left out of BOOST_HOOK_META rather than failing the spawn", () => {
	const env = clientFor().childEnv("filter", meta, { command: "x".repeat(200_000) });
	const hookMeta = JSON.parse(env.BOOST_HOOK_META ?? "{}");
	assert.equal(hookMeta.tool_input, undefined);
	assert.equal(hookMeta.session_id, "s1");
});

test("a non-zero exit is reported, not thrown", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "x", FAKE_BOOST_EXIT: "3" });
	const result = await client.filter(meta, "output");
	assert.equal(result.code, 3);
});

test("a boost that exits before reading stdin does not crash the process", async () => {
	// Reproduces the EPIPE on child.stdin that an unguarded `end()` turns into
	// an unhandled stream error, which would take pi down with it.
	const client = clientFor({ FAKE_BOOST_NO_STDIN: "1" });
	const result = await client.filter(meta, "x".repeat(MAX_INPUT_BYTES));
	assert.equal(result.code, 0);
});

test("a hung boost is abandoned at the timeout", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "hang" }, { timeouts: { filter: 300 } });
	const started = Date.now();
	const result = await client.filter(meta, "output");
	assert.equal(result.timedOut, true);
	assert.equal(result.stdout, "");
	// Generous bound: node start-up on a loaded Windows runner is slow, but a
	// hang that is never killed would hold this test until the runner's timeout.
	assert.ok(Date.now() - started < 5_000, "the hung child was not abandoned");
});

test("filter and MCP timeouts scale with input: min(10 s, 3 s + 4 ms/KiB)", () => {
	assert.equal(filterTimeoutMs(0), 3_000);
	assert.equal(filterTimeoutMs(100 * 1024), 3_400);
	assert.equal(filterTimeoutMs(MAX_INPUT_BYTES), 7_096);
	assert.equal(filterTimeoutMs(4 * MAX_INPUT_BYTES), 10_000);
});

test("input over 1 MiB is passed through without spawning", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_LOG: log });
	const result = await client.filter(meta, "x".repeat(MAX_INPUT_BYTES + 1));
	assert.equal(result.skipped, "large");
	assert.equal((await client.mcp(meta, "x".repeat(MAX_INPUT_BYTES + 1))).skipped, "large");
	assert.deepEqual(invocations(log), []);
});

test("a call may raise its own stdin ceiling: the full-output re-filter's 2 MiB", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_LOG: log });
	const text = "x".repeat(MAX_INPUT_BYTES + 1);
	const raised = await client.filter(meta, text, { maxInputBytes: 2 * MAX_INPUT_BYTES });
	assert.equal(raised.skipped, undefined);
	assert.equal(raised.code, 0);
	assert.equal(invocations(log).length, 1);
	const over = await client.filter(meta, `${text}${text}`, { maxInputBytes: 2 * MAX_INPUT_BYTES });
	assert.equal(over.skipped, "large");
});

test("a reply over the stdout cap is abandoned as a malfunction", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "huge-output", FAKE_BOOST_BYTES: String(3 * 1024 * 1024) });
	const result = await client.filter(meta, "output");
	assert.equal(result.overflow, true);
	assert.equal(result.stdout, "");
});

test("convert runs `boost read -- <path>`, so a dash-named file is not a flag", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_OUTPUT: "# Heading\n", FAKE_BOOST_LOG: log });
	const result = await client.convert(meta, "/a/-v.pdf");
	assert.equal(result.stdout, "# Heading\n");
	assert.deepEqual(invocations(log).at(-1)?.argv, ["read", "--", "/a/-v.pdf"]);
});

test("Boost's legacy-Office advisory comes back as a non-zero exit with its text", async () => {
	const result = await clientFor({ FAKE_BOOST_MODE: "read-advisory" }).convert(meta, "/a/old.doc");
	assert.equal(result.code, 1);
	assert.match(result.stdout, /^\[boost\] old\.doc/);
});

test("mcp runs `boost hook claude` with the payload on stdin", async () => {
	const log = logFile();
	const client = clientFor({
		FAKE_BOOST_MODE: "hook-reply",
		FAKE_BOOST_REPLY: '{"ok":1}',
		FAKE_BOOST_LOG: log,
	});
	const result = await client.mcp(meta, '{"hook_event_name":"PostToolUse"}');
	assert.equal(result.stdout, '{"ok":1}');
	const [only] = invocations(log);
	assert.deepEqual(only?.argv, ["hook", "claude"]);
	assert.equal(only?.stdin, '{"hook_event_name":"PostToolUse"}');
});

// ---------------------------------------------------------------------------
// The child environment (spec §8.3)

test("filter, convert, mcp and observe get a 24 h flag TTL unless the user set one", () => {
	const client = clientFor();
	for (const surface of ["filter", "convert", "mcp", "observe", "exec"] as const) {
		assert.equal(client.childEnv(surface, meta).BOOST_FEATURE_FLAGS_TTL, FLAGS_TTL, surface);
	}
	const own = clientFor({ BOOST_FEATURE_FLAGS_TTL: "1h" });
	assert.equal(own.childEnv("filter", meta).BOOST_FEATURE_FLAGS_TTL, "1h", "the user's TTL is kept");
});

test("the TTL actually reaches the child", async () => {
	const log = logFile();
	await clientFor({ FAKE_BOOST_LOG: log }).filter(meta, "x");
	assert.equal(invocations(log)[0]?.env.BOOST_FEATURE_FLAGS_TTL, "24h");
});

test("flag fetching is disabled when config.toml has no last_updated_at (F2)", async () => {
	const log = logFile();
	const stale = clientFor({ FAKE_BOOST_LOG: log }, { config: fixedConfig("[measurement]\n").read });
	await stale.filter(meta, "x");
	assert.equal(invocations(log)[0]?.env.BOOST_FEATURE_FLAGS_DISABLE, "1");
	for (const surface of ["filter", "convert", "mcp", "observe"] as const) {
		assert.equal(stale.childEnv(surface, meta).BOOST_FEATURE_FLAGS_DISABLE, "1", surface);
	}
	assert.equal(
		clientFor().childEnv("filter", meta).BOOST_FEATURE_FLAGS_DISABLE,
		undefined,
		"metadata present",
	);
	const userSet = clientFor({ BOOST_FEATURE_FLAGS_DISABLE: "0" }, { config: fixedConfig("").read });
	assert.equal(
		userSet.childEnv("filter", meta).BOOST_FEATURE_FLAGS_DISABLE,
		"0",
		"the user's choice is kept",
	);
});

test("flag fetching is also disabled when the metadata is older than the 24 h TTL", () => {
	const at = (hoursAgo: number) =>
		fixedConfig(
			`[feature_flags._metadata]\nlast_updated_at = "${new Date(NOW - hoursAgo * 3_600_000).toISOString()}"\n`,
		).read;
	assert.equal(
		clientFor({}, { config: at(23) }).childEnv("filter", meta).BOOST_FEATURE_FLAGS_DISABLE,
		undefined,
	);
	assert.equal(clientFor({}, { config: at(48) }).childEnv("filter", meta).BOOST_FEATURE_FLAGS_DISABLE, "1");
	assert.equal(
		clientFor({ BOOST_FEATURE_FLAGS_TTL: "720h" }, { config: at(48) }).childEnv("filter", meta)
			.BOOST_FEATURE_FLAGS_DISABLE,
		undefined,
		"a TTL the user set is theirs to manage",
	);
	// A shorter TTL of the user's own is honoured too: offline, `1h` against
	// 2-hour-old metadata would otherwise stall ~5 s on every call.
	assert.equal(
		clientFor({ BOOST_FEATURE_FLAGS_TTL: "1h" }, { config: at(2) }).childEnv("filter", meta)
			.BOOST_FEATURE_FLAGS_DISABLE,
		"1",
	);
	assert.equal(
		clientFor({ BOOST_FEATURE_FLAGS_TTL: "1h30m" }, { config: at(1) }).childEnv("filter", meta)
			.BOOST_FEATURE_FLAGS_DISABLE,
		undefined,
	);
	assert.equal(
		clientFor({ BOOST_FEATURE_FLAGS_TTL: "a day" }, { config: at(48) }).childEnv("filter", meta)
			.BOOST_FEATURE_FLAGS_DISABLE,
		undefined,
		"a TTL that cannot be parsed is left to the user and Boost",
	);
	const garbled = fixedConfig('[feature_flags._metadata]\nlast_updated_at = "yesterday"\n').read;
	assert.equal(clientFor({}, { config: garbled }).childEnv("filter", meta).BOOST_FEATURE_FLAGS_DISABLE, "1");
	assert.equal(
		clientFor({}, { config: at(48) }).childEnv("sync", meta).BOOST_FEATURE_FLAGS_DISABLE,
		undefined,
	);
});

test("parseGoDuration reads Go duration strings, as Boost does", () => {
	assert.equal(parseGoDuration("24h"), 86_400_000);
	assert.equal(parseGoDuration("1h30m"), 5_400_000);
	assert.equal(parseGoDuration("90s"), 90_000);
	assert.equal(parseGoDuration("1.5h"), 5_400_000);
	assert.equal(parseGoDuration("500ms"), 500);
	assert.equal(parseGoDuration("2m3.5s"), 123_500);
	assert.equal(parseGoDuration("0"), 0);
	for (const bad of ["", "24", "1d", "h", " 1h", "-1h", "1h-", "a day"]) {
		assert.equal(parseGoDuration(bad), undefined, bad);
	}
});

test("shell: on forces boost-cli-filtering, comma-merged into the user's list (F1)", () => {
	const on = clientFor({}, { shellMode: () => "on" });
	assert.equal(on.childEnv("filter", meta).BOOST_FEATURE_FLAGS_FORCE_ENABLED, "boost-cli-filtering");
	const merged = clientFor({ BOOST_FEATURE_FLAGS_FORCE_ENABLED: "a, b" }, { shellMode: () => "on" });
	assert.equal(merged.childEnv("convert", meta).BOOST_FEATURE_FLAGS_FORCE_ENABLED, "a,b,boost-cli-filtering");
	const already = clientFor(
		{ BOOST_FEATURE_FLAGS_FORCE_ENABLED: "boost-cli-filtering" },
		{ shellMode: () => "on" },
	);
	assert.equal(already.childEnv("mcp", meta).BOOST_FEATURE_FLAGS_FORCE_ENABLED, "boost-cli-filtering");
	for (const mode of ["auto", "off"] as const) {
		const env = clientFor({ BOOST_FEATURE_FLAGS_FORCE_ENABLED: "a" }, { shellMode: () => mode }).childEnv(
			"filter",
			meta,
		);
		assert.equal(env.BOOST_FEATURE_FLAGS_FORCE_ENABLED, "a", mode);
	}
});

test("the version probe disables flag fetching and nothing else", () => {
	const env = clientFor({}, { shellMode: () => "on", config: fixedConfig("").read }).childEnv("version");
	assert.equal(env.BOOST_FEATURE_FLAGS_DISABLE, "1");
	assert.equal(env.BOOST_FEATURE_FLAGS_TTL, undefined);
	assert.equal(env.BOOST_FEATURE_FLAGS_FORCE_ENABLED, undefined);
});

test("sync gets no flag overrides, so idle time is where Boost may refresh them", () => {
	const env = clientFor({}, { shellMode: () => "on", config: fixedConfig("").read }).childEnv("sync", meta);
	assert.equal(env.BOOST_FEATURE_FLAGS_TTL, undefined);
	assert.equal(env.BOOST_FEATURE_FLAGS_DISABLE, undefined);
	assert.equal(env.BOOST_FEATURE_FLAGS_FORCE_ENABLED, undefined);
	assert.equal(env.BOOST_AGENT_TYPE, "pi");
});

test("report and doctor get the TTL default only", () => {
	const env = clientFor({}, { shellMode: () => "on", config: fixedConfig("").read }).childEnv("exec");
	assert.equal(env.BOOST_FEATURE_FLAGS_TTL, "24h");
	assert.equal(env.BOOST_FEATURE_FLAGS_DISABLE, undefined);
	assert.equal(env.BOOST_FEATURE_FLAGS_FORCE_ENABLED, undefined);
});

// ---------------------------------------------------------------------------
// Kill switches, missing binary, breaker

for (const [name, value] of [
	["DISABLE_BOOST", "1"],
	["BOOST_DISABLED", "1"],
	["DISABLE_BOOST", "true"],
	["BOOST_DISABLED", "TRUE"],
] as const) {
	test(`${name}=${value} stops every call without touching the binary`, async () => {
		const log = logFile();
		const client = clientFor({ [name]: value, FAKE_BOOST_LOG: log });
		assert.equal((await client.filter(meta, "output")).skipped, "off");
		assert.equal((await client.convert(meta, "/a.pdf")).skipped, "off");
		assert.equal((await client.mcp(meta, "{}")).skipped, "off");
		client.observeDetached(meta, {});
		let exited: number | null | undefined;
		client.sync(meta, (code) => {
			exited = code;
		});
		assert.equal(exited, null, "sync reports that nothing ran");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(invocations(log), []);
	});
}

test("with Boost not installed everything is a no-op", async () => {
	const client = clientFor({}, { binary: undefined });
	assert.equal(client.binary(), undefined);
	assert.equal((await client.version()).skipped, "missing");
	assert.equal((await client.filter(meta, "output")).skipped, "missing");
	assert.equal((await client.convert(meta, "/a.pdf")).skipped, "missing");
	assert.equal((await client.exec(["version"], root)).skipped, "missing");
	client.observeDetached(meta, {});
	client.sync(meta);
});

test("refresh re-resolves the binary after an install", async () => {
	let binary: string | undefined;
	const client = createBoostClient({
		env: { PATH: "", FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "compacted\n" },
		home: root,
		resolveBinary: () => binary,
		launcher,
		config: FRESH.read,
	});
	assert.equal(client.binary(), undefined);
	binary = FAKE;
	assert.equal(client.binary(), undefined, "resolution is cached until refresh");
	client.refresh();
	assert.equal(client.binary(), binary);
	assert.equal((await client.filter(meta, "output")).stdout, "compacted\n");
});

test("an open breaker pauses filter, convert and mcp without spawning", async () => {
	const log = logFile();
	let now = 0;
	const breaker = createBreaker({ now: () => now });
	const client = clientFor(
		{ FAKE_BOOST_MODE: "hang", FAKE_BOOST_LOG: log },
		{ breaker, timeouts: { filter: 200 } },
	);
	for (let i = 0; i < 3; i++) assert.equal((await client.filter(meta, "x")).timedOut, true);
	assert.equal(breaker.state().kind, "open");
	const before = invocations(log).length;
	assert.equal((await client.filter(meta, "x")).skipped, "paused");
	assert.equal((await client.convert(meta, "/a.pdf")).skipped, "paused");
	assert.equal((await client.mcp(meta, "{}")).skipped, "paused");
	assert.equal(invocations(log).length, before);
	now += 5 * 60_000;
	assert.equal(breaker.state().kind, "half-open");
});

test("convert's slow budget scales with the file's size when the caller gives none (§8.2)", async () => {
	// Three 3 s conversions: ordinary for a 2 MiB PDF (expected ~8.5 s), slow
	// for a tiny file (floor 2.5 s). Only the latter may pause the surfaces.
	const big = join(root, "big.pdf");
	writeFileSync(big, Buffer.alloc(2 * 1024 * 1024));
	const tiny = join(root, "tiny.pdf");
	writeFileSync(tiny, "%PDF-1.7\n");
	const runner: ProcessRunner = {
		run: async (): Promise<RunResult> => ({
			code: 0,
			stdout: "text",
			ms: 3_000,
			timedOut: false,
			aborted: false,
		}),
		detached: () => {},
		active: () => 0,
		killAll: () => {},
	};
	const bigBreaker = createBreaker();
	const bigClient = clientFor({}, { runner, breaker: bigBreaker });
	for (let i = 0; i < 3; i++) await bigClient.convert(meta, big);
	assert.equal(bigBreaker.state().kind, "closed");

	const tinyBreaker = createBreaker();
	const tinyClient = clientFor({}, { runner, breaker: tinyBreaker });
	for (let i = 0; i < 3; i++) await tinyClient.convert(meta, tiny);
	assert.equal(tinyBreaker.state().kind, "open");

	// An explicit inputBytes still wins, and a path that cannot be stat'ed counts as 0 bytes.
	const explicit = createBreaker();
	const explicitClient = clientFor({}, { runner, breaker: explicit });
	for (let i = 0; i < 3; i++) await explicitClient.convert(meta, tiny, { inputBytes: 2 * 1024 * 1024 });
	assert.equal(explicit.state().kind, "closed");
	const gone = createBreaker();
	const goneClient = clientFor({}, { runner, breaker: gone });
	for (let i = 0; i < 3; i++) await goneClient.convert(meta, join(root, "no-such.pdf"));
	assert.equal(gone.state().kind, "open");
});

test("the version probe is not paused by the breaker", async () => {
	const breaker = createBreaker();
	const client = clientFor({}, { breaker });
	for (let i = 0; i < 3; i++)
		breaker.record({ code: null, stdout: "", ms: 0, timedOut: true, aborted: false }, 0);
	assert.equal(breaker.state().kind, "open");
	assert.equal((await client.version()).stdout, "boost v0.15.4\n");
});

// ---------------------------------------------------------------------------
// Detached surfaces and exec

test("sync runs `boost sync --max-batches 20` detached and reports its exit", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_LOG: log });
	const code = await exitOf((onExit) => client.sync(meta, onExit));
	assert.equal(code, 0);
	assert.deepEqual(invocations(log)[0]?.argv, ["sync", "--max-batches", "20"]);
});

test("a hung sync is killed by its watchdog", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "hang" }, { timeouts: { syncWatchdog: 200 } });
	const started = Date.now();
	const code = await exitOf((onExit) => client.sync(meta, onExit));
	assert.equal(code, null);
	assert.ok(Date.now() - started < 5_000);
});

test("observe sends the payload to `boost hook observe claude`, detached", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_LOG: log });
	client.observeDetached(meta, { hook_event_name: "sessionStart" });
	for (let i = 0; i < 50 && invocations(log).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
	const [only] = invocations(log);
	assert.deepEqual(only?.argv, ["hook", "observe", "claude"]);
	assert.deepEqual(JSON.parse(only?.stdin ?? "{}"), {
		agent_type: "pi",
		session_id: "s1",
		cwd: root,
		hook_event_name: "sessionStart",
	});
});

test("a hung observe is killed by its watchdog, 30 s by default", async () => {
	// The default bound, as handed to the runner.
	const seen: (number | undefined)[] = [];
	const spy: ProcessRunner = {
		run: async (): Promise<RunResult> => ({ code: 0, stdout: "", ms: 0, timedOut: false, aborted: false }),
		detached: (_exe, _args, options) => seen.push(options.watchdogMs),
		active: () => 0,
		killAll: () => {},
	};
	clientFor({}, { runner: spy }).observeDetached(meta, { hook_event_name: "sessionStart" });
	assert.deepEqual(seen, [30_000]);

	// And a real hung child is killed once it runs out: the client's runner,
	// wrapped only to hear the exit observe itself never asks for.
	const real = createProcessRunner({ launcher });
	let onExit: ((code: number | null) => void) | undefined;
	const runner: ProcessRunner = {
		...real,
		detached: (exe, args, options) => real.detached(exe, args, { ...options, ...(onExit ? { onExit } : {}) }),
	};
	const client = clientFor({ FAKE_BOOST_MODE: "hang" }, { runner, timeouts: { observeWatchdog: 200 } });
	const started = Date.now();
	const code = await exitOf((resolve) => {
		onExit = resolve;
		client.observeDetached(meta, { hook_event_name: "sessionStart" });
	});
	assert.equal(code, null);
	assert.ok(Date.now() - started < 5_000);
});

test("exec reports the exit code, stdout and the injected clock's elapsed time", async () => {
	let tick = 1_000;
	const client = clientFor({}, { now: () => (tick += 250) });
	const result = await client.exec(["version"], root);
	assert.equal(result.code, 0);
	assert.equal(result.stdout, "boost v0.15.4\n");
	assert.equal(result.ms, 250);
});

test("exec honours its timeout", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "hang" }, { timeouts: { exec: 300 } });
	const started = Date.now();
	const result = await client.exec(["doctor"], root);
	assert.equal(result.timedOut, true);
	// The default exec timeout is 30 s and would produce the same result, so
	// only the elapsed time proves the injected 300 ms one was used.
	assert.ok(Date.now() - started < 5_000, "the injected exec timeout was ignored");
});

test("a launcher that throws fails open", async () => {
	const client = clientFor(
		{},
		{
			launcher: () => {
				throw new Error("no such interpreter");
			},
		},
	);
	assert.equal((await client.version()).spawnError, true);
	assert.equal((await client.filter(meta, "x")).spawnError, true);
});
