/**
 * Drives the extension through a stand-in for pi's extension host, so the
 * wiring itself is under test: which results reach Boost, what gets replaced,
 * and — most importantly — that a failing Boost never reaches pi.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BoostClient, createBoostClient, type HookMeta, type HookPayload } from "../src/boost-client.ts";
import type { ConfigReader } from "../src/boost-config.ts";
import {
	type Counters,
	createBreaker,
	createCounters,
	createReadiness,
	type Readiness,
} from "../src/health.ts";
import { createBoostExtension, NO_BOOST_FLAG, TERMS_NOTICE } from "../src/index.ts";
import type { SettingsStore } from "../src/settings.ts";
import { docx } from "./helpers/docx.ts";
import { createPiStub, type PiLine, textOfBlocks, toolResultEvent } from "./helpers/harness.ts";
import { call, fixedConfig, fixedReadiness, memorySettings, stubClient } from "./helpers/runtime.ts";

/**
 * Boost's config with CLI filtering on, so the shell gate (spec §8.4) lets
 * shell output through. A default v0.15 install has it off, and then nothing
 * is sent at all — see the gate tests below.
 */
const CLI_ON = `[feature_flags."boost-cli-filtering"]\nuser = true\n`;
const CLI_OFF = `[feature_flags."boost-cli-filtering"]\nuser = false\n`;

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
	settings?: SettingsStore;
	config?: ConfigReader;
	counters?: Counters;
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
	settings,
	config = fixedConfig(CLI_ON),
	counters,
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
		...(counters ? { counters } : {}),
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

test("the install command is registered up front, before any session", () => {
	assert.deepEqual(harness().commands, ["boost-install"]);
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
after(() => rmSync(docRoot, { recursive: true, force: true }));
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
	const abs = join("/work", "logs", "app.log");
	assert.deepEqual(filterCalls(calls)[0]?.fields, {
		path: "logs/app.log",
		file_path: abs,
		command: `cat ${abs}`,
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
	await fire("tool_result", bashResult("npm test", "x".repeat(8005)));
	assert.equal(statuses.at(-1), "boost ~2.0k saved");
	await fire("session_start", { reason: "new" });
	assert.equal(statuses.at(-1), undefined, "a new session starts from zero");
});

test("the awareness block is a named prompt section when pi supports them", async () => {
	const { fire } = harness();
	const sections: Record<string, string> = {};
	const patched = await fire("before_agent_start", {
		systemPrompt: "base",
		systemPromptOptions: { sections },
	});
	assert.equal(patched, undefined, "no whole-prompt replacement, so the prompt cache survives");
	assert.match(sections["jfrog-boost"] ?? "", /boost retrieve <id>/);
	assert.doesNotMatch(sections["jfrog-boost"] ?? "", /<jfrog-boost>/, "pi adds the tags itself");
});

test("the system prompt gains the Boost instructions when pi has no sections", async () => {
	const { fire } = harness();
	const patched = (await fire("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string };
	assert.ok(patched.systemPrompt.startsWith("base"));
	assert.ok(patched.systemPrompt.includes("boost retrieve <id>"));
});

test("nothing is added to the system prompt when Boost is not usable", async () => {
	const { fire } = harness({ readiness: fixedReadiness({ kind: "not-responding" }) });
	assert.equal(await fire("before_agent_start", { systemPrompt: "base" }), undefined);
});

test("a missing Boost is reported once, with the command that fixes it", async () => {
	const { fire, notices } = harness({
		readiness: { ...fixedReadiness({ kind: "missing" }), binary: () => undefined },
	});
	await fire("session_start", { reason: "startup" });
	await fire("session_start", { reason: "new" });
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /\/boost-install/);
});

test("tool telemetry is reported when opted in", async () => {
	const { fire, calls } = harness();
	await fire("tool_result", result("ls"));
	const [post] = observed(calls, "PostToolUse");
	assert.equal(post?.fields.tool_name, "ls");
	assert.equal(post?.fields.tool_output, "raw output");
});

test("a failed tool is reported as a failure, not a result", async () => {
	const { fire, calls } = harness();
	await fire("tool_result", result("grep", { isError: true }));
	assert.equal(observed(calls, "PostToolUseFailure")[0]?.fields.error_message, "raw output");
	assert.equal(observed(calls, "PostToolUse").length, 0);
});

test("filtering still happens when telemetry is opted out", async () => {
	const { fire, calls } = harness({ filterResult: "compacted", observeEnabled: false });
	const patched = await fire("tool_result", bashResult("npm test"));
	assert.deepEqual((patched as { content: unknown }).content, [{ type: "text", text: "compacted" }]);
	assert.equal(calls.filter((c) => c.kind === "observe").length, 0);
});

test("the assistant's reply is reported when the agent settles", async () => {
	const { fire, calls } = harness();
	await fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
	await fire("agent_end", {});
	assert.equal(observed(calls, "afterAgentResponse")[0]?.fields.text, "done");
});

test("user and tool messages are not reported as assistant replies", async () => {
	const { fire, calls } = harness();
	await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "hi" }] } });
	await fire("agent_end", {});
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

