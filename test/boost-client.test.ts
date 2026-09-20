/**
 * These drive a real child process rather than a stubbed `spawn`: the failures
 * that matter here — a boost that exits before reading stdin, one that hangs,
 * one that prints something other than JSON — are process behaviours, and a
 * stub would only prove the stub works.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBoostClient, isFilterable, MAX_PAYLOAD_BYTES } from "../src/boost-client.ts";

const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-"));
after(() => rmSync(root, { recursive: true, force: true }));

const VERSION_REPLY = `if [ "$1" = "version" ]; then echo "boost v0.13.24"; exit 0; fi`;

/** Write an executable stand-in for the boost binary and return its path. */
let created = 0;
function fakeBoost(body: string): string {
	const path = join(root, `boost-${created++}`);
	writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
	chmodSync(path, 0o755);
	return path;
}

function clientFor(binary: string | undefined, env: NodeJS.ProcessEnv = {}) {
	return createBoostClient({
		env: { PATH: process.env.PATH ?? "", ...env },
		platform: "linux",
		home: root,
		resolveBinary: () => binary,
	});
}

const meta = { session_id: "s1", cwd: root };

test("the filter returns compacted text", async () => {
	const binary = fakeBoost(`${VERSION_REPLY}\ncat >/dev/null\necho 'compacted'`);
	assert.equal(await clientFor(binary).filter(meta, {}, "long\noutput"), "compacted\n");
});

test("text Boost leaves unchanged is reported as unchanged", async () => {
	const binary = fakeBoost(`${VERSION_REPLY}\ncat`);
	assert.equal(await clientFor(binary).filter(meta, {}, "unchanged"), undefined);
});

test("the output actually reaches boost on stdin", async () => {
	const seen = join(root, "stdin.txt");
	const binary = fakeBoost(`${VERSION_REPLY}\ncat > ${seen}\necho compacted`);
	await clientFor(binary).filter(meta, {}, "the original output");
	assert.equal(readFileSync(seen, "utf8"), "the original output");
});

test("BOOST_HOOK_META identifies the session as pi, which is how Boost attributes it", async () => {
	const seen = join(root, "meta.json");
	const binary = fakeBoost(
		`${VERSION_REPLY}\ncat >/dev/null\nprintf '%s' "$BOOST_HOOK_META" > ${seen}\necho compacted`,
	);
	await clientFor(binary).filter({ ...meta, tool_use_id: "call-7" }, { command: "ls" }, "output");
	const parsed = JSON.parse(readFileSync(seen, "utf8"));
	assert.equal(parsed.agent_type, "pi");
	assert.equal(parsed.session_id, "s1");
	assert.equal(parsed.tool_use_id, "call-7");
	assert.deepEqual(parsed.tool_input, { command: "ls" });
});

test("a boost that exits before reading stdin does not crash the process", async () => {
	// Reproduces the EPIPE on child.stdin that an unguarded `end()` turns into
	// an unhandled stream error, which would take pi down with it.
	const binary = fakeBoost(`${VERSION_REPLY}\nexit 0`);
	assert.equal(await clientFor(binary).filter(meta, {}, "x".repeat(2 * 1024 * 1024)), undefined);
});

test("a non-zero exit is a pass-through, not an error", async () => {
	const binary = fakeBoost(`${VERSION_REPLY}\ncat >/dev/null\necho compacted\nexit 3`);
	assert.equal(await clientFor(binary).filter(meta, {}, "output"), undefined);
});

test("boost read returns extracted text, and nothing when there is none", async () => {
	const extracting = fakeBoost(`${VERSION_REPLY}\nif [ "$1" = "read" ]; then echo "# Heading"; fi`);
	assert.equal(await clientFor(extracting).read(meta, "/a/report.pdf"), "# Heading\n");

	const empty = fakeBoost(`${VERSION_REPLY}\nprintf '   '`);
	assert.equal(await clientFor(empty).read(meta, "/a/report.pdf"), undefined);

	const failing = fakeBoost(`${VERSION_REPLY}\nexit 1`);
	assert.equal(await clientFor(failing).read(meta, "/a/report.pdf"), undefined);
});

