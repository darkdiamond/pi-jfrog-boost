/**
 * Drives the extension through a stand-in for pi's extension host, so the
 * wiring itself is under test: which results reach Boost, what gets replaced,
 * and — most importantly — that a failing Boost never reaches pi.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withAwareness } from "../src/awareness.ts";
import { type BoostClient, createBoostClient, type HookMeta, type HookPayload } from "../src/boost-client.ts";
import type { ConfigReader } from "../src/boost-config.ts";
import {
	type Breaker,
	type BreakerState,
	type Counters,
	createBreaker,
	createCounters,
	createReadiness,
	type Readiness,
	type ReadinessState,
} from "../src/health.ts";
import {
	createBoostExtension,
	createNotices,
	NO_BOOST_FLAG,
	PROBE_UI_WAIT_MS,
	TERMS_NOTICE,
} from "../src/index.ts";
import type { SettingsStore } from "../src/settings.ts";
import { SESSION_TOGGLE_ENTRY } from "../src/settings.ts";
import { STATS_ENTRY, type StatsSnapshot } from "../src/stats.ts";
import {
	filtersDisabledNotice,
	MISSING_NOTICE,
	type Notices,
	pausedNotice,
	shellOffNotice,
	tooOldNotice,
} from "../src/status.ts";
import { createSyncFlight, type SyncFlight } from "../src/sync.ts";
import { logReadCommand } from "../src/tools.ts";
import { docx } from "./helpers/docx.ts";
import {
	agentSettledEvent,
	beforeAgentStartEvent,
	createPiStub,
	type PiLine,
	plainTheme,
	textOfBlocks,
	toolExecutionEndEvent,
	toolExecutionStartEvent,
	toolResultEvent,
} from "./helpers/harness.ts";
import { call, fixedConfig, fixedReadiness, memorySettings, stubClient } from "./helpers/runtime.ts";
import { removeTempDir } from "./helpers/tmp.ts";

/**
 * Boost's config with CLI filtering on, so the shell gate (spec §8.4) lets
 * shell output through. A default v0.15 install has it off, and then nothing
 * is sent at all — see the gate tests below.
 */
const CLI_ON = `[feature_flags."boost-cli-filtering"]\nuser = true\n`;
const CLI_OFF = `[feature_flags."boost-cli-filtering"]\nuser = false\n`;
/** JFrog's remote flag turned CLI filtering off; the user set nothing. */
const CLI_REMOTE_OFF = `[feature_flags."boost-cli-filtering"]\nremote = false\n`;
/** No flag value recorded: Boost's built-in default (off since 0.14.6) applies. */
const CLI_DEFAULT = "";

/** Test-runner output long enough to be worth a Boost call (over the 2 KiB minBytes). */
const NOISY = Array.from({ length: 200 }, (_, i) => `ok ${i} - case ${i} passes`).join("\n");

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface Recorded {
	kind: "filter" | "read" | "observe" | "sync";
	meta: HookMeta;
	fields: HookPayload;
	/** What the filter was handed, for filter calls. */
	text?: string;
}

interface HarnessOptions {
	overrides?: Partial<BoostClient>;
	filterResult?: string;
	readResult?: string;
	observeEnabled?: boolean;
	/** The extension's live environment (kill switches, per-key overrides). */
	env?: NodeJS.ProcessEnv;
	/** Contents of the settings file. */
	file?: Record<string, unknown>;
	/** `--no-boost`'s value, as `pi.getFlag` returns it. */
	flag?: boolean | string;
	readiness?: Readiness;
	breaker?: Breaker;
	settings?: SettingsStore;
	config?: ConfigReader;
	counters?: Counters;
	/** Shared with another harness: the same process across a session switch. */
	syncFlight?: SyncFlight;
}

function harness({
	overrides = {},
	filterResult,
	readResult,
	observeEnabled = true,
	env = {},
	file,
	flag,
	readiness = fixedReadiness(),
	breaker,
	settings,
	config = fixedConfig(CLI_ON),
	counters,
	syncFlight = createSyncFlight(),
}: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands: string[] = [];
	const flags = new Map<string, unknown>();
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const calls: Recorded[] = [];

	const client = stubClient({
		filter: async (meta, text, options) => {
			calls.push({ kind: "filter", meta, fields: (options?.toolInput ?? {}) as HookPayload, text });
			return filterResult === undefined ? call("", 0) : call(filterResult);
		},
		convert: async (meta, path) => {
			calls.push({ kind: "read", meta, fields: { path } });
			return readResult === undefined ? call("", 1) : call(readResult);
		},
		observeDetached: (meta, fields) => calls.push({ kind: "observe", meta, fields }),
		sync: (meta) => calls.push({ kind: "sync", meta, fields: {} }),
		...overrides,
	});

	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string) => commands.push(name),
		registerFlag: (name: string, options: unknown) => flags.set(name, options),
		getFlag: (name: string) => (name === NO_BOOST_FLAG ? flag : undefined),
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: "/work",
		hasUI: true,
		sessionManager: { getSessionId: () => "sess-1" },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
		},
	} as unknown as ExtensionContext;

	createBoostExtension(pi, {
		client,
		env,
		settings:
			settings ??
			memorySettings({
				env: { ...(observeEnabled ? { PI_BOOST_OBSERVE: "1" } : {}), ...env },
				...(file ? { file } : {}),
				flag: () => flag,
			}),
		config,
		readiness,
		// Each harness is its own process as far as the breaker, the running
		// sync and once-only notices go.
		breaker: breaker ?? createBreaker(),
		syncFlight,
		...(counters ? { counters } : {}),
		notices: createNotices(),
		syncDelayMs: 5,
		firstTurnWaitMs: 50,
	});

	const fire = async (event: string, payload: unknown) => {
		const results = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload as never, ctx));
		}
		return results.at(-1);
	};

	return { fire, calls, commands, flags, notices, statuses, readiness, handlers };
}

const observed = (calls: Recorded[], name: string) =>
	calls.filter((c) => c.kind === "observe" && c.fields.hook_event_name === name);

const result = (toolName: string, over: Partial<Record<string, unknown>> = {}) => ({
	toolName,
	toolCallId: "c1",
	isError: false,
	input: {},
	content: [{ type: "text", text: "raw output" }],
	...over,
});

/** A bash result with `text` (default: noisy test output). */
const bashResult = (command: string, text = NOISY, over: Partial<Record<string, unknown>> = {}) =>
	result("bash", { input: { command }, content: [{ type: "text", text }], ...over });

const filterCalls = (calls: Recorded[]) => calls.filter((c) => c.kind === "filter");

test("the /boost hub and its install alias are registered up front, before any session", () => {
	assert.deepEqual(harness().commands, ["boost", "boost-install"]);
});

test("shell output is filtered, described by its own command, and marked in details", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	const patched = await fire("tool_result", bashResult("npm test"));
	assert.deepEqual(patched, {
		content: [{ type: "text", text: "compacted" }],
		details: { jfrogBoost: { kind: "compacted", before: NOISY.length, after: "compacted".length } },
	});
	assert.equal(filterCalls(calls)[0]?.fields.command, "npm test");
});

test("read, grep, find and ls never reach the filter by default", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	for (const [tool, input] of [
		["read", { path: "src/index.ts" }],
		["read", { path: "/var/log/app.log" }],
		["read", { path: "data.csv" }],
		["grep", { pattern: "TODO", path: "src" }],
		["find", { pattern: "*.ts", path: "." }],
		["ls", { path: "." }],
	] as const) {
		const patched = await fire(
			"tool_result",
			result(tool, { input, content: [{ type: "text", text: NOISY }] }),
		);
		assert.equal(patched, undefined, tool);
	}
	assert.equal(filterCalls(calls).length, 0);
});

test("tools pi already summarises are not sent to Boost", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	for (const tool of ["edit", "write"]) {
		const patched = await fire("tool_result", result(tool, { content: [{ type: "text", text: NOISY }] }));
		assert.equal(patched, undefined, tool);
	}
	assert.equal(filterCalls(calls).length, 0);
});

test("output Boost leaves alone keeps the original result", async () => {
	const { fire } = harness();
	assert.equal(await fire("tool_result", bashResult("npm test")), undefined);
});

test("output under minBytes is not sent at all", async () => {
	const { fire, calls } = harness({ filterResult: "x" });
	assert.equal(await fire("tool_result", bashResult("ls", "a\nb\nc")), undefined);
	assert.equal(filterCalls(calls).length, 0);
});

test("minBytes comes from the settings file", async () => {
	const { fire, calls } = harness({ filterResult: "x", file: { minBytes: 0 } });
	await fire("session_start", { reason: "startup" });
	assert.ok(await fire("tool_result", bashResult("ls", "a".repeat(600))));
	assert.equal(filterCalls(calls).length, 1);
});

test("whitespace-only and sub-threshold replies are not applied", async () => {
	for (const reply of [`${NOISY}\n\n`, NOISY.slice(0, -100), "  \n"]) {
		const { fire } = harness({ filterResult: reply });
		assert.equal(
			await fire("tool_result", bashResult("npm test")),
			undefined,
			JSON.stringify(reply.slice(-10)),
		);
	}
});

test("a filter that throws leaves the original result untouched", async () => {
	const { fire } = harness({
		overrides: {
			filter: async () => {
				throw new Error("boost exploded");
			},
		},
	});
	assert.equal(await fire("tool_result", bashResult("npm test")), undefined);
});

// ---------------------------------------------------------------------------
// Documents (spec §7.1)

const docRoot = mkdtempSync(join(tmpdir(), "pi-boost-ext-docs-"));
after(() => removeTempDir(docRoot));
const TERMS = `accept_terms = "yes"\n${CLI_ON}`;
const DOCX_PATH = join(docRoot, "q3.docx");
writeFileSync(DOCX_PATH, docx(["Quarterly report"]));
const OLE_PATH = join(docRoot, "old.doc");
writeFileSync(OLE_PATH, Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(64)]));
const RAW = "PK\u0003\u0004\u0000\u0000garbage";
const readCalls = (calls: Recorded[]) => calls.filter((c) => c.kind === "read");
const docResult = (path: string, over: Partial<Record<string, unknown>> = {}) =>
	result("read", { input: { path }, content: [{ type: "text", text: RAW }], ...over });

test("a PDF or Office read reaches the model as converted text, marked in details", async () => {
	const { fire, calls } = harness({
		readResult: "# Quarterly report\nRevenue up.",
		config: fixedConfig(TERMS),
	});
	const patched = await fire(
		"tool_result",
		docResult(DOCX_PATH, { structuredContent: RAW, details: { x: 1 } }),
	);
	assert.deepEqual(patched, {
		content: [
			{
				type: "text",
				text: "[Converted from q3.docx by JFrog Boost. Line numbers refer to this text, not the file.]\n# Quarterly report\nRevenue up.",
			},
		],
		isError: false,
		structuredContent: "# Quarterly report\nRevenue up.",
		details: { x: 1, jfrogBoost: { kind: "converted", ext: ".docx", lines: [1, 2, 2] } },
	});
	assert.deepEqual(readCalls(calls)[0]?.fields, { path: DOCX_PATH });
	// pi 0.86 has no structuredContent, and none is invented.
	const plain = (await fire("tool_result", docResult(DOCX_PATH))) as Record<string, unknown>;
	assert.equal("structuredContent" in plain, false);
	assert.equal(readCalls(calls).length, 1, "the second read came from the cache");
});

test("a refused read never reaches Boost", async () => {
	const { fire, calls } = harness({ readResult: "# Quarterly report", config: fixedConfig(TERMS) });
	for (const text of ["ENOENT: no such file", "Offset 9 is beyond end of file (3 lines total)"]) {
		assert.equal(
			await fire("tool_result", docResult(DOCX_PATH, { isError: true, content: [{ type: "text", text }] })),
			undefined,
		);
	}
	assert.deepEqual(readCalls(calls), []);
});