test("shutdown flushes the pending upload instead of waiting out the debounce", async () => {
	const { fire, calls } = harness();
	await fire("agent_end", {});
	assert.equal(calls.filter((c) => c.kind === "sync").length, 0, "upload is debounced");
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(calls.filter((c) => c.kind === "sync").length, 1);
});

test("shutdown sends no observe: a `stop` event would reattribute the session", async () => {
	const { fire, calls } = harness();
	await fire("session_shutdown", { reason: "quit" });
	assert.equal(observed(calls, "stop").length, 0);
});

test("opting into telemetry warns that the session loses its pi attribution", async () => {
	const { fire, notices } = harness();
	await fire("session_start", { reason: "startup" });
	await fire("session_start", { reason: "new" });
	assert.equal(notices.length, 1, "said once, not every session");
	assert.match(notices[0] ?? "", /PI_BOOST_OBSERVE=1/);
	assert.match(notices[0] ?? "", /claude_code/);
});

test("no such warning when telemetry is left off", async () => {
	const { fire, notices } = harness({ observeEnabled: false });
	await fire("session_start", { reason: "startup" });
	assert.deepEqual(notices, []);
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
	await h.fire("agent_end", {});
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
				release = () => resolve(call("boost v0.15.4\n"));
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
	assert.deepEqual(waits, [50], "the first turn waited once, bounded; the second did not wait");
	await h.fire("session_start", { reason: "new" });
	await h.fire("before_agent_start", { systemPrompt: "base" });
	assert.deepEqual(waits, [50, 50], "a new session's first turn may wait again");
});

test("a first turn that waited past the probe gets the awareness section", async () => {
	let ready = false;
	const readiness: Readiness = {
		...fixedReadiness(),
		check: () => (ready ? { kind: "ready", version: [0, 15, 4] } : { kind: "probing" }),
		wait: async () => {
			ready = true;
			return { kind: "ready", version: [0, 15, 4] };
		},
	};
	const h = harness({ readiness });
	await h.fire("session_start", { reason: "startup" });
	const sections: Record<string, string> = {};
	await h.fire("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections } });
	assert.match(sections["jfrog-boost"] ?? "", /boost retrieve <id>/);
});

test("sync honours its opt-out", async () => {
	const h = harness({ env: { PI_BOOST_SYNC: "0" } });
	await h.fire("agent_end", {});
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(h.calls.filter((c) => c.kind === "sync").length, 0);
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
after(() => rmSync(root, { recursive: true, force: true }));

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
	await fire("agent_end", {});
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
		await stub.fire("agent_end", {}, ctx);
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
		await stub.fire("agent_end", {}, ctx);
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
	const footer = (stub: typeof first.stub) => stub.ui.statuses.filter((s) => s.text).map((s) => s.text);
	assert.equal(footer(first.stub).length, 1, "the first instance counted its saving");
	assert.deepEqual(footer(second.stub), [], "the second saw none of it");

	const before = first.used.length;
	assert.ok(await second.stub.emitToolResult(failingBash("1.2")), "the second compacts on its own");
	assert.equal(first.used.length, before, "and nothing crossed back");
	// A new session in one resets only that one.
	await second.stub.fire("session_start", { type: "session_start", reason: "new" });
	assert.ok(await first.stub.emitToolResult(failingBash("1.2")));
	assert.equal(footer(first.stub).length, 2, "the first kept its running total");
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
	assert.deepEqual(unknown.spawns, [], "flag unrecorded on v0.15.4: Boost's default is off, zero spawns");
	const settingOff = await gateRun(CLI_ON, { PI_BOOST_SHELL: "off" });
	assert.deepEqual(settingOff.spawns, [], "shell: off wins over the flag");
});

test("shell: on forces CLI filtering for pi's own Boost call only", async () => {
	const on = await gateRun(CLI_OFF, { PI_BOOST_SHELL: "on" });
	assert.ok(on.patch, "compacted although config says user = false (F1)");
	assert.equal(on.spawns.length, 1);
	assert.equal(on.spawns[0]?.env.BOOST_FEATURE_FLAGS_FORCE_ENABLED, "boost-cli-filtering");
});
