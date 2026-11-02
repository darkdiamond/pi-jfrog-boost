/**
 * Reading `~/.boost/config.toml` (spec §3 boost-config, §8.4): the TOML
 * subset, flag precedence, the shell gate, the mtime cache — and that the
 * reader never writes, which is invariant 4.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	boostConfigPath,
	type ConfigFs,
	createConfigReader,
	MAX_CONFIG_BYTES,
	parseBoostConfig,
	parseGoDuration,
	parseToml,
	resolveFlag,
	shellGate,
	telemetryOn,
} from "../src/boost-config.ts";
import { removeTempDir } from "./helpers/tmp.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "config");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-config-"));
after(() => removeTempDir(root));

test("a v0.15.4 config: terms, metadata, remote flags, measurement", () => {
	const config = parseBoostConfig(fixture("v0.15.4.toml"));
	assert.equal(config.termsAccepted, true);
	assert.equal(config.termsAt, "2026-10-01T09:00:00Z");
	assert.equal(config.flagsUpdatedAt, "2026-10-13T05:06:56.458022Z");
	assert.deepEqual(config.flag("boost-cli-filtering"), { remote: false });
	assert.deepEqual(config.flag("boost-mcp-filtering"), { remote: true });
	assert.deepEqual(config.flag("not-a-flag"), {});
	assert.deepEqual(config.disabledFilters, []);
	assert.equal(config.boostOffSessions, false);
});

test("a UTF-8 byte order mark before the first key is skipped, as Boost's Go decoder does", () => {
	assert.equal(parseBoostConfig('\ufeffaccept_terms = "yes"\n').termsAccepted, true);
	assert.equal(
		parseBoostConfig(`\ufeff${fixture("v0.15.4.toml")}`).flagsUpdatedAt,
		"2026-10-13T05:06:56.458022Z",
	);
});

test("a fresh install has no metadata and no terms", () => {
	const config = parseBoostConfig(fixture("no-metadata.toml"));
	assert.equal(config.termsAccepted, false);
	assert.equal(config.flagsUpdatedAt, undefined);
	assert.equal(config.boostOffSessions, true);
});

test("filters Boost disabled are read from a multi-line array with comments", () => {
	const config = parseBoostConfig(fixture("filters-disabled.toml"));
	assert.deepEqual(config.disabledFilters, ["go", "node-test", "npm"]);
	assert.equal(config.termsAccepted, true, "a literal-string 'yes' counts");
	assert.equal(config.flagsUpdatedAt, "2026-10-13T05:06:56Z", "a bare date-time is kept as text");
});

test("the parser skips what it cannot read and keeps everything around it", () => {
	const doc = parseToml(fixture("messy.toml"));
	const flags = doc.get(JSON.stringify(["feature_flags", "boost-cli-filtering"]));
	assert.ok(flags, "a header with spaces around the dots still parses");
	assert.equal(flags.get("user"), false);
	assert.equal(flags.get("remote"), true);
	assert.deepEqual(flags.get("weird"), { a: 1, b: [1, 2], c: "x" });
	assert.equal(flags.get("count"), 1000);
	assert.equal(flags.get("broken"), undefined, "the unterminated array is dropped");
	assert.equal(flags.get("ratio"), 0.5);
	assert.equal(flags.get("quoted.key"), "kept");
	assert.equal(flags.get("escaped"), 'tab\tquote"unicodeé');
	assert.equal(doc.get("[]")?.get("title"), "multi\nline");
	const config = parseBoostConfig(fixture("messy.toml"));
	assert.deepEqual(config.flag("boost-mcp-filtering"), { user: false });
	assert.equal(config.flag("name").user, undefined, "array-of-tables keys land nowhere a reader looks");
});

test("CRLF line endings parse like LF", () => {
	const config = parseBoostConfig(fixture("user-on.toml").replaceAll("\n", "\r\n"));
	assert.deepEqual(config.flag("boost-cli-filtering"), { user: true, remote: false });
	assert.equal(config.flagsUpdatedAt, "2026-10-13T05:06:56Z");
});

test("garbage is an empty config, never a throw", () => {
	for (const text of ["", "[", "= = =", "\u0000\u0001", "[a]\nb = [[[", 'x = "unterminated']) {
		const config = parseBoostConfig(text);
		assert.equal(config.termsAccepted, false, JSON.stringify(text));
	}
});

// ---------------------------------------------------------------------------
// Flag precedence (§8.4): FORCE_ENABLED, FORCE_DISABLED, user, remote, unknown

test("all five precedence levels resolve in order", () => {
	const userOn = parseBoostConfig(fixture("user-on.toml"));
	const remoteOff = parseBoostConfig(fixture("v0.15.4.toml"));
	const none = parseBoostConfig(fixture("no-metadata.toml"));
	const name = "boost-cli-filtering";

	assert.deepEqual(
		resolveFlag(remoteOff, name, {
			BOOST_FEATURE_FLAGS_FORCE_ENABLED: "x, boost-cli-filtering",
			BOOST_FEATURE_FLAGS_FORCE_DISABLED: name,
		}),
		{ value: true, source: "force-enabled" },
		"1. FORCE_ENABLED beats everything",
	);
	assert.deepEqual(
		resolveFlag(userOn, name, { BOOST_FEATURE_FLAGS_FORCE_DISABLED: `other,${name}` }),
		{ value: false, source: "force-disabled" },
		"2. FORCE_DISABLED beats the config",
	);
	assert.deepEqual(resolveFlag(userOn, name, {}), { value: true, source: "user" }, "3. user beats remote");
	assert.deepEqual(resolveFlag(remoteOff, name, {}), { value: false, source: "remote" }, "4. remote");
	assert.deepEqual(resolveFlag(none, name, {}), { value: "unknown", source: "unknown" }, "5. unknown");
	assert.deepEqual(
		resolveFlag(none, name, { BOOST_FEATURE_FLAGS_FORCE_ENABLED: "boost-cli-filtering-v2" }),
		{ value: "unknown", source: "unknown" },
		"list entries match whole names only",
	);
});

test("the shell gate: on, off, and auto by flag and by Boost version", () => {
	const userOn = parseBoostConfig(fixture("user-on.toml"));
	const remoteOff = parseBoostConfig(fixture("v0.15.4.toml"));
	const none = parseBoostConfig(fixture("no-metadata.toml"));
	const v = (minor: number, patch: number): [number, number, number] => [0, minor, patch];

	assert.equal(shellGate("on", remoteOff, {}, v(15, 4)).on, true);
	assert.equal(shellGate("off", userOn, {}, v(15, 4)).on, false);
	assert.equal(shellGate("auto", userOn, {}, v(15, 4)).on, true);
	assert.equal(shellGate("auto", remoteOff, {}, v(15, 4)).on, false);
	assert.equal(
		shellGate("auto", remoteOff, { BOOST_FEATURE_FLAGS_FORCE_ENABLED: "boost-cli-filtering" }, v(15, 4)).on,
		true,
	);

	// Unknown: Boost's built-in default decides.
	assert.deepEqual(
		[shellGate("auto", none, {}, v(14, 5)).on, shellGate("auto", none, {}, v(14, 5)).reason],
		[true, "unknown-before-flags"],
		"before 0.14.6 filtering was on by default",
	);
	assert.deepEqual(
		[shellGate("auto", none, {}, v(14, 6)).on, shellGate("auto", none, {}, v(14, 6)).reason],
		[false, "unknown-default-off"],
		"0.14.6 made it opt-in",
	);
	assert.equal(shellGate("auto", none, {}, v(15, 9)).on, false, "an older line keeps the opt-in default");
	assert.equal(
		shellGate("auto", none, {}, v(16, 40)).on,
		false,
		"a later 0.16.x patch is still the validated line",
	);
	assert.deepEqual(
		[shellGate("auto", none, {}, v(17, 0)).on, shellGate("auto", none, {}, v(17, 0)).reason],
		[true, "unknown-newer-than-validated"],
		"newer than validated: Boost decides",
	);
	assert.equal(shellGate("auto", none, {}, undefined).on, false, "no version known: off");
});

// ---------------------------------------------------------------------------
// The reader: path, cache, size limit, read-only

test("the config path is always $HOME/.boost/config.toml", () => {
	assert.equal(boostConfigPath(join("/h", "me")), join("/h", "me", ".boost", "config.toml"));
});

/** A ConfigFs over one real file that counts reads. */
function countingFs() {
	const counts = { stat: 0, read: 0 };
	const fs: ConfigFs = {
		statSync: (path) => {
			counts.stat++;
			return statSync(path);
		},
		readFileSync: (path, encoding) => {
			counts.read++;
			return readFileSync(path, encoding);
		},
	};
	return { fs, counts };
}