test("an offset past pi's raw bytes is answered from the converted text", async () => {
	const text = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
	const { fire } = harness({ readResult: text, config: fixedConfig(TERMS) });
	const patched = (await fire(
		"tool_result",
		docResult(DOCX_PATH, {
			isError: true,
			input: { path: DOCX_PATH, offset: 2001 },
			content: [{ type: "text", text: "Offset 2001 is beyond end of file (3 lines total)" }],
		}),
	)) as { content: { text: string }[]; isError: boolean };
	assert.equal(patched.isError, false);
	assert.match(patched.content[0]?.text ?? "", /^\[Converted from q3\.docx[^\n]*\]\nline 2001\n/);
});

test("without the Preview Agreement documents are left alone, and the user is told once", async () => {
	const { fire, calls, notices } = harness({ readResult: "# Quarterly report", config: fixedConfig(CLI_ON) });
	for (let i = 0; i < 3; i++) assert.equal(await fire("tool_result", docResult(DOCX_PATH)), undefined);
	assert.deepEqual(readCalls(calls), []);
	assert.deepEqual(
		notices.filter((n) => n === TERMS_NOTICE),
		[TERMS_NOTICE],
	);
});

test("pi's raw-byte truncation never survives a conversion; the page's own replaces it", async () => {
	// What pi's read sets for a stored zip: its XML is one line far over 50 KiB.
	const raw = {
		truncated: true,
		truncatedBy: "bytes",
		totalLines: 3,
		totalBytes: 90_000,
		outputLines: 0,
		outputBytes: 0,
		lastLinePartial: false,
		firstLineExceedsLimit: true,
		maxLines: 2000,
		maxBytes: 51200,
		content: "",
	};
	const short = harness({ readResult: "# Quarterly report", config: fixedConfig(TERMS) });
	const patched = (await short.fire(
		"tool_result",
		docResult(DOCX_PATH, { details: { truncation: raw, x: 1 } }),
	)) as {
		details: Record<string, unknown>;
	};
	assert.deepEqual(patched.details, {
		x: 1,
		jfrogBoost: { kind: "converted", ext: ".docx", lines: [1, 1, 1] },
	});

	const long = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
	const paged = harness({ readResult: long, config: fixedConfig(TERMS) });
	const page = (await paged.fire("tool_result", docResult(DOCX_PATH, { details: { truncation: raw } }))) as {
		details: { truncation: Record<string, unknown> };
	};
	assert.equal(page.details.truncation.firstLineExceedsLimit, false);
	assert.equal(page.details.truncation.truncatedBy, "lines");
	assert.equal(page.details.truncation.outputLines, 2000);
	assert.equal(page.details.truncation.totalLines, 2500);
	assert.equal("content" in page.details.truncation, false, "details hold numbers, not the page");

	const legacy = harness({
		readResult: "[boost] Legacy Office (.doc): save as docx.",
		config: fixedConfig(TERMS),
	});
	const advisory = (await legacy.fire(
		"tool_result",
		docResult(OLE_PATH, { details: { truncation: raw } }),
	)) as {
		details: Record<string, unknown>;
	};
	assert.equal("truncation" in advisory.details, false);
});

test("a client refusal on the document route is counted once", async () => {
	const counters = createCounters();
	const { fire } = harness({
		config: fixedConfig(TERMS),
		counters,
		overrides: { convert: async () => ({ ...call(""), code: null, skipped: "busy" }) },
	});
	assert.equal(await fire("tool_result", docResult(DOCX_PATH)), undefined);
	assert.deepEqual(counters.skips(), { busy: 1 });

	const timeouts = createCounters();
	const slow = harness({
		config: fixedConfig(TERMS),
		counters: timeouts,
		overrides: { convert: async () => ({ ...call(""), code: null, timedOut: true }) },
	});
	assert.equal(await slow.fire("tool_result", docResult(DOCX_PATH)), undefined);
	assert.deepEqual(timeouts.errors(), { timeout: 1 });
	assert.deepEqual(timeouts.skips(), {}, "a timeout is an error, not also a skip");

	const exits = createCounters();
	const failing = harness({ config: fixedConfig(TERMS), counters: exits }); // convert exits 1
	await failing.fire("tool_result", docResult(DOCX_PATH));
	assert.deepEqual(exits.skips(), { exit: 1 });
});

test("without the terms, a read that would not convert anyway is not `terms`, and says nothing", async () => {
	const counters = createCounters();
	const textPdf = join(docRoot, "notes.pdf");
	writeFileSync(textPdf, "plain text in a .pdf");
	const { fire, calls, notices } = harness({ config: fixedConfig(CLI_ON), counters });
	assert.equal(await fire("tool_result", docResult(textPdf)), undefined);
	assert.deepEqual(counters.skips(), { "not-document": 1 });
	assert.deepEqual(
		notices.filter((n) => n === TERMS_NOTICE),
		[],
	);
	assert.deepEqual(readCalls(calls), []);
});

test("terms revoked while Boost ran: its non-zero exit brings the notice, once", async () => {
	let revokedNow = false;
	const accepted = fixedConfig(TERMS).read();
	const revoked = fixedConfig(CLI_ON).read();
	// Every read before the spawn sees the terms; every read after it does not.
	const config: ConfigReader = { ...fixedConfig(TERMS), read: () => (revokedNow ? revoked : accepted) };
	const counters = createCounters();
	const { fire, notices, calls } = harness({
		config,
		counters,
		overrides: {
			convert: async () => {
				calls.push({ kind: "read", meta: {} as HookMeta, fields: {} });
				revokedNow = true;
				return call("accept_terms is missing", 1);
			},
		},
	});
	for (let i = 0; i < 2; i++) {
		revokedNow = false;
		assert.equal(await fire("tool_result", docResult(DOCX_PATH)), undefined);
	}
	assert.equal(readCalls(calls).length, 2, "Boost ran: the exit branch, not the terms skip");
	assert.deepEqual(counters.skips(), { exit: 2 });
	assert.deepEqual(
		notices.filter((n) => n === TERMS_NOTICE),
		[TERMS_NOTICE],
	);
});

test("a legacy Office file becomes an error only when Boost answered", async () => {
	const advisory = "[boost] Legacy Office (.doc): save as docx/xlsx/pptx, then Read or boost read.";
	const answered = harness({ readResult: advisory, config: fixedConfig(TERMS) });
	const patched = (await answered.fire("tool_result", docResult(OLE_PATH))) as {
		content: { text: string }[];
		isError: boolean;
	};
	assert.equal(patched.isError, true);
	assert.match(patched.content[0]?.text ?? "", /^pi-jfrog-boost: old\.doc is a legacy binary Office file/);
	const missing = harness({
		config: fixedConfig(TERMS),
		overrides: { convert: async () => ({ ...call(""), code: null, skipped: "missing" }) },
	});
	assert.equal(await missing.fire("tool_result", docResult(OLE_PATH)), undefined);
});

test("a document Boost cannot convert keeps pi's result", async () => {
	const { fire } = harness({ config: fixedConfig(TERMS) }); // convert exits 1
	assert.equal(await fire("tool_result", docResult(DOCX_PATH)), undefined);
});

test("a failed shell command is still compacted, and stays an error", async () => {
	const { fire, calls } = harness({ filterResult: "3 failures" });
	const patched = (await fire(
		"tool_result",
		bashResult("npm test", `${NOISY}\n\nCommand exited with code 1`, { isError: true }),
	)) as { content: unknown; isError?: boolean };
	assert.deepEqual(patched.content, [{ type: "text", text: "3 failures\n\nCommand exited with code 1" }]);
	assert.equal("isError" in patched, false, "isError is left as the tool set it");
	assert.equal(filterCalls(calls)[0]?.text, NOISY);
});

test("other failed tools are not fed to the filter", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	await fire("tool_result", result("grep", { isError: true, input: { pattern: "(" } }));
	assert.equal(filterCalls(calls).length, 0);
});

test("pi's truncation notice survives compaction verbatim", async () => {
	const { fire, calls } = harness({ filterResult: "compacted\n" });
	const notice = "\n\n[Showing lines 7001-9000 of 9000. Full output: /tmp/pi-bash-1.log]";
	const patched = await fire("tool_result", bashResult("npm test", `${NOISY}${notice}`));
	assert.deepEqual((patched as { content: unknown }).content, [{ type: "text", text: `compacted${notice}` }]);
	assert.equal(filterCalls(calls)[0]?.text, NOISY);
});

test("a shell filter that ran but was not used is counted: `unchanged` on exit 0, `exit` otherwise", async () => {
	for (const [code, reason] of [
		[0, "unchanged"],
		[1, "exit"],
	] as const) {
		const counters = createCounters();
		const { fire } = harness({
			counters,
			overrides: { filter: async (_meta, text) => call(code === 0 ? text : "compacted", code) },
		});
		assert.equal(await fire("tool_result", bashResult("npm test")), undefined);
		assert.deepEqual(counters.skips(), { [reason]: 1 }, reason);
		assert.deepEqual(counters.errors(), {}, reason);
	}
});

test("terminal escapes are stripped for Boost, and kept when its reply is not used", async () => {
	const coloured = `\u001b[32m${NOISY}\u001b[0m`;
	const echo = harness({ overrides: { filter: async (_meta, text) => call(text) } });
	assert.equal(await echo.fire("tool_result", bashResult("npm test", coloured)), undefined);
	const { fire, calls } = harness({ filterResult: "3 failures" });
	await fire("tool_result", bashResult("npm test", coloured));
	assert.equal(filterCalls(calls)[0]?.text, NOISY);
});

test("DISABLE_BOOST=1 or BOOST_DISABLED=1 on a command returns its output exactly", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	for (const command of [
		"DISABLE_BOOST=1 diff -u a b",
		"cd x && DISABLE_BOOST=1 cat y",
		"BOOST_DISABLED=1 npm test",
		"export DISABLE_BOOST=1; npm test",
	]) {
		assert.equal(await fire("tool_result", bashResult(command)), undefined, command);
	}
	assert.equal(filterCalls(calls).length, 0);
});

test("boost's own commands are not compacted a second time, however boost is named", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	for (const command of [
		"boost retrieve 147",
		"boost retrieve 147 --lines 1-40",
		"boost read a.pdf",
		"~/.local/bin/boost retrieve 3",
		'"$HOME/.local/bin/boost" retrieve 3',
	]) {
		assert.equal(await fire("tool_result", bashResult(command)), undefined, command);
	}
	assert.equal(filterCalls(calls).length, 0);
});

const PAGE = `<!doctype html>\n<html><body>${"<p>Some article text.</p>".repeat(200)}</body></html>`;

test("an HTML document from bash reaches the filter only for curl/wget-class commands", async () => {
	const { fire, calls } = harness({ filterResult: "Some article text." });
	for (const command of ["cat index.html", "sed -n 1,400p page.html", "node render.js"]) {
		assert.equal(await fire("tool_result", bashResult(command, PAGE)), undefined, command);
	}
	assert.equal(filterCalls(calls).length, 0, "no file the model may edit is turned into prose");
	for (const command of ["curl -s https://example.com", "wget -qO- https://example.com"]) {
		assert.ok(await fire("tool_result", bashResult(command, PAGE)), command);
	}
	assert.equal(filterCalls(calls).length, 2);
});

test("an aborted command is left alone", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	assert.equal(
		await fire("tool_result", bashResult("npm test", `${NOISY}\n\nCommand aborted`, { isError: true })),
		undefined,
	);
	assert.equal(filterCalls(calls).length, 0);
});

test("extraTools are routed like bash; read and edit cannot be", async () => {
	const { fire, calls } = harness({
		filterResult: "compacted",
		file: { extraTools: ["fetch", "read", "edit"] },
	});
	await fire("session_start", { reason: "startup" });
	assert.ok(
		await fire(
			"tool_result",
			result("fetch", { input: { url: "x" }, content: [{ type: "text", text: NOISY }] }),
		),
	);
	for (const tool of ["read", "edit"]) {
		const over = { input: { path: "a.ts" }, content: [{ type: "text", text: NOISY }] };
		assert.equal(await fire("tool_result", result(tool, over)), undefined, tool);
	}
	assert.equal(filterCalls(calls).length, 1);
});