test("a Boost older than the documented protocol is never called", async () => {
	const probed = join(root, "probed.txt");
	const binary = fakeBoost(
		`echo "$1" >> ${probed}\nif [ "$1" = "version" ]; then echo "boost v0.13.12"; exit 0; fi\ncat >/dev/null\necho compacted`,
	);
	const client = clientFor(binary);
	assert.equal(await client.filter(meta, {}, "output"), undefined);
	assert.equal(await client.read(meta, "/a.pdf"), undefined);
	assert.equal(readFileSync(probed, "utf8").trim(), "version");
});

test("the version probe runs once, however many calls follow", async () => {
	const probed = join(root, "probe-count.txt");
	const binary = fakeBoost(
		`if [ "$1" = "version" ]; then echo x >> ${probed}; echo "boost v0.13.24"; exit 0; fi\ncat >/dev/null\necho compacted`,
	);
	const client = clientFor(binary);
	await Promise.all([
		client.filter(meta, {}, "a"),
		client.filter(meta, {}, "b"),
		client.filter(meta, {}, "c"),
	]);
	assert.equal(readFileSync(probed, "utf8").trim().split("\n").length, 1);
});

test("DISABLE_BOOST=1 stops every call without touching the binary", async () => {
	const ran = join(root, "should-not-exist.txt");
	const binary = fakeBoost(`touch ${ran}\necho compacted`);
	const client = clientFor(binary, { DISABLE_BOOST: "1", PI_BOOST_OBSERVE: "1" });
	assert.equal(client.enabled(), false);
	assert.equal(client.observeEnabled(), false);
	assert.equal(await client.filter(meta, {}, "output"), undefined);
	assert.equal(await client.read(meta, "/a.pdf"), undefined);
	client.observeDetached(meta, {});
	client.sync(meta);
	assert.equal(existsSync(ran), false);
});

test("lifecycle telemetry is off unless the user opts in", async () => {
	const ran = join(root, "observe-ran.txt");
	const binary = fakeBoost(`${VERSION_REPLY}\ntouch ${ran}\ncat >/dev/null\necho '{}'`);

	const off = clientFor(binary);
	assert.equal(off.observeEnabled(), false);
	assert.equal(await off.observe(meta, {}), undefined);
	off.observeDetached(meta, {});
	assert.equal(existsSync(ran), false);

	const on = clientFor(binary, { PI_BOOST_OBSERVE: "1" });
	assert.equal(on.observeEnabled(), true);
	assert.deepEqual(await on.observe(meta, { hook_event_name: "sessionStart" }), {});
});

test("with Boost not installed everything is a no-op", async () => {
	const client = clientFor(undefined, { PI_BOOST_OBSERVE: "1" });
	assert.equal(client.binary(), undefined);
	assert.equal(await client.ready(), false);
	assert.equal(await client.filter(meta, {}, "output"), undefined);
	assert.equal(await client.read(meta, "/a.pdf"), undefined);
	assert.equal(await client.observe(meta, {}), undefined);
	client.observeDetached(meta, {});
	client.sync(meta);
});

test("refresh re-resolves the binary after an install", async () => {
	let binary: string | undefined;
	const client = createBoostClient({
		env: { PATH: "" },
		platform: "linux",
		home: root,
		resolveBinary: () => binary,
	});
	assert.equal(client.binary(), undefined);
	binary = fakeBoost(`${VERSION_REPLY}\ncat >/dev/null\necho compacted`);
	assert.equal(client.binary(), undefined, "resolution is cached until refresh");
	client.refresh();
	assert.equal(client.binary(), binary);
	assert.equal(await client.filter(meta, {}, "output"), "compacted\n");
});

test("isFilterable rejects empty, binary, and oversized text", () => {
	assert.equal(isFilterable("hello"), true);
	assert.equal(isFilterable(""), false);
	assert.equal(isFilterable("has\0nul"), false);
	assert.equal(isFilterable("x".repeat(MAX_PAYLOAD_BYTES + 1)), false);
	assert.equal(isFilterable("x".repeat(MAX_PAYLOAD_BYTES)), true);
});

test("oversized output is passed through instead of piped to Boost", async () => {
	const ran = join(root, "filter-ran.txt");
	const binary = fakeBoost(`${VERSION_REPLY}\ntouch ${ran}\ncat >/dev/null\necho compacted`);
	assert.equal(await clientFor(binary).filter(meta, {}, "x".repeat(MAX_PAYLOAD_BYTES + 1)), undefined);
	assert.equal(existsSync(ran), false);
});