test("the file is re-parsed only when its mtime or size changes", () => {
	const path = join(root, "cached.toml");
	writeFileSync(path, fixture("v0.15.4.toml"));
	const { fs, counts } = countingFs();
	const reader = createConfigReader({ path, fs });
	assert.equal(reader.read().termsAccepted, true);
	reader.read();
	reader.read();
	assert.equal(counts.read, 1, "stat on every read, parse once");
	assert.equal(counts.stat, 3);

	writeFileSync(path, fixture("no-metadata.toml"));
	utimesSync(path, new Date(2031, 0, 1), new Date(2031, 0, 1));
	assert.equal(reader.read().termsAccepted, false, "a changed file is read again");
	assert.equal(counts.read, 2);
});

test("a missing file is an empty config, and so is one over 1 MiB", () => {
	const missing = createConfigReader({ path: join(root, "nope.toml") });
	assert.equal(missing.read().termsAccepted, false);

	const big = join(root, "big.toml");
	writeFileSync(big, `accept_terms = "yes"\n# ${"x".repeat(MAX_CONFIG_BYTES)}\n`);
	const { fs, counts } = countingFs();
	assert.equal(createConfigReader({ path: big, fs }).read().termsAccepted, false);
	assert.equal(counts.read, 0, "an oversized file is never read");
});