test("with readLogs on, a whole log read is filtered as `cat <abs>`", async () => {
	const { fire, calls } = harness({ filterResult: "compacted", file: { readLogs: true } });
	await fire("session_start", { reason: "startup" });
	const log = (input: Record<string, unknown>) =>
		result("read", { input, content: [{ type: "text", text: NOISY }] });
	assert.ok(await fire("tool_result", log({ path: "logs/app.log" })));
	// Resolved as pi resolves it: on Windows `/work` gains the current drive.
	const abs = resolve("/work", "logs", "app.log");
	assert.deepEqual(filterCalls(calls)[0]?.fields, {
		path: "logs/app.log",
		file_path: abs,
		command: logReadCommand(abs),
	});
	assert.equal(
		await fire("tool_result", log({ path: "logs/app.log", offset: 5 })),
		undefined,
		"not a whole read",
	);
	assert.equal(filterCalls(calls).length, 1);
});

test("there is no tool_call handler: nothing can block a tool from running", () => {
	const { handlers } = harness();
	assert.equal(handlers.has("tool_call"), false);
});

test("the footer shows a running estimate of what Boost saved", async () => {
	const { fire, statuses } = harness({ filterResult: "short" });
	await fire("session_start", { reason: "startup" });
	assert.equal(statuses.at(-1), "boost ✓");
	await fire("tool_result", bashResult("npm test", "x".repeat(8005)));
	assert.equal(statuses.at(-1), "boost ✓ ~2.0k saved (100%)");
	await fire("session_start", { reason: "new" });
	assert.equal(statuses.at(-1), "boost ✓", "a new session starts from zero");
});

test("the awareness block is a named prompt section when pi supports them", async () => {
	const { fire } = harness();
	const sections: Record<string, string> = {};
	const patched = await fire("before_agent_start", {
		systemPrompt: "base",
		systemPromptOptions: { sections },
	});
	assert.equal(patched, undefined, "no whole-prompt replacement, so the prompt cache survives");
	// No Preview Agreement in this config: `boost retrieve` would exit 1.
	assert.match(sections["jfrog-boost"] ?? "", /`boost retrieve` fails here/);
	assert.doesNotMatch(sections["jfrog-boost"] ?? "", /retrieve <id>/);
	assert.match(sections["jfrog-boost"] ?? "", /: `bash` output\./, "shell is the one active surface here");
	assert.doesNotMatch(sections["jfrog-boost"] ?? "", /<jfrog-boost>/, "pi adds the tags itself");
});

test("the system prompt gains the Boost instructions when pi has no sections", async () => {
	const { fire } = harness({ config: fixedConfig(TERMS) });
	const patched = (await fire("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string };
	assert.ok(patched.systemPrompt.startsWith("base\n\n<jfrog-boost>\n"));
	assert.ok(patched.systemPrompt.includes("retrieve <id> --query"));
});

test("nothing is added to the system prompt when Boost is not usable", async () => {
	const { fire } = harness({ readiness: fixedReadiness({ kind: "not-responding" }) });
	assert.equal(await fire("before_agent_start", { systemPrompt: "base" }), undefined);
	const sections: Record<string, string> = { "jfrog-boost": "stale text from an earlier turn" };
	await fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections } });
	assert.equal(sections["jfrog-boost"], "", "the section is withdrawn, not left stale");
});

test("no section when no surface is active: shell gate off, no MCP tool, no terms", async () => {
	const { fire } = harness({ config: fixedConfig(CLI_OFF) });
	const sections: Record<string, string> = {};
	assert.equal(
		await fire("before_agent_start", {
			systemPrompt: "base",
			systemPromptOptions: { sections, selectedTools: ["read", "bash", "edit", "write"] },
		}),
		undefined,
	);
	assert.equal(sections["jfrog-boost"], "");
	assert.equal(await fire("before_agent_start", { systemPrompt: "base" }), undefined, "nor on the fallback");
});

test("the section follows the loadout: a hidden bash, a visible MCP tool", async () => {
	const { fire } = harness();
	const turn = async (selectedTools: string[], hiddenTools: string[] = []) => {
		const sections: Record<string, string> = {};
		await fire("before_agent_start", {
			systemPrompt: "base",
			systemPromptOptions: { sections, selectedTools, hiddenTools },
		});
		return sections["jfrog-boost"];
	};
	assert.equal(await turn(["read", "bash"], ["bash"]), "", "no visible shell, no other surface");
	assert.match(
		(await turn(["read", "bash", "mcp__slack__slack_get_users"])) ?? "",
		/: `bash` output and MCP tool results \(`mcp__\*`\)\./,
	);
});

test("both messageTypes get the same section", async () => {
	const texts: string[] = [];
	for (const messageType of ["user", "custom"] as const) {
		const { fire } = harness();
		const sections: Record<string, string> = {};
		await fire("before_agent_start", beforeAgentStartEvent("1.2", { sections, messageType }));
		texts.push(sections["jfrog-boost"] ?? "");
	}
	assert.ok(texts[0]);
	assert.equal(texts[1], texts[0]);
});

test("off PATH the model is given the quoted full path; on PATH plain `boost`", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-path-"));
	try {
		const exe = join(dir, process.platform === "win32" ? "boost.exe" : "boost");
		writeFileSync(exe, "", { mode: 0o755 });
		const sectionFor = async (env: NodeJS.ProcessEnv) => {
			const { fire } = harness({
				env,
				readiness: fixedReadiness(undefined, exe),
				config: fixedConfig(TERMS),
			});
			const sections: Record<string, string> = {};
			await fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections } });
			return sections["jfrog-boost"] ?? "";
		};
		const off = await sectionFor({ PATH: "" });
		const quoted = process.platform === "win32" ? `"${exe}"` : `'${exe}'`;
		assert.ok(off.includes(`\`${quoted} retrieve <id> --query`), off);
		assert.match(off, /`boost` is not on PATH/);
		const on = await sectionFor({ PATH: dir });
		assert.ok(on.includes("`boost retrieve <id> --query"), on);
		assert.doesNotMatch(on, /not on PATH/);
	} finally {
		removeTempDir(dir);
	}
});

test("the section is byte-identical across turns when the breaker opens, or Boost is busy", async () => {
	let state: BreakerState = { kind: "closed" };
	const breaker: Breaker = { allow: () => true, record: () => {}, reset: () => {}, state: () => state };
	const { stub } = uiExtension({ breaker });
	await start(stub);
	const turn = async () => {
		const sections: Record<string, string> = {};
		await stub.fire("before_agent_start", beforeAgentStartEvent("1.2", { sections }));
		return sections["jfrog-boost"];
	};
	const first = await turn();
	assert.ok(first);
	await stub.emitToolResult(failingBash("1.2"));
	assert.equal(await turn(), first, "a saving changes nothing");
	state = { kind: "open", until: Date.now() + 5 * 60_000, reason: "timeout" };
	await stub.emitToolResult(failingBash("1.2"));
	assert.equal(await turn(), first, "nor does the breaker opening");
	state = { kind: "half-open" } as BreakerState;
	assert.equal(await turn(), first, "or half-opening");
});

test("the section changes with /boost off and on, and with the settings", async () => {
	const { stub, settings } = uiExtension();
	await start(stub);
	const turn = async () => {
		const sections: Record<string, string> = {};
		await stub.fire("before_agent_start", beforeAgentStartEvent("1.2", { sections }));
		return sections["jfrog-boost"];
	};
	const on = await turn();
	assert.ok(on);
	await stub.command("boost", "off");
	assert.equal(await turn(), "");
	await stub.command("boost", "on");
	assert.equal(await turn(), on);
	settings.save({ awareness: false });
	assert.equal(await turn(), "");
});

test("an earlier handler that forced the system prompt gets the block appended, not a section pi never renders", async () => {
	const { stub } = uiExtension();
	await start(stub);
	const sections: Record<string, string> = {};
	const unforced = await stub.fire("before_agent_start", beforeAgentStartEvent("1.2", { sections }));
	const body = sections["jfrog-boost"];
	assert.ok(body);
	assert.deepEqual(unforced, [undefined], "the section path returns nothing");

	// As pi's runner leaves it after an earlier extension returned
	// `{ systemPrompt }`: `forceSystemPrompt` set, and `event.systemPrompt`
	// rendering the forced text (pi 1.2.0 buildSystemPromptState ignores the
	// sections then).
	const forcedSections: Record<string, string> = {};
	const forced = "You are pi.\nPreset: careful";
	const results = await stub.fire("before_agent_start", {
		...beforeAgentStartEvent("1.2", { sections: forcedSections }),
		systemPrompt: forced,
		systemPromptOptions: { sections: forcedSections, forceSystemPrompt: forced },
	});
	assert.equal(forcedSections["jfrog-boost"], undefined, "not written where it would be dropped");
	assert.deepEqual(results, [{ systemPrompt: withAwareness(forced, body) }]);
	assert.ok((results[0] as { systemPrompt: string }).systemPrompt.startsWith(forced));

	// Withdrawn (/boost off): nothing to add to a forced prompt.
	await stub.command("boost", "off");
	const off = await stub.fire("before_agent_start", {
		...beforeAgentStartEvent("1.2", { sections: {} }),
		systemPrompt: forced,
		systemPromptOptions: { sections: {}, forceSystemPrompt: forced },
	});
	assert.deepEqual(off, [undefined]);
});

test("tool telemetry is reported from the run itself, when opted in", async () => {
	const { fire, calls } = harness();
	await fire(
		"tool_execution_start",
		toolExecutionStartEvent("1.2", { toolName: "ls", toolCallId: "c9", args: { path: "." } }),
	);
	await fire(
		"tool_execution_end",
		toolExecutionEndEvent("1.2", {
			toolName: "ls",
			toolCallId: "c9",
			durationMs: 7,
			result: { content: [{ type: "text", text: "raw output" }] },
		}),
	);
	const [pre] = observed(calls, "PreToolUse");
	const [post] = observed(calls, "PostToolUse");
	assert.equal(pre?.fields.tool_name, "ls");
	assert.deepEqual(pre?.fields.tool_input, { path: "." });
	assert.equal(pre?.meta.tool_use_id, "c9");
	assert.equal(post?.fields.tool_output, "raw output");
	assert.equal(post?.fields.duration_ms, 7);
	assert.equal(post?.meta.tool_use_id, "c9");
	assert.ok(calls.indexOf(pre as Recorded) < calls.indexOf(post as Recorded), "PreToolUse comes first");
});

test("observe skips MCP tools the user excluded with mcpExclude, and only those", async () => {
	const { fire, calls } = harness({ file: { mcpExclude: ["mcp__secrets__*"] } });
	// The settings file is read at session start, as in pi.
	await fire("session_start", { reason: "startup" });
	for (const toolName of ["mcp__secrets__get", "mcp__slack__post", "secrets_tool"]) {
		await fire("tool_execution_start", toolExecutionStartEvent("1.2", { toolName, toolCallId: toolName }));
		await fire(
			"tool_execution_end",
			toolExecutionEndEvent("1.2", {
				toolName,
				toolCallId: toolName,
				result: { content: [{ type: "text", text: "body" }] },
			}),
		);
	}
	const names = calls
		.filter((c) => c.kind === "observe" && c.fields.tool_name !== undefined)
		.map((c) => c.fields.tool_name);
	assert.deepEqual(names, ["mcp__slack__post", "mcp__slack__post", "secrets_tool", "secrets_tool"]);
});

test("a tool result is not observed from tool_result any more", async () => {
	const { fire, calls } = harness();
	await fire("tool_result", result("ls"));
	assert.equal(calls.filter((c) => c.kind === "observe").length, 0);
});

