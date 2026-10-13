/**
 * These drive a real child process rather than a stubbed `spawn`: the failures
 * that matter here — a boost that exits before reading stdin, one that hangs,
 * one that prints something other than JSON — are process behaviours, and a
 * stub would only prove the stub works.
 *
 * The stand-in is `test/fixtures/fake-boost.mjs`, run as
 * `node fake-boost.mjs <args>` through the client's injectable launcher and
 * scripted per test through `FAKE_BOOST_*` variables. Being Node rather than
 * `#!/bin/sh`, it runs on Windows too, so this suite runs on every OS in CI.
 */
import "./helpers/spawn-spy.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	type BoostClientDeps,
	createBoostClient,
	isFilterable,
	MAX_PAYLOAD_BYTES,
} from "../src/boost-client.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-boost.mjs");
const launcher = (exe: string) => ({ file: process.execPath, args: [exe] });

const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-"));
after(() => rmSync(root, { recursive: true, force: true }));

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
		platform: "linux",
		home: root,
		resolveBinary: () => binary,
		launcher,
		...deps,
	});
}

const meta = { session_id: "s1", cwd: root };

test("the filter returns compacted text", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "compacted\n" });
	assert.equal(await client.filter(meta, {}, "long\noutput"), "compacted\n");
});

test("text Boost leaves unchanged is reported as unchanged", async () => {
	assert.equal(await clientFor({ FAKE_BOOST_MODE: "echo" }).filter(meta, {}, "unchanged"), undefined);
});

test("the output actually reaches boost on stdin, with no arguments", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "c", FAKE_BOOST_LOG: log });
	await client.filter(meta, {}, "the original output");
	const filter = invocations(log).find((call) => call.argv[0] !== "version");
	assert.deepEqual(filter?.argv, []);
	assert.equal(filter?.stdin, "the original output");
});

test("BOOST_HOOK_META identifies the session as pi, which is how Boost attributes it", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "c", FAKE_BOOST_LOG: log });
	await client.filter({ ...meta, tool_use_id: "call-7" }, { command: "ls" }, "output");
	const filter = invocations(log).find((call) => call.argv[0] !== "version");
	assert.equal(filter?.env.BOOST_AGENT_TYPE, "pi");
	const parsed = JSON.parse(filter?.env.BOOST_HOOK_META ?? "{}");
	assert.equal(parsed.agent_type, "pi");
	assert.equal(parsed.session_id, "s1");
	assert.equal(parsed.tool_use_id, "call-7");
	assert.deepEqual(parsed.tool_input, { command: "ls" });
});

test("a boost that exits before reading stdin does not crash the process", async () => {
	// Reproduces the EPIPE on child.stdin that an unguarded `end()` turns into
	// an unhandled stream error, which would take pi down with it.
	const client = clientFor({ FAKE_BOOST_NO_STDIN: "1" });
	assert.equal(await client.filter(meta, {}, "x".repeat(2 * 1024 * 1024)), undefined);
});

test("a non-zero exit is a pass-through, not an error", async () => {
	const client = clientFor({
		FAKE_BOOST_MODE: "compact-to",
		FAKE_BOOST_OUTPUT: "compacted",
		FAKE_BOOST_EXIT: "3",
	});
	assert.equal(await client.filter(meta, {}, "output"), undefined);
});

test("a hung boost is abandoned at the timeout and the original kept", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "hang" }, { timeouts: { hook: 300 } });
	const started = Date.now();
	assert.equal(await client.filter(meta, {}, "output"), undefined);
	// Generous bound: node start-up on a loaded Windows runner is slow, but a
	// hang that is never killed would hold this test until the runner's timeout.
	assert.ok(Date.now() - started < 5_000, "the hung child was not abandoned");
});

test("a slow boost inside its timeout still counts", async () => {
	const client = clientFor(
		{ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "compacted", FAKE_BOOST_SLEEP_MS: "200" },
		{ timeouts: { hook: 10_000 } },
	);
	assert.equal(await client.filter(meta, {}, "output"), "compacted");
});

test("a reply over the payload ceiling is abandoned as a malfunction", async () => {
	const client = clientFor({
		FAKE_BOOST_MODE: "huge-output",
		FAKE_BOOST_BYTES: String(MAX_PAYLOAD_BYTES + 1024),
	});
	assert.equal(await client.filter(meta, {}, "output"), undefined);
});

test("boost read returns extracted text, and nothing when there is none", async () => {
	const log = logFile();
	const extracting = clientFor({ FAKE_BOOST_OUTPUT: "# Heading\n", FAKE_BOOST_LOG: log });
	assert.equal(await extracting.read(meta, "/a/report.pdf"), "# Heading\n");
	assert.deepEqual(invocations(log).at(-1)?.argv, ["read", "/a/report.pdf"]);

	assert.equal(await clientFor({ FAKE_BOOST_OUTPUT: "   " }).read(meta, "/a/report.pdf"), undefined);
	assert.equal(await clientFor({ FAKE_BOOST_EXIT: "1" }).read(meta, "/a/report.pdf"), undefined);
});

test("Boost's legacy-Office advisory (exit 1) is a pass-through", async () => {
	const client = clientFor({ FAKE_BOOST_MODE: "read-advisory" });
	assert.equal(await client.read(meta, "/a/old.doc"), undefined);
});

test("a Boost older than the documented protocol is never called", async () => {
	const log = logFile();
	const client = clientFor({
		FAKE_BOOST_VERSION: "boost v0.13.12",
		FAKE_BOOST_MODE: "compact-to",
		FAKE_BOOST_OUTPUT: "compacted",
		FAKE_BOOST_LOG: log,
	});
	assert.equal(await client.filter(meta, {}, "output"), undefined);
	assert.equal(await client.read(meta, "/a.pdf"), undefined);
	assert.deepEqual(
		invocations(log).map((call) => call.argv),
		[["version"]],
	);
});