test("reading the config never writes to the file system", () => {
	// Every node:fs function that can create, change or remove a file, patched
	// on the CommonJS object and pushed into the ESM bindings `src/` holds.
	const fsModule = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
	const writers = [
		"writeFileSync",
		"appendFileSync",
		"renameSync",
		"rmSync",
		"unlinkSync",
		"truncateSync",
		"copyFileSync",
		"mkdirSync",
		"writeSync",
		"writeFile",
		"appendFile",
		"rename",
		"rm",
		"unlink",
		"truncate",
		"copyFile",
		"createWriteStream",
		"openSync",
		"open",
	];
	const path = join(root, "spied.toml");
	writeFileSync(path, fixture("filters-disabled.toml"));
	const calls: string[] = [];
	const originals = new Map<string, unknown>();
	for (const name of writers) {
		const original = fsModule[name] as (...args: unknown[]) => unknown;
		originals.set(name, original);
		fsModule[name] = function spied(this: unknown, ...args: unknown[]) {
			// `openSync(path, "r")` is a read; any other flag can write.
			if ((name === "openSync" || name === "open") && (args[1] === undefined || args[1] === "r")) {
				return original.apply(this, args);
			}
			calls.push(`${name}(${String(args[0])})`);
			return original.apply(this, args);
		};
	}
	syncBuiltinESMExports();
	try {
		const reader = createConfigReader({ path });
		const config = reader.read();
		resolveFlag(config, "boost-cli-filtering", {});
		shellGate("on", config, {}, [0, 15, 4]);
		reader.read();
		createConfigReader({ home: () => root }).read();
	} finally {
		for (const [name, original] of originals) fsModule[name] = original;
		syncBuiltinESMExports();
	}
	assert.deepEqual(calls, []);
	assert.equal(readFileSync(path, "utf8"), fixture("filters-disabled.toml"));
});

test("telemetry: [tracing] telemetry, overridden by BOOST_TELEMETRY, on by default", () => {
	const off = parseBoostConfig('accept_terms = "yes"\n[tracing]\ntelemetry = false\n');
	assert.equal(off.telemetry, false);
	assert.equal(telemetryOn(off, {}), false, "boost init --no-telemetry");
	assert.equal(telemetryOn(off, { BOOST_TELEMETRY: "1" }), true);
	const none = parseBoostConfig("");
	assert.equal(none.telemetry, undefined);
	assert.equal(telemetryOn(none, {}), true, "Boost's default");
	assert.equal(telemetryOn(off, { BOOST_TELEMETRY: "TRUE" }), true);
	assert.equal(telemetryOn(off, { BOOST_TELEMETRY: "" }), false, "empty falls back to the config");
	// Measured on v0.16.11: any other non-empty value turns telemetry off.
	for (const value of ["0", "false", "f", "no", "off", "on", "yes", "maybe", " 1", " true "]) {
		assert.equal(telemetryOn(none, { BOOST_TELEMETRY: value }), false, JSON.stringify(value));
	}
});

test("parseGoDuration refuses absurdly long input instead of scanning it", () => {
	assert.equal(parseGoDuration(`${"9".repeat(100)}h`), undefined);
	assert.equal(parseGoDuration("1h30m"), 90 * 60_000);
});