test("a failed tool is reported as a failure, not a result", async () => {
	const { fire, calls } = harness();
	await fire(
		"tool_execution_end",
		toolExecutionEndEvent("0.86", {
			toolName: "grep",
			isError: true,
			result: { content: [{ type: "text", text: "raw output" }] },
		}),
	);
	assert.equal(observed(calls, "PostToolUseFailure")[0]?.fields.error_message, "raw output");
	assert.equal(observed(calls, "PostToolUse").length, 0);
});

test("with telemetry off, not one observe: tools, replies, compaction, session start", async () => {
	const { fire, calls } = harness({ filterResult: "compacted", observeEnabled: false });
	await fire("session_start", { reason: "startup" });
	await fire("tool_execution_start", toolExecutionStartEvent("1.2", { toolName: "bash" }));
	const patched = await fire("tool_result", bashResult("npm test"));
	await fire("tool_execution_end", toolExecutionEndEvent("1.2", { toolName: "bash" }));
	await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
	await fire("agent_settled", agentSettledEvent("1.2"));
	await fire("session_before_compact", { reason: "manual" });
	await fire("session_compact", {});
	assert.deepEqual((patched as { content: unknown }).content, [{ type: "text", text: "compacted" }]);
	assert.equal(calls.filter((c) => c.kind === "observe").length, 0);
});

test("no observe while Boost is known not to work or the breaker has paused it", async () => {
	const tool = async (fire: (event: string, payload: unknown) => Promise<unknown>) => {
		await fire("tool_execution_start", toolExecutionStartEvent("1.2", { toolName: "bash" }));
		await fire("tool_execution_end", toolExecutionEndEvent("1.2", { toolName: "bash" }));
	};
	for (const state of [
		{ kind: "not-responding" },
		{ kind: "unknown-version" },
		{ kind: "too-old", version: [0, 14, 0] },
		{ kind: "missing" },
	] as ReadinessState[]) {
		const { fire, calls } = harness({ readiness: fixedReadiness(state) });
		await fire("session_start", { reason: "startup" });
		await tool(fire);
		assert.equal(calls.filter((c) => c.kind === "observe").length, 0, state.kind);
	}

	// Probing still sends: a first session's sessionStart fires before the probe settles.
	const probing = harness({ readiness: fixedReadiness({ kind: "probing" }) });
	await probing.fire("session_start", { reason: "startup" });
	assert.equal(observed(probing.calls, "sessionStart").length, 1);

	// The breaker is read live: open stops observe, closed lets it through again.
	let state: BreakerState = { kind: "open", until: Date.now() + 60_000, reason: "slow" };
	const breaker: Breaker = { allow: () => true, record: () => {}, reset: () => {}, state: () => state };
	const paused = harness({ breaker });
	await tool(paused.fire);
	assert.equal(paused.calls.filter((c) => c.kind === "observe").length, 0);
	state = { kind: "closed" };
	await tool(paused.fire);
	assert.equal(paused.calls.filter((c) => c.kind === "observe").length, 2);
});

test("the assistant's reply is reported when the agent settles, not when a loop ends", async () => {
	const { fire, calls } = harness();
	await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
	await fire("agent_end", {});
	assert.equal(observed(calls, "afterAgentResponse").length, 0);
	await fire("agent_settled", agentSettledEvent("0.86"));
	assert.equal(observed(calls, "afterAgentResponse")[0]?.fields.text, "done");
});

test("an aborted run's reply is not reported", async () => {
	const { fire, calls } = harness();
	await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "half" }] } });
	await fire("agent_settled", agentSettledEvent("1.2", { aborted: true }));
	assert.equal(observed(calls, "afterAgentResponse").length, 0);
});

test("user and tool messages are not reported as assistant replies", async () => {
	const { fire, calls } = harness();
	await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "hi" }] } });
	await fire("agent_settled", agentSettledEvent("1.2"));
	assert.equal(observed(calls, "afterAgentResponse").length, 0);
});

test("compaction is reported on both sides", async () => {
	const { fire, calls } = harness();
	await fire("session_before_compact", { reason: "threshold" });
	await fire("session_compact", { reason: "threshold" });
	assert.equal(observed(calls, "preCompact")[0]?.fields.trigger, "auto");
	await fire("session_before_compact", { reason: "manual" });
	assert.equal(observed(calls, "preCompact")[1]?.fields.trigger, "manual");
	assert.equal(observed(calls, "postCompact").length, 1);
});

test("sync is scheduled when the agent settles, not when an agent loop ends", async () => {
	const { fire, calls } = harness();
	await fire("agent_end", {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(calls.filter((c) => c.kind === "sync").length, 0);
	await fire("agent_settled", agentSettledEvent("1.2"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(calls.filter((c) => c.kind === "sync").length, 1);
});

test("shutdown flushes the pending upload instead of waiting out the debounce", async () => {
	const { fire, calls } = harness();
	await fire("agent_settled", agentSettledEvent("1.2"));
	assert.equal(calls.filter((c) => c.kind === "sync").length, 0, "upload is debounced");
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(calls.filter((c) => c.kind === "sync").length, 1);
});

test("a session replacing another never syncs alongside the sync its shutdown started", async () => {
	// pi builds a fresh extension instance for /new, /resume, /fork and
	// /reload; the running child is the process's, not the instance's.
	const flight = createSyncFlight();
	const exits: (() => void)[] = [];
	const sync = (_meta: HookMeta, onExit?: (code: number | null) => void) => {
		exits.push(() => onExit?.(0));
	};
	const first = harness({ syncFlight: flight, overrides: { sync } });
	await first.fire("agent_settled", agentSettledEvent("1.2"));
	await first.fire("session_shutdown", { reason: "new" });
	assert.equal(exits.length, 1, "the shutdown flush started a sync");

	const second = harness({ syncFlight: flight, overrides: { sync } });
	await second.fire("agent_settled", agentSettledEvent("1.2"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(exits.length, 1, "the new session's settle waits for the running sync");
	exits[0]?.();
	assert.equal(exits.length, 2, "and runs once it exits");
});

test("shutdown sends no observe: `stop` records nothing measurable", async () => {
	const { fire, calls } = harness();
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(observed(calls, "stop").length, 0);
});

test("opting into telemetry shows no attribution warning: observe keeps pi (Probe 1)", async () => {
	const { fire, notices, calls } = harness();
	await fire("session_start", { reason: "startup" });
	assert.deepEqual(notices, []);
	assert.equal(observed(calls, "sessionStart").length, 1);
});

test("a missing Boost is reported once, with the command that fixes it", async () => {
	const { fire, notices } = harness({
		readiness: { ...fixedReadiness({ kind: "missing" }), binary: () => undefined },
	});
	await fire("session_start", { reason: "startup" });
	await fire("session_start", { reason: "new" });
	assert.deepEqual(notices, [MISSING_NOTICE]);
});

test("every payload carries the session id and working directory", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	await fire("tool_result", bashResult("npm test"));
	assert.ok(filterCalls(calls).length > 0);
	for (const call of calls) {
		assert.equal(call.meta.session_id, "sess-1");
		assert.equal(call.meta.cwd, "/work");
	}
});

// ---------------------------------------------------------------------------
// Readiness wiring and kill switches (spec §8.1, §9)

test("--no-boost is registered as a boolean flag that defaults to off", () => {
	const { flags } = harness();
	assert.deepEqual(flags.get("no-boost"), {
		type: "boolean",
		default: false,
		description: "Start pi with JFrog Boost off",
	});
});

const bash = () => bashResult("npm test");

/** Drive one session through every surface; return what reached Boost. */
async function everySurface(h: ReturnType<typeof harness>) {
	await h.fire("session_start", { reason: "startup" });
	const prompt = await h.fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: {} });
	const shell = await h.fire("tool_result", bash());
	const doc = await h.fire("tool_result", result("read", { isError: true, input: { path: "/docs/q3.pdf" } }));
	await h.fire("tool_execution_start", toolExecutionStartEvent("1.2", { toolName: "bash" }));
	await h.fire("tool_execution_end", toolExecutionEndEvent("1.2", { toolName: "bash" }));
	await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
	await h.fire("agent_settled", agentSettledEvent("1.2"));
	await h.fire("session_shutdown", { reason: "quit" });
	return { prompt, shell, doc };
}

for (const [label, options] of [
	["DISABLE_BOOST=1", { env: { DISABLE_BOOST: "1" } }],
	["BOOST_DISABLED=true", { env: { BOOST_DISABLED: "true" } }],
	["--no-boost", { flag: true }],
	["--no-boost=true", { flag: "true" }],
	['"enabled": false in the settings file', { file: { enabled: false } }],
] as const) {
	test(`${label} turns everything off`, async () => {
		const readiness = fixedReadiness();
		const h = harness({ filterResult: "compacted", readResult: "text", readiness, ...options });
		const { prompt, shell, doc } = await everySurface(h);
		assert.equal(prompt, undefined, "no awareness section");
		assert.equal(shell, undefined);
		assert.equal(doc, undefined);
		assert.deepEqual(h.calls, [], "nothing reached Boost: no filter, read, observe or sync");
		assert.equal(readiness.starts, 0, "not even the readiness probe");
	});
}

test("the env kill switch is read live, mid-session", async () => {
	const env: NodeJS.ProcessEnv = {};
	const h = harness({ filterResult: "compacted", env, settings: memorySettings({ env }) });
	await h.fire("session_start", { reason: "startup" });
	assert.ok(await h.fire("tool_result", bash()), "compacted while on");
	env.DISABLE_BOOST = "1";
	assert.equal(await h.fire("tool_result", bash()), undefined, "off from the next call");
	delete env.DISABLE_BOOST;
	assert.ok(await h.fire("tool_result", bash()), "and back on");
});

test("a kill switch flipped while Boost runs wins over its reply", async () => {
	const env: NodeJS.ProcessEnv = {};
	const h = harness({
		env,
		settings: memorySettings({ env }),
		overrides: {
			filter: async () => {
				env.BOOST_DISABLED = "1";
				return call("compacted");
			},
		},
	});
	assert.equal(await h.fire("tool_result", bash()), undefined);
});

test("--no-boost=false and a non-true value leave Boost on", async () => {
	for (const flag of [false, "false", "yes"] as const) {
		const h = harness({ filterResult: "compacted", flag });
		assert.ok(await h.fire("tool_result", bash()), String(flag));
	}
});

test("session_start kicks off the readiness probe without waiting for it", async () => {
	let release: (() => void) | undefined;
	let probes = 0;
	const readiness = createReadiness({
		enabled: () => true,
		resolve: () => "/fake/boost",
		stamp: () => ({ mtimeMs: 1, size: 1 }),
		probe: () => {
			probes++;
			return new Promise((resolve) => {
				release = () => resolve(call("boost v0.16.11\n"));
			});
		},
	});
	const h = harness({ filterResult: "compacted", readiness });
	const started = h.fire("session_start", { reason: "startup" });
	assert.equal(await started, undefined, "the handler returned while the probe still runs");
	assert.equal(probes, 1);
	assert.equal(readiness.state().kind, "probing");

	// A result that arrives before the probe settles passes through untouched.
	assert.equal(await h.fire("tool_result", bash()), undefined);
	assert.equal(h.calls.filter((c) => c.kind === "filter").length, 0, "and spawns nothing");

	release?.();
	await readiness.wait(1_000);
	assert.ok(await h.fire("tool_result", bash()), "compacted once Boost is ready");
	assert.equal(probes, 1, "probed once");
});

test("only the first turn waits for readiness, and at most the configured time", async () => {
	const waits: number[] = [];
	const readiness: Readiness = {
		...fixedReadiness({ kind: "probing" }),
		check: () => ({ kind: "probing" }),
		wait: async (ms) => {
			waits.push(ms);
			return { kind: "probing" };
		},
	};
	const h = harness({ readiness });
	await h.fire("session_start", { reason: "startup" });
	assert.equal(await h.fire("before_agent_start", { systemPrompt: "base" }), undefined);
	assert.equal(await h.fire("before_agent_start", { systemPrompt: "base" }), undefined);
	// The UI's own wait for the probe (to paint what it settles on) is not a turn's.
	const turnWaits = () => waits.filter((ms) => ms !== PROBE_UI_WAIT_MS);
	assert.deepEqual(turnWaits(), [50], "the first turn waited once, bounded; the second did not wait");
	await h.fire("session_start", { reason: "new" });
	await h.fire("before_agent_start", { systemPrompt: "base" });
	assert.deepEqual(turnWaits(), [50, 50], "a new session's first turn may wait again");
});

test("a first turn that waited past the probe gets the awareness section", async () => {
	let ready = false;
	const readiness: Readiness = {
		...fixedReadiness(),
		check: () => (ready ? { kind: "ready", version: [0, 16, 11] } : { kind: "probing" }),
		wait: async () => {
			ready = true;
			return { kind: "ready", version: [0, 16, 11] };
		},
	};
	const h = harness({ readiness, config: fixedConfig(TERMS) });
	await h.fire("session_start", { reason: "startup" });
	const sections: Record<string, string> = {};
	await h.fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections } });
	assert.match(sections["jfrog-boost"] ?? "", /retrieve <id> --query/);
});