test("a Boost whose version cannot be read is never called", async () => {
	const client = clientFor({ FAKE_BOOST_VERSION: "none", FAKE_BOOST_MODE: "compact-to" });
	assert.equal(await client.ready(), false);
});

test("the version probe runs once, however many calls follow", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "c", FAKE_BOOST_LOG: log });
	await Promise.all([
		client.filter(meta, {}, "a"),
		client.filter(meta, {}, "b"),
		client.filter(meta, {}, "c"),
	]);
	const calls = invocations(log);
	assert.equal(calls.filter((call) => call.argv[0] === "version").length, 1);
	assert.equal(calls.filter((call) => call.argv[0] !== "version").length, 3);
});

test("DISABLE_BOOST=1 stops every call without touching the binary", async () => {
	const log = logFile();
	const client = clientFor({ DISABLE_BOOST: "1", PI_BOOST_OBSERVE: "1", FAKE_BOOST_LOG: log });
	assert.equal(client.enabled(), false);
	assert.equal(client.observeEnabled(), false);
	assert.equal(await client.filter(meta, {}, "output"), undefined);
	assert.equal(await client.read(meta, "/a.pdf"), undefined);
	client.observeDetached(meta, {});
	client.sync(meta);
	assert.deepEqual(invocations(log), []);
});

test("lifecycle telemetry is off unless the user opts in", async () => {
	const log = logFile();
	const off = clientFor({ FAKE_BOOST_MODE: "hook-reply", FAKE_BOOST_LOG: log });
	assert.equal(off.observeEnabled(), false);
	assert.equal(await off.observe(meta, {}), undefined);
	off.observeDetached(meta, {});
	assert.deepEqual(
		invocations(log).filter((call) => call.argv[0] === "hook"),
		[],
	);

	const on = clientFor({ PI_BOOST_OBSERVE: "1", FAKE_BOOST_MODE: "hook-reply", FAKE_BOOST_REPLY: "{}" });
	assert.equal(on.observeEnabled(), true);
	assert.deepEqual(await on.observe(meta, { hook_event_name: "sessionStart" }), {});
});

test("a hook reply that is not JSON is ignored", async () => {
	const client = clientFor({
		PI_BOOST_OBSERVE: "1",
		FAKE_BOOST_MODE: "hook-reply",
		FAKE_BOOST_REPLY: "nope",
	});
	assert.equal(await client.observe(meta, { hook_event_name: "sessionStart" }), undefined);
});

test("with Boost not installed everything is a no-op", async () => {
	const client = clientFor({ PI_BOOST_OBSERVE: "1" }, { binary: undefined });
	assert.equal(client.binary(), undefined);
	assert.equal(await client.ready(), false);
	assert.equal(await client.filter(meta, {}, "output"), undefined);
	assert.equal(await client.read(meta, "/a.pdf"), undefined);
	assert.equal(await client.observe(meta, {}), undefined);
	client.observeDetached(meta, {});
	client.sync(meta);
	assert.deepEqual(await client.exec(["version"], root), { code: null, stdout: "" });
});

test("refresh re-resolves the binary after an install", async () => {
	let binary: string | undefined;
	const client = createBoostClient({
		env: { PATH: "", FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "compacted\n" },
		platform: "linux",
		home: root,
		resolveBinary: () => binary,
		launcher,
	});
	assert.equal(client.binary(), undefined);
	binary = FAKE;
	assert.equal(client.binary(), undefined, "resolution is cached until refresh");
	client.refresh();
	assert.equal(client.binary(), binary);
	assert.equal(await client.filter(meta, {}, "output"), "compacted\n");
});

test("the launcher decides how the resolved binary is started", async () => {
	const seen: string[] = [];
	const client = clientFor(
		{ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "compacted" },
		{
			launcher: (exe) => {
				seen.push(exe);
				return { file: process.execPath, args: [exe] };
			},
		},
	);
	assert.equal(await client.filter(meta, {}, "output"), "compacted");
	assert.deepEqual(seen, [FAKE, FAKE], "once for the version probe, once for the filter");
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
	assert.equal(await client.ready(), false);
	assert.deepEqual(await client.exec(["version"], root), { code: null, stdout: "" });
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
	assert.equal(result.code, null);
	assert.equal(result.stdout, "");
	// The default exec timeout is 60 s and would produce the same result, so
	// only the elapsed time proves the injected 300 ms one was used. Generous
	// for a slow Windows runner's node start-up.
	assert.ok(Date.now() - started < 5_000, "the injected exec timeout was ignored");
});

test("isFilterable rejects empty, binary, and oversized text", () => {
	assert.equal(isFilterable("hello"), true);
	assert.equal(isFilterable(""), false);
	assert.equal(isFilterable("has\0nul"), false);
	assert.equal(isFilterable("x".repeat(MAX_PAYLOAD_BYTES + 1)), false);
	assert.equal(isFilterable("x".repeat(MAX_PAYLOAD_BYTES)), true);
});

test("oversized output is passed through instead of piped to Boost", async () => {
	const log = logFile();
	const client = clientFor({ FAKE_BOOST_MODE: "compact-to", FAKE_BOOST_OUTPUT: "c", FAKE_BOOST_LOG: log });
	assert.equal(await client.filter(meta, {}, "x".repeat(MAX_PAYLOAD_BYTES + 1)), undefined);
	assert.deepEqual(invocations(log), []);
});