test("sync honours its opt-out: PI_BOOST_SYNC=0 or sync: false", async () => {
	for (const options of [{ env: { PI_BOOST_SYNC: "0" } }, { file: { sync: false } }]) {
		const h = harness(options);
		await h.fire("session_start", { reason: "startup" });
		await h.fire("agent_settled", agentSettledEvent("1.2"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await h.fire("agent_settled", agentSettledEvent("1.2"));
		await h.fire("session_shutdown", { reason: "quit" });
		assert.equal(h.calls.filter((c) => c.kind === "sync").length, 0, JSON.stringify(options));
	}
});

test("no sync through a Boost that is too old, unreadable or not responding", async () => {
	const states: ReadinessState[] = [
		{ kind: "too-old", version: [0, 12, 1] },
		{ kind: "unknown-version" },
		{ kind: "not-responding" },
		{ kind: "missing" },
	];
	for (const state of states) {
		const h = harness({ readiness: fixedReadiness(state) });
		await h.fire("session_start", { reason: "startup" });
		await h.fire("agent_settled", agentSettledEvent("1.2"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		await h.fire("agent_settled", agentSettledEvent("1.2"));
		await h.fire("session_shutdown", { reason: "quit" });
		assert.equal(h.calls.filter((c) => c.kind === "sync").length, 0, state.kind);
	}
});

test("an invalid settings key is reported once, as a warning naming the key", async () => {
	const h = harness({ file: { minBytes: "lots" } });
	await h.fire("session_start", { reason: "startup" });
	await h.fire("session_start", { reason: "new" });
	const warnings = h.notices.filter((n) => n.includes("minBytes"));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /ignored invalid "minBytes" in .*jfrog-boost\.json \(using 2048\)/);
});

// With the real client and the Node stand-in: proves the kill switch holds
// at the process level, version probe included, not just in the stubs.
const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-ext-"));
after(() => removeTempDir(root));

test("with DISABLE_BOOST=1 not a single Boost process starts, probe included", async () => {
	const log = join(root, "kill-switch.jsonl");
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		SYSTEMROOT: process.env.SYSTEMROOT,
		DISABLE_BOOST: "1",
		FAKE_BOOST_MODE: "compact-to",
		FAKE_BOOST_OUTPUT: "compacted",
		FAKE_BOOST_LOG: log,
		PI_BOOST_OBSERVE: "1",
	};
	const client = createBoostClient({
		env,
		home: root,
		resolveBinary: () => join(import.meta.dirname, "fixtures", "fake-boost.mjs"),
		launcher: (exe) => ({ file: process.execPath, args: [exe] }),
		config: fixedConfig().read,
	});
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
	} as unknown as ExtensionAPI;
	createBoostExtension(pi, { client, env, settings: memorySettings({ env }), config: fixedConfig() });
	const ctx = {
		cwd: root,
		hasUI: false,
		sessionManager: { getSessionId: () => "s" },
		ui: { notify: () => {}, setStatus: () => {} },
	} as unknown as ExtensionContext;
	const fire = async (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload as never, ctx);
	};
	await fire("session_start", { reason: "startup" });
	await fire("before_agent_start", { systemPrompt: "base" });
	await fire("tool_result", { ...bash(), content: [{ type: "text", text: "x".repeat(4096) }] });
	await fire("agent_settled", {});
	await fire("session_shutdown", { reason: "quit" });
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(existsSync(log), false, "the stand-in never ran");
});

// ---------------------------------------------------------------------------
// Tool-result integrity (spec §1 invariant 5, §4, §16.2), on both pi lines

const STRUCTURED = { output: NOISY, truncated: false, exit_code: 1, wall_time_seconds: 0.4 };

/** The extension on the shared host stub, with a client that records every call. */
function onStub(
	line: PiLine,
	options: { client?: Partial<BoostClient>; env?: NodeJS.ProcessEnv; file?: Record<string, unknown> } = {},
) {
	const stub = createPiStub({ line });
	const used: string[] = [];
	const record =
		<T>(name: string, value: T) =>
		(..._args: unknown[]) => {
			used.push(name);
			return value;
		};
	const client = stubClient({
		filter: async () => {
			used.push("filter");
			return call(
				"3 failures\n[Boost compressed ~97%. Get the full original output simply with: boost retrieve 12]",
			);
		},
		convert: record("convert", Promise.resolve(call("", 1))),
		mcp: record("mcp", Promise.resolve(call(""))),
		observeDetached: record("observeDetached", undefined),
		sync: record("sync", undefined),
		...options.client,
	});
	const env = options.env ?? { PI_BOOST_OBSERVE: "1" };
	createBoostExtension(stub.pi, {
		client,
		env,
		settings: memorySettings({ env, ...(options.file ? { file: options.file } : {}) }),
		config: fixedConfig(CLI_ON),
		readiness: fixedReadiness(),
		notices: createNotices(),
	});
	return { stub, used };
}

const failingBash = (line: PiLine, over: Record<string, unknown> = {}) =>
	toolResultEvent(line, {
		toolName: "bash",
		input: { command: "npm test" },
		content: `${NOISY}\n\nCommand exited with code 1`,
		isError: true,
		structuredContent: STRUCTURED,
		details: undefined,
		...over,
	});

test("a nested call never reaches the client, observe included", async () => {
	const { stub, used } = onStub("1.2");
	const event = failingBash("1.2", { parentToolCallId: "parent-1", toolCallId: "parent-1/1" });
	assert.equal(await stub.emitToolResult(event), undefined);
	assert.equal(used.length, 0, `no filter, no observe — nothing at all: ${used.join(", ")}`);
	assert.deepEqual(stub.errors, []);
	// The same call without a parent is compacted, so the skip is the parent's doing.
	assert.ok(await stub.emitToolResult(failingBash("1.2")));
	assert.ok(used.includes("filter"));
});

test("on pi 1.2, structuredContent comes back identical with the compacted content", async () => {
	const { stub } = onStub("1.2");
	const event = failingBash("1.2");
	const patch = await stub.emitToolResult(event);
	assert.ok(patch, "compacted");
	assert.equal(patch.structuredContent, STRUCTURED, "the very same value, not a copy or a drop");
	assert.deepEqual(STRUCTURED.output, NOISY, "and untouched");
	assert.match(
		textOfBlocks(patch.content),
		/^3 failures\n\[Boost compressed ~97%[^\n]*\]\n\nCommand exited with code 1$/,
	);
	assert.equal(patch.isError, true);
	assert.deepEqual((patch.details as { jfrogBoost?: unknown }).jfrogBoost, {
		kind: "compacted",
		before: event.content[0]?.type === "text" ? event.content[0].text.length : -1,
		after: textOfBlocks(patch.content).length,
		retrieveId: 12,
	});
	assert.deepEqual(stub.errors, []);
});

test("on pi 1.2, a compacted log read keeps structuredContent too", async () => {
	const { stub } = onStub("1.2", { file: { readLogs: true } });
	await stub.fire("session_start", { type: "session_start", reason: "startup" });
	const structured = { content: NOISY };
	const event = toolResultEvent("1.2", {
		toolName: "read",
		input: { path: "build.log" },
		content: NOISY,
		structuredContent: structured,
	});
	const patch = await stub.emitToolResult(event);
	assert.ok(patch, "compacted");
	assert.equal(patch.structuredContent, structured);
});

test("on pi 0.86, the same result is compacted without inventing structuredContent", async () => {
	const { stub } = onStub("0.86");
	const patch = await stub.emitToolResult(failingBash("0.86"));
	assert.ok(patch, "compacted");
	assert.equal("structuredContent" in patch, false);
	assert.match(textOfBlocks(patch.content), /^3 failures\n/);
	assert.deepEqual(stub.errors, []);
});

test("the tool's own details are kept, and only a plain object gains jfrogBoost", async () => {
	const own = { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-1.log" };
	const { stub } = onStub("1.2");
	const merged = await stub.emitToolResult(failingBash("1.2", { details: own }));
	const details = merged?.details as Record<string, unknown> | undefined;
	assert.deepEqual(details?.truncation, own.truncation);
	assert.equal(details?.fullOutputPath, own.fullOutputPath);
	assert.equal((details?.jfrogBoost as { kind?: string } | undefined)?.kind, "compacted");
	for (const details of [["custom"], "text", 7]) {
		const patch = await stub.emitToolResult(failingBash("1.2", { details }));
		assert.ok(patch, "still compacted");
		assert.deepEqual(patch.details, details, `${JSON.stringify(details)} is left as it was`);
	}
});

test("a throwing client never throws to pi", async () => {
	const boom = () => {
		throw new Error("boost exploded");
	};
	const reject = async () => {
		throw new Error("boost exploded");
	};
	for (const line of ["0.86", "1.2"] as const) {
		const { stub } = onStub(line, {
			client: {
				filter: reject,
				convert: reject,
				mcp: reject,
				version: reject,
				exec: reject,
				observeDetached: boom,
				sync: boom,
				killAll: boom,
				refresh: boom,
			},
		});
		const ctx = stub.ctx();
		await stub.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		await stub.fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: {} }, ctx);
		assert.equal(await stub.emitToolResult(failingBash(line), ctx), undefined, line);
		await stub.fire(
			"message_end",
			{ message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
			ctx,
		);
		await stub.fire("tool_execution_start", toolExecutionStartEvent(line, { toolName: "bash" }), ctx);
		await stub.fire("tool_execution_end", toolExecutionEndEvent(line, { toolName: "bash" }), ctx);
		await stub.fire("agent_settled", agentSettledEvent(line), ctx);
		await stub.fire("session_before_compact", { reason: "manual" }, ctx);
		await stub.fire("session_compact", {}, ctx);
		await stub.fire("session_shutdown", { reason: "quit" }, ctx);
		assert.deepEqual(stub.errors, [], `${line}: every handler kept the throw to itself`);
	}
});

test("a stale context, whose getters throw, never throws to pi", async () => {
	// pi 1.2 makes `ctx.sessionManager` and `ctx.cwd` getters that throw once
	// the context is stale; building hook metadata reads both.
	for (const line of ["0.86", "1.2"] as const) {
		const { stub } = onStub(line);
		const ctx = stub.ctx();
		await stub.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		for (const key of ["sessionManager", "cwd"]) {
			Object.defineProperty(ctx, key, {
				get() {
					throw new Error("This extension ctx is stale");
				},
			});
		}
		await stub.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
		assert.equal(await stub.emitToolResult(failingBash(line), ctx), undefined, line);
		await stub.fire(
			"message_end",
			{ message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
			ctx,
		);
		await stub.fire("tool_execution_start", toolExecutionStartEvent(line, { toolName: "bash" }), ctx);
		await stub.fire("tool_execution_end", toolExecutionEndEvent(line, { toolName: "bash" }), ctx);
		await stub.fire("agent_settled", agentSettledEvent(line), ctx);
		await stub.fire("session_before_compact", { reason: "manual" }, ctx);
		await stub.fire("session_compact", {}, ctx);
		await stub.fire("session_shutdown", { reason: "quit" }, ctx);
		assert.deepEqual(stub.errors, [], `${line}: every handler kept the throw to itself`);
	}
});

test("loading the extension twice in one process keeps the two apart (reload)", async () => {
	const first = onStub("1.2");
	const second = onStub("1.2");
	await first.stub.fire("session_start", { type: "session_start", reason: "startup" });
	await second.stub.fire("session_start", { type: "session_start", reason: "reload" });
	const secondSoFar = second.used.length;
	assert.ok(await first.stub.emitToolResult(failingBash("1.2")), "the first instance compacts");
	assert.equal(second.used.length, secondSoFar, "nothing the first did reached the second's client");
	const footer = (stub: typeof first.stub) => stub.ui.statuses.at(-1)?.text;
	const firstSaving = footer(first.stub);
	assert.match(firstSaving ?? "", /saved/, "the first instance counted its saving");
	assert.equal(footer(second.stub), "boost ✓", "the second saw none of it");

	const before = first.used.length;
	assert.ok(await second.stub.emitToolResult(failingBash("1.2")), "the second compacts on its own");
	assert.equal(first.used.length, before, "and nothing crossed back");
	// A new session in one resets only that one.
	await second.stub.fire("session_start", { type: "session_start", reason: "new" });
	assert.ok(await first.stub.emitToolResult(failingBash("1.2")));
	assert.notEqual(footer(first.stub), firstSaving, "the first kept its running total, and added to it");
	assert.match(footer(first.stub) ?? "", /saved/);
});

// ---------------------------------------------------------------------------
// The shell gate, with the real client and the Node stand-in (spec §8.4)

async function gateRun(config: string, env: NodeJS.ProcessEnv) {
	const log = join(root, `gate-${Math.random().toString(36).slice(2)}.jsonl`);
	const childEnv: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		SYSTEMROOT: process.env.SYSTEMROOT,
		FAKE_BOOST_MODE: "compact-to",
		FAKE_BOOST_OUTPUT: "3 failures",
		FAKE_BOOST_LOG: log,
		...env,
	};
	const settings = memorySettings({ env: childEnv });
	const configReader = fixedConfig(config);
	const client = createBoostClient({
		env: childEnv,
		home: root,
		resolveBinary: () => join(import.meta.dirname, "fixtures", "fake-boost.mjs"),
		launcher: (exe) => ({ file: process.execPath, args: [exe] }),
		config: configReader.read,
		shellMode: () => settings.effective().shell,
		breaker: createBreaker(),
	});
	const stub = createPiStub({ cwd: root });
	createBoostExtension(stub.pi, {
		client,
		env: childEnv,
		settings,
		config: configReader,
		readiness: fixedReadiness(),
	});
	const patch = await stub.emitToolResult(failingBash("1.2"));
	const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
	return {
		patch,
		spawns: lines.map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }),
	};
}

test("with the shell gate off, not a single Boost process starts", async () => {
	const off = await gateRun(CLI_OFF, {});
	assert.equal(off.patch, undefined);
	assert.deepEqual(off.spawns, [], "user = false: zero spawns");
	const unknown = await gateRun("", {});
	assert.deepEqual(unknown.spawns, [], "flag unrecorded on v0.16.11: Boost's default is off, zero spawns");
	const settingOff = await gateRun(CLI_ON, { PI_BOOST_SHELL: "off" });
	assert.deepEqual(settingOff.spawns, [], "shell: off wins over the flag");
});

test("shell: on forces CLI filtering for pi's own Boost call only", async () => {
	const on = await gateRun(CLI_OFF, { PI_BOOST_SHELL: "on" });
	assert.ok(on.patch, "compacted although config says user = false (F1)");
	assert.equal(on.spawns.length, 1);
	assert.equal(on.spawns[0]?.env.BOOST_FEATURE_FLAGS_FORCE_ENABLED, "boost-cli-filtering");
});

// ---------------------------------------------------------------------------
// The full-output re-filter (spec §6.3), wired

const fullRoot = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-full-"));
after(() => removeTempDir(fullRoot));

test("a bash result pi truncated is re-filtered from its full-output file", async () => {
	const path = join(fullRoot, "pi-bash-00000000000000aa.log");
	const run = ["not ok 1 - early failure", NOISY, NOISY].join("\n");
	writeFileSync(path, run);
	const tail = `${NOISY}\n\n[Showing lines 201-401 of 401. Full output: ${path}]\n\nCommand exited with code 1`;
	const sent: { text: string; maxInputBytes?: number }[] = [];
	const counters = createCounters();
	const { fire } = harness({
		counters,
		overrides: {
			filter: async (_meta, text, options) => {
				sent.push({ text, ...(options?.maxInputBytes ? { maxInputBytes: options.maxInputBytes } : {}) });
				return call("not ok 1 - early failure\n# pass 400");
			},
		},
	});
	const patched = (await fire(
		"tool_result",
		bashResult("npm test", tail, { isError: true, details: { truncation: {}, fullOutputPath: path } }),
	)) as { content: { text: string }[]; details: { jfrogBoost: Record<string, unknown> }; isError?: boolean };
	assert.deepEqual(
		sent,
		[{ text: run, maxInputBytes: 2 * 1024 * 1024 }],
		"the whole run, under the 2 MiB ceiling",
	);
	assert.equal(
		patched.content[0]?.text,
		`not ok 1 - early failure\n# pass 400\n\n[Boost compacted the full 401-line output. Full output: ${path}]\n\nCommand exited with code 1`,
	);
	assert.equal("isError" in patched, false, "isError is left as the tool set it");
	assert.equal(patched.details.jfrogBoost.full, true);
	assert.deepEqual(counters.skips(), {});
});

test("a truncated result whose file is gone is compacted from pi's tail instead", async () => {
	const path = join(fullRoot, "pi-bash-00000000000000bb.log");
	const tail = `${NOISY}\n\n[Showing lines 201-401 of 401. Full output: ${path}]`;
	const counters = createCounters();
	const { fire, calls } = harness({ filterResult: "compacted", counters });
	const patched = (await fire(
		"tool_result",
		bashResult("npm test", tail, { details: { fullOutputPath: path } }),
	)) as {
		content: { text: string }[];
	};
	assert.deepEqual(
		filterCalls(calls).map((c) => c.text),
		[NOISY],
	);
	assert.equal(patched.content[0]?.text, `compacted\n\n[Showing lines 201-401 of 401. Full output: ${path}]`);
	assert.equal(counters.skips()["full-unreadable"], 1);
});

// ---------------------------------------------------------------------------
// Footer, notices, persisted stats and badges (spec §10.1, §10.3–§10.5)

interface UiOptions {
	line?: PiLine;
	config?: string;
	readiness?: Readiness;
	breaker?: Breaker;
	file?: Record<string, unknown>;
	branch?: unknown[];
	entries?: unknown[];
	notices?: Notices;
	client?: Partial<BoostClient>;
	settings?: SettingsStore;
	env?: NodeJS.ProcessEnv;
}

/** The extension on the shared stub with a UI, compacting every shell result it is sent. */
function uiExtension(options: UiOptions = {}) {
	const line = options.line ?? "1.2";
	const stub = createPiStub({
		line,
		...(options.branch ? { branch: options.branch } : {}),
		...(options.entries ? { entries: options.entries } : {}),
	});
	const settings = options.settings ?? memorySettings(options.file ? { file: options.file } : {});
	const ext = createBoostExtension(stub.pi, {
		client: stubClient({
			filter: async () =>
				call(
					"3 failures\n[Boost compressed ~97%. Get the full original output simply with: boost retrieve 12]",
				),
			...options.client,
		}),
		env: options.env ?? {},
		settings,
		config: fixedConfig(options.config ?? CLI_ON),
		readiness: options.readiness ?? fixedReadiness(),
		breaker: options.breaker ?? createBreaker(),
		syncFlight: createSyncFlight(),
		notices: options.notices ?? createNotices(),
	});
	const statusTexts = () => stub.ui.statuses.map((s) => s.text);
	const noticeTexts = () => stub.ui.notices.map((n) => n.message);
	return { stub, ext, settings, statusTexts, noticeTexts };
}

const start = (stub: ReturnType<typeof createPiStub>, reason = "startup") =>
	stub.fire("session_start", { type: "session_start", reason });
const settle = (stub: ReturnType<typeof createPiStub>) =>
	stub.fire("agent_settled", agentSettledEvent(stub.line));

test("the footer follows the state, painted only when its text changes", async () => {
	const { stub, statusTexts } = uiExtension();
	await start(stub);
	assert.deepEqual(statusTexts(), ["boost ✓"]);
	// Results that save nothing leave the footer as it is: no setStatus at all.
	for (let i = 0; i < 3; i++) {
		await stub.emitToolResult(
			toolResultEvent("1.2", { toolName: "read", input: { path: "a.ts" }, content: "x" }),
		);
	}
	await stub.fire("before_agent_start", beforeAgentStartEvent("1.2", { sections: {} }));
	await settle(stub);
	assert.deepEqual(statusTexts(), ["boost ✓"]);
	await stub.emitToolResult(failingBash("1.2"));
	assert.equal(statusTexts().length, 2);
	assert.match(statusTexts()[1] ?? "", /^boost ✓ ~1\.\dk saved \(\d+%\)$/);
	assert.ok(stub.ui.statuses.every((s) => s.key === "jfrog-boost"));
});

test("with CLI filtering off the footer says so; with Boost missing or too old, it says that", async () => {
	const off = uiExtension({ config: CLI_OFF });
	await start(off.stub);
	assert.deepEqual(off.statusTexts(), ["boost ✓ shell off"]);

	const missing = uiExtension({
		readiness: { ...fixedReadiness({ kind: "missing" }), binary: () => undefined },
	});
	await start(missing.stub);
	assert.deepEqual(missing.statusTexts(), ["boost: not installed (/boost install)"]);

	const old = uiExtension({ readiness: fixedReadiness({ kind: "too-old", version: [0, 12, 1] }) });
	await start(old.stub);
	assert.deepEqual(old.statusTexts(), ["boost: v0.12.1 too old"]);
	assert.deepEqual(old.noticeTexts(), [tooOldNotice([0, 12, 1])]);
});

test("footer: false clears the slot", async () => {
	const { stub, settings, statusTexts } = uiExtension();
	await start(stub);
	assert.deepEqual(statusTexts(), ["boost ✓"]);
	settings.save({ footer: false });
	await stub.emitToolResult(failingBash("1.2"));
	assert.deepEqual(statusTexts(), ["boost ✓", undefined]);

	const never = uiExtension({ file: { footer: false } });
	await start(never.stub);
	await never.stub.emitToolResult(failingBash("1.2"));
	assert.deepEqual(never.statusTexts(), [], "never shown, nothing to clear");
});

test("the shell-off notice comes on the first ready session with the gate off, once per process", async () => {
	const notices = createNotices();
	const first = uiExtension({ config: CLI_DEFAULT, notices });
	await start(first.stub);
	await start(first.stub, "new");
	// A reload builds a new instance; the process registry is shared.
	const reloaded = uiExtension({ config: CLI_DEFAULT, notices });
	await start(reloaded.stub, "reload");
	assert.deepEqual(first.noticeTexts(), [shellOffNotice({ documents: false, mcp: true })]);
	assert.deepEqual(reloaded.noticeTexts(), []);

	const chosen = uiExtension({ config: CLI_DEFAULT, file: { shell: "off" } });
	await start(chosen.stub);
	assert.deepEqual(chosen.noticeTexts(), [], "the user turned it off; no need to say how to turn it on");
	const on = uiExtension({ config: CLI_ON });
	await start(on.stub);
	assert.deepEqual(on.noticeTexts(), []);
});

test("the shell-off notice names the cause, and says nothing when the user turned it off in Boost", async () => {
	const remote = uiExtension({ config: CLI_REMOTE_OFF });
	await start(remote.stub);
	assert.deepEqual(remote.noticeTexts(), [shellOffNotice({ documents: false, mcp: true }, "remote")]);
	assert.match(remote.noticeTexts()[0] ?? "", /JFrog's remote flag/);
	assert.doesNotMatch(remote.noticeTexts()[0] ?? "", /Boost's default/);

	// The user's own Boost flag, or the force-disabled environment variable:
	// their choice, which the notice would only offer to undo.
	const userFlag = uiExtension({ config: CLI_OFF });
	await start(userFlag.stub);
	assert.equal(userFlag.statusTexts().at(-1), "boost ✓ shell off");
	assert.deepEqual(userFlag.noticeTexts(), [], "user = false");
	const forced = uiExtension({
		config: CLI_DEFAULT,
		env: { BOOST_FEATURE_FLAGS_FORCE_DISABLED: "boost-cli-filtering" },
	});
	await start(forced.stub);
	assert.equal(forced.statusTexts().at(-1), "boost ✓ shell off");
	assert.deepEqual(forced.noticeTexts(), [], "BOOST_FEATURE_FLAGS_FORCE_DISABLED");
	// Force-disabled beats a remote true and a user true alike.
	const forcedOverRemote = uiExtension({
		config: `[feature_flags."boost-cli-filtering"]\nremote = true\n`,
		env: { BOOST_FEATURE_FLAGS_FORCE_DISABLED: "boost-cli-filtering" },
	});
	await start(forcedOverRemote.stub);
	assert.deepEqual(forcedOverRemote.noticeTexts(), []);
});

test("the shell-off notice names only what is still handled", async () => {
	const terms = `accept_terms = "yes"\n${CLI_DEFAULT}`;
	const both = uiExtension({ config: terms });
	await start(both.stub);
	assert.deepEqual(both.noticeTexts(), [shellOffNotice({ documents: true, mcp: true })]);

	// Boost 0.14.6–0.15.2 has no MCP route; documents still convert.
	const oldBoost = uiExtension({
		config: terms,
		readiness: fixedReadiness({ kind: "ready", version: [0, 15, 2] }),
	});
	await start(oldBoost.stub);
	assert.deepEqual(oldBoost.noticeTexts(), [shellOffNotice({ documents: true, mcp: false })]);

	// pi 1.x's default codemode exposure: every MCP call is nested inside the
	// codemode tool and never compacted, so MCP is not said to be handled.
	const codemode = uiExtension({ config: terms });
	Object.assign(codemode.stub.pi, {
		getAllTools: () => [
			{ name: "codemode", exposure: "model-only" },
			{ name: "mcp__slack__slack_get_users", exposure: "deferred" },
		],
		getActiveTools: () => ["read", "bash", "codemode"],
	});
	await start(codemode.stub);
	assert.deepEqual(codemode.noticeTexts(), [shellOffNotice({ documents: true, mcp: false })]);
	assert.doesNotMatch(codemode.noticeTexts()[0] ?? "", /MCP/);

	// Both switched off in settings: nothing is said to be handled.
	const neither = uiExtension({ config: terms, file: { documents: false, mcp: false } });
	await start(neither.stub);
	assert.deepEqual(neither.noticeTexts(), [shellOffNotice({ documents: false, mcp: false })]);
	assert.doesNotMatch(neither.noticeTexts()[0] ?? "", /still handled/);
});

test("disabled filters are announced once", async () => {
	const notices = createNotices();
	const config = `${CLI_ON}[filters]\ndisabled = ["npm-test"]\n`;
	const a = uiExtension({ config, notices });
	await start(a.stub);
	await start(a.stub, "new");
	assert.deepEqual(a.noticeTexts(), [filtersDisabledNotice(["npm-test"])]);
});

test("a missing Boost is announced once per process, across reloads", async () => {
	const notices = createNotices();
	const readiness = { ...fixedReadiness({ kind: "missing" }), binary: () => undefined };
	const a = uiExtension({ readiness, notices });
	const b = uiExtension({ readiness, notices });
	await start(a.stub);
	await start(b.stub, "reload");
	assert.deepEqual([...a.noticeTexts(), ...b.noticeTexts()], [MISSING_NOTICE]);
});

test("when the breaker opens: the paused notice once per opening, and the footer says paused", async () => {
	let state: BreakerState = { kind: "closed" };
	const breaker: Breaker = { allow: () => true, record: () => {}, reset: () => {}, state: () => state };
	const { stub, statusTexts, noticeTexts } = uiExtension({ breaker });
	await start(stub);
	state = { kind: "open", until: Date.now() + 5 * 60_000, reason: "timeout" };
	await stub.emitToolResult(failingBash("1.2"));
	await stub.emitToolResult(failingBash("1.2"));
	assert.equal(statusTexts().at(-1), "boost: paused (slow)");
	assert.deepEqual(noticeTexts(), [pausedNotice("timeout", 5)]);
	// Re-opened later: the footer says it again; the notice was given.
	state = { kind: "closed" };
	await stub.emitToolResult(toolResultEvent("1.2", { toolName: "ls", content: "a" }));
	assert.equal(statusTexts().at(-1), "boost ✓");
	state = { kind: "open", until: Date.now() + 10 * 60_000, reason: "slow" };
	await stub.emitToolResult(toolResultEvent("1.2", { toolName: "ls", content: "a" }));
	await stub.emitToolResult(toolResultEvent("1.2", { toolName: "ls", content: "a" }));
	assert.equal(statusTexts().at(-1), "boost: paused (slow)");
	// A new opening (a failed trial, or a new pause) is announced too, once.
	assert.deepEqual(noticeTexts(), [pausedNotice("timeout", 5), pausedNotice("slow", 10)]);
});

test("a pause outlives the session: the next one stays paused and is not told again", async () => {
	const breaker = createBreaker();
	const first = uiExtension({ breaker });
	await start(first.stub);
	for (let i = 0; i < 3; i++) breaker.record({ ...call(""), timedOut: true }, 10);
	await first.stub.emitToolResult(toolResultEvent("1.2", { toolName: "ls", content: "a" }));
	assert.equal(first.noticeTexts().length, 1, "the opening is announced");
	await first.stub.fire("session_shutdown", { type: "session_shutdown", reason: "new" });

	// /new: a fresh instance on the same process-wide breaker.
	const second = uiExtension({ breaker });
	await start(second.stub, "new");
	await second.stub.emitToolResult(toolResultEvent("1.2", { toolName: "ls", content: "a" }));
	assert.equal(second.statusTexts().at(-1), "boost: paused (slow)");
	assert.deepEqual(second.noticeTexts(), [], "the same opening is not announced twice");
});

/** The `jfrog-boost-stats` entries appended so far, as session entries. */
const statsEntries = (stub: ReturnType<typeof createPiStub>) =>
	stub.appended
		.filter((a) => a.customType === STATS_ENTRY)
		.map((a, i) => ({ type: "custom", id: `s${i}`, customType: a.customType, data: a.data }));

test("stats are appended on settle and shutdown, only when they changed, numbers only", async () => {
	const { stub } = uiExtension();
	await start(stub);
	await settle(stub);
	assert.equal(statsEntries(stub).length, 0, "nothing happened, nothing written");
	const patch = await stub.emitToolResult(failingBash("1.2"));
	await settle(stub);
	await settle(stub);
	assert.equal(statsEntries(stub).length, 1, "one entry for the change, none for the idle settle");
	await stub.emitToolResult(
		toolResultEvent("1.2", { toolName: "bash", input: { command: "ls" }, content: "a" }),
	);
	await stub.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(statsEntries(stub).length, 2, "shutdown writes what changed since");

	// Nothing a tool printed or was asked is in an entry or in details.
	const persisted = JSON.stringify(stub.appended);
	for (const secret of ["npm test", "ok 1 - case 1", "3 failures", "Command exited"]) {
		assert.equal(persisted.includes(secret), false, `entry holds ${secret}`);
		assert.equal(JSON.stringify(patch?.details).includes(secret), false, `details hold ${secret}`);
	}
	const leaves: unknown[] = [];
	const walk = (v: unknown) =>
		typeof v === "object" && v !== null ? Object.values(v).forEach(walk) : leaves.push(v);
	walk(statsEntries(stub).map((e) => e.data));
	assert.ok(leaves.every((leaf) => typeof leaf === "number"));
});

test("stats survive a resume and a fork, and a new session starts from zero", async () => {
	const first = uiExtension();
	await start(first.stub);
	await first.stub.emitToolResult(failingBash("1.2"));
	await settle(first.stub);
	const saved = first.statusTexts().at(-1);
	assert.match(saved ?? "", /saved/);
	const branch = [{ type: "message", id: "m1" }, ...statsEntries(first.stub)];

	const resumed = uiExtension({ branch });
	await start(resumed.stub, "resume");
	assert.equal(resumed.statusTexts().at(-1), saved, "resume: the footer carries on");
	assert.match(resumed.ext.statusReport(), /\n {2}session {3}~\S+ tokens saved \(\d+%\) — bash /);

	const forked = uiExtension({ branch: [...branch, { type: "message", id: "m2" }] });
	await start(forked.stub, "fork");
	assert.equal(forked.statusTexts().at(-1), saved, "fork: the branch's numbers come along");
	await forked.stub.emitToolResult(failingBash("1.2"));
	await settle(forked.stub);
	const after = forked.stub.appended.at(-1)?.data as { buckets: { bash: { compacted: number } } };
	assert.equal(after.buckets.bash.compacted, 2, "and are added to");

	const fresh = uiExtension({ branch: [], entries: branch });
	await start(fresh.stub, "new");
	assert.equal(fresh.statusTexts().at(-1), "boost ✓", "an empty branch is a session with nothing saved");
});

test("/tree: unsaved stats land on the branch left, and the branch arrived at brings its own", async () => {
	const { stub, statusTexts } = uiExtension();
	await start(stub);
	await stub.emitToolResult(failingBash("1.2"));
	assert.match(statusTexts().at(-1) ?? "", /saved/);
	// Not settled yet: the before-tree handler writes it to the old branch.
	await stub.fire("session_before_tree", { type: "session_before_tree" });
	assert.equal(statsEntries(stub).length, 1);

	// Back to a point before any of it: nothing saved there.
	const earlier = stub.ctx({ sessionManager: { getSessionId: () => "sess-1", getBranch: () => [] } });
	await stub.fire("session_tree", { type: "session_tree", newLeafId: "m0", oldLeafId: "m9" }, earlier);
	assert.equal(statusTexts().at(-1), "boost ✓");
	await settle(stub);
	assert.equal(statsEntries(stub).length, 1, "the old branch's numbers are not written to the new one");

	// And to a branch that has its own.
	const saved = [{ type: "message", id: "m1" }, ...statsEntries(stub)];
	const other = stub.ctx({ sessionManager: { getSessionId: () => "sess-1", getBranch: () => saved } });
	await stub.fire("session_tree", { type: "session_tree", newLeafId: "m1", oldLeafId: "m0" }, other);
	assert.match(statusTexts().at(-1) ?? "", /saved/);
});

test("two copies in one runner: the second leaves a result the first changed alone", async () => {
	const stub = createPiStub({ line: "1.2" });
	const filters = [0, 0];
	for (const i of [0, 1]) {
		createBoostExtension(stub.pi, {
			client: stubClient({
				filter: async () => {
					filters[i] = (filters[i] ?? 0) + 1;
					// Still long enough to be worth another call, and a new id.
					return call(`${NOISY.slice(0, 3000)}\n[Boost compressed ~50%. boost retrieve ${i + 1}]`);
				},
			}),
			env: {},
			settings: memorySettings({ file: { minBytes: 100 } }),
			config: fixedConfig(CLI_ON),
			readiness: fixedReadiness(),
			notices: createNotices(),
		});
	}
	await start(stub);
	const patch = await stub.emitToolResult(failingBash("1.2"));
	assert.deepEqual(filters, [1, 0], "Boost ran once for one result");
	assert.match(textOfBlocks(patch?.content), /boost retrieve 1\b/, "the first copy's retrieve id stands");
	const details = patch?.details as { jfrogBoost?: { retrieveId?: number } } | undefined;
	assert.equal(details?.jfrogBoost?.retrieveId, 1);
});

test("a compacted result gets a badge through the registered renderer", async () => {
	const { stub } = uiExtension();
	await start(stub);
	assert.equal(stub.renderers.length, 1);
	const patch = await stub.emitToolResult(failingBash("1.2"));
	const resolver = stub.renderers[0] as (
		name: string,
		next: () => unknown,
	) => {
		renderResult: (...args: unknown[]) => { render(w: number): string[] };
	};
	const inner = { render: () => ["output"], invalidate: () => {} };
	const renderers = resolver("bash", () => ({ renderResult: () => inner }));
	const lines = renderers.renderResult(
		{ content: patch?.content, details: patch?.details },
		{},
		plainTheme,
		{},
	);
	assert.ok(patch);
	const { before, after } = (patch.details as { jfrogBoost: { before: number; after: number } }).jfrogBoost;
	const tokens = ((before - after) / 4 / 1000).toFixed(1);
	const share = Math.round(((before - after) / before) * 100);
	assert.deepEqual(lines.render(120), ["output", `boost −${tokens}k tokens (${share}%) · boost retrieve 12`]);
});

test("no renderer is registered on 0.86", async () => {
	const { stub } = uiExtension({ line: "0.86" });
	await start(stub);
	assert.deepEqual(stub.renderers, []);
});

test("/boost status is built from the live state without spawning", async () => {
	const spawned: string[] = [];
	const { stub, ext } = uiExtension({
		client: {
			exec: async (args) => {
				spawned.push(args.join(" "));
				return call("");
			},
		},
	});
	await start(stub);
	await stub.emitToolResult(failingBash("1.2"));
	await stub.emitToolResult(
		toolResultEvent("1.2", { toolName: "bash", input: { command: "ls" }, content: "a" }),
	);
	const report = ext.statusReport();
	assert.match(report, /^JFrog Boost — ready\n {2}binary {4}\/fake\/boost {2}v0\.16\.11 \(validated\)/);
	assert.match(report, /\n {2}shell {5}auto → on \(Boost flag boost-cli-filtering: user=true\)\n/);
	assert.match(report, /\n {2}skipped {3}small 1 · exact 0/);
	assert.deepEqual(spawned, []);
	assert.equal(ext.footerText(), stub.ui.statuses.at(-1)?.text);
});

test("a conversion that grew the text never cancels a shell saving in the footer or /boost status", async () => {
	const page = Array.from({ length: 600 }, (_, i) => `row ${i + 1} of the quarterly table`).join("\n");
	const { stub, ext, statusTexts } = uiExtension({
		config: TERMS,
		client: { convert: async () => call(page) },
	});
	await start(stub);
	await stub.emitToolResult(failingBash("1.2"));
	const afterBash = statusTexts().at(-1);
	assert.match(afterBash ?? "", /^boost ✓ ~\S+ saved \(\d+%\)$/);
	// pi's raw read of a stored .docx is short; the converted page is not.
	const converted = await stub.emitToolResult(
		toolResultEvent("1.2", { toolName: "read", input: { path: DOCX_PATH }, content: RAW }),
	);
	assert.equal((converted?.details as { jfrogBoost?: { kind?: string } })?.jfrogBoost?.kind, "converted");
	const removed = Number(/~([\d.]+)k? saved/.exec(statusTexts().at(-1) ?? "")?.[1]);
	assert.equal(
		Number(/~([\d.]+)k? saved/.exec(afterBash ?? "")?.[1]),
		removed,
		"the saving stays; only the percentage's denominator grows",
	);
	const session = /\n {2}session {3}(.*)\n/.exec(ext.statusReport())?.[1] ?? "";
	assert.match(
		session,
		/^~\S+ tokens saved \(\d+%\) — bash \S+$/,
		"no documents part, no 'nothing saved yet'",
	);
});

test("a legacy Office advisory is not counted as a conversion or a saving", async () => {
	const advisory = "[boost] Legacy Office (.doc): save as docx/xlsx/pptx, then Read or boost read.";
	const { stub, statusTexts } = uiExtension({
		config: TERMS,
		client: { convert: async () => call(advisory) },
	});
	await start(stub);
	const patched = await stub.emitToolResult(
		toolResultEvent("1.2", {
			toolName: "read",
			input: { path: OLE_PATH },
			content: "\u0000garbage".repeat(5000),
		}),
	);
	assert.equal(patched?.isError, true, "the advisory replaced the result");
	assert.equal(statusTexts().at(-1), "boost ✓", "and saved nothing the footer could show");
	await settle(stub);
	const documents = (statsEntries(stub).at(-1)?.data as StatsSnapshot | undefined)?.buckets.documents;
	assert.ok(documents);
	assert.deepEqual(
		{
			converted: documents.converted,
			saved: documents.saved,
			bytesIn: documents.bytesIn,
			skipped: documents.skipped,
		},
		{ converted: 0, saved: 0, bytesIn: 0, skipped: { advisory: 1 } },
	);
});

test("an idle extension writes no stats entry: Boost off, missing, or a nested call", async () => {
	const bash = () => toolResultEvent("1.2", { toolName: "bash", input: { command: "ls" }, content: "a" });
	const cases = {
		off: uiExtension({ file: { enabled: false } }),
		missing: uiExtension({ readiness: { ...fixedReadiness({ kind: "missing" }), binary: () => undefined } }),
		nested: uiExtension(),
	};
	for (const [name, { stub }] of Object.entries(cases)) {
		await start(stub);
		for (let i = 0; i < 3; i++) {
			await stub.emitToolResult(name === "nested" ? failingBash("1.2", { parentToolCallId: "p1" }) : bash());
			await stub.emitToolResult(
				name === "nested" ? failingBash("1.2", { parentToolCallId: "p1" }) : failingBash("1.2"),
			);
			await settle(stub);
		}
		await stub.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.deepEqual(statsEntries(stub), [], `${name}: nothing appended`);
	}
	// The same results on a working Boost are counted and persisted.
	const working = uiExtension();
	await start(working.stub);
	await working.stub.emitToolResult(bash());
	await settle(working.stub);
	assert.equal(statsEntries(working.stub).length, 0, "a skip alone is not worth an entry per turn");
	await working.stub.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(statsEntries(working.stub).length, 1, "but is kept when the session ends");
});

test("/boost off is carried to the branch /tree moves to, so a later /reload keeps it", async () => {
	// The stub reads this array for getBranch(); /tree is simulated by
	// rewriting it, and appended entries are added at the leaf by hand.
	const branchA: unknown[] = [{ type: "message", id: "m1" }];
	const live: unknown[] = [...branchA];
	const first = uiExtension({ branch: live });
	await start(first.stub);
	await first.stub.command("boost", "off");
	const toggleEntries = () => first.stub.appended.filter((a) => a.customType === SESSION_TOGGLE_ENTRY);
	assert.deepEqual(
		toggleEntries().map((a) => a.data),
		[{ enabled: false }],
	);
	live.push({ type: "custom", id: "t0", customType: SESSION_TOGGLE_ENTRY, data: { enabled: false } });

	// /tree back to m1: the toggle entry is on the branch left behind.
	live.splice(0, live.length, ...branchA);
	await first.stub.fire("session_before_tree", { type: "session_before_tree" });
	await first.stub.fire("session_tree", { type: "session_tree" });
	assert.equal(first.statusTexts().at(-1), "boost: off");
	assert.deepEqual(
		toggleEntries().map((a) => a.data),
		[{ enabled: false }, { enabled: false }],
		"recorded again on the branch arrived at",
	);
	live.push({ type: "custom", id: "t1", customType: SESSION_TOGGLE_ENTRY, data: { enabled: false } });

	// /reload rebuilds the extension from that branch: still off.
	const reloaded = uiExtension({ branch: [...live] });
	await start(reloaded.stub, "reload");
	assert.deepEqual(reloaded.settings.off(), { by: "session" });
	assert.equal(reloaded.statusTexts().at(-1), "boost: off");

	// A branch that already agrees is left alone.
	await first.stub.fire("session_tree", { type: "session_tree" });
	assert.equal(toggleEntries().length, 2, "nothing appended when the branch agrees");

	// No toggle in memory, but the branch arrived at has an old `off`: the
	// session is on, so the branch is told the file decides again.
	const plainBranch: unknown[] = [...branchA];
	const plain = uiExtension({ branch: plainBranch });
	await start(plain.stub, "resume");
	assert.equal(plain.settings.off(), undefined);
	plainBranch.splice(0, plainBranch.length, ...live);
	await plain.stub.fire("session_tree", { type: "session_tree" });
	assert.equal(plain.statusTexts().at(-1), "boost ✓", "the toggle in memory holds");
	assert.deepEqual(
		plain.stub.appended.filter((a) => a.customType === SESSION_TOGGLE_ENTRY).map((a) => a.data),
		[{ enabled: null }],
	);
});

test("/boost off survives a reload, resume and fork of the session; a new session starts clean", async () => {
	const first = uiExtension();
	await start(first.stub);
	await first.stub.command("boost", "off");
	assert.equal(first.statusTexts().at(-1), "boost: off");
	const toggles = first.stub.appended.filter((a) => a.customType === SESSION_TOGGLE_ENTRY);
	assert.deepEqual(
		toggles.map((a) => a.data),
		[{ enabled: false }],
	);
	const branch = [
		{ type: "message", id: "m1" },
		...toggles.map((a, i) => ({ type: "custom", id: `t${i}`, customType: a.customType, data: a.data })),
	];

	for (const reason of ["reload", "resume", "fork"]) {
		// pi rebuilds the extension, settings store and all, for each of these.
		const again = uiExtension({ branch });
		await start(again.stub, reason);
		assert.equal(again.statusTexts().at(-1), "boost: off", reason);
		assert.deepEqual(again.settings.off(), { by: "session" }, reason);
		const patch = await again.stub.emitToolResult(failingBash("1.2"));
		assert.equal(patch, undefined, `${reason}: nothing reaches Boost`);
	}

	// Ended by a change to Enabled in /boost settings: the file decides again.
	const cleared = uiExtension({
		branch: [
			...branch,
			{ type: "custom", id: "tc", customType: SESSION_TOGGLE_ENTRY, data: { enabled: null } },
		],
	});
	await start(cleared.stub, "resume");
	assert.equal(cleared.settings.off(), undefined);
	assert.equal(cleared.statusTexts().at(-1), "boost ✓");

	// Same process, same store: a new session clears the previous toggle.
	await start(first.stub, "new");
	assert.equal(first.settings.off(), undefined, "a new session has no toggle on its branch");

	const fresh = uiExtension({ branch: [], entries: branch });
	await start(fresh.stub, "new");
	assert.equal(fresh.statusTexts().at(-1), "boost ✓");
});

test("/boost status reads Boost's telemetry opt-out from its config and environment", async () => {
	const optedOut = uiExtension({ config: `${TERMS}\n[tracing]\ntelemetry = false\n` });
	await start(optedOut.stub);
	assert.match(optedOut.ext.statusReport(), /sync on \(Boost telemetry off: nothing uploaded\)/);

	const byEnv = uiExtension({ env: { BOOST_TELEMETRY: "off" } });
	await start(byEnv.stub);
	assert.match(byEnv.ext.statusReport(), /sync on \(Boost telemetry off: nothing uploaded\)/);

	const recording = uiExtension();
	await start(recording.stub);
	assert.doesNotMatch(recording.ext.statusReport(), /telemetry off/);
});
