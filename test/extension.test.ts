/**
 * Drives the extension through a stand-in for pi's extension host, so the
 * wiring itself is under test: which results reach Boost, what gets replaced,
 * and — most importantly — that a failing Boost never reaches pi.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BoostClient, createBoostClient, type HookMeta, type HookPayload } from "../src/boost-client.ts";
import { createReadiness, type Readiness } from "../src/health.ts";
import { createBoostExtension, NO_BOOST_FLAG } from "../src/index.ts";
import type { SettingsStore } from "../src/settings.ts";
import { call, fixedConfig, fixedReadiness, memorySettings, stubClient } from "./helpers/runtime.ts";

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
		config: fixedConfig(),
		readiness,
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

	return { fire, calls, commands, flags, notices, statuses, readiness };
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

test("the install command is registered up front, before any session", () => {
	assert.deepEqual(harness().commands, ["boost-install"]);
});

test("shell output is filtered and described by its own command", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	const patched = await fire("tool_result", result("bash", { input: { command: "npm test" } }));
	assert.deepEqual(patched, { content: [{ type: "text", text: "compacted" }] });
	assert.equal(calls.find((c) => c.kind === "filter")?.fields.command, "npm test");
});

test("in-process tool output is filtered as the command it stands in for", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	await fire("tool_result", result("grep", { input: { pattern: "TODO", path: "src" } }));
	assert.equal(calls.find((c) => c.kind === "filter")?.fields.command, "grep -rn TODO src");
});

test("tools pi already summarises are not sent to Boost", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	assert.equal(await fire("tool_result", result("edit")), undefined);
	assert.equal(calls.filter((c) => c.kind === "filter").length, 0);
});

test("output Boost leaves alone keeps the original result", async () => {
	const { fire } = harness();
	assert.equal(await fire("tool_result", result("ls")), undefined);
});

test("a filter that throws leaves the original result untouched", async () => {
	const { fire } = harness({
		overrides: {
			filter: async () => {
				throw new Error("boost exploded");
			},
		},
	});
	assert.equal(await fire("tool_result", result("ls")), undefined);
});

test("a document pi cannot read is retried through Boost and stops being an error", async () => {
	const { fire, calls } = harness({ readResult: "# Quarterly report" });
	const patched = (await fire(
		"tool_result",
		result("read", {
			isError: true,
			input: { path: "/docs/q3.pdf" },
			content: [{ type: "text", text: "binary file" }],
		}),
	)) as { isError: boolean; content: { text: string }[] };
	assert.equal(patched.isError, false);
	assert.match(patched.content[0]?.text ?? "", /Boost extracted this document/);
	assert.match(patched.content[0]?.text ?? "", /# Quarterly report/);
	assert.equal(calls.find((c) => c.kind === "read")?.fields.path, "/docs/q3.pdf");
});

test("a source file that failed to read is not retried as a document", async () => {
	const { fire, calls } = harness({ readResult: "text" });
	assert.equal(
		await fire("tool_result", result("read", { isError: true, input: { path: "/src/index.ts" } })),
		undefined,
	);
	assert.equal(calls.filter((c) => c.kind === "read").length, 0);
});

test("a document Boost also cannot extract stays an error", async () => {
	const { fire } = harness();
	assert.equal(
		await fire("tool_result", result("read", { isError: true, input: { path: "/docs/q3.pdf" } })),
		undefined,
	);
});

test("a binary document pi decoded as garbage is replaced by Boost's extraction", async () => {
	const { fire, calls } = harness({ readResult: "# Quarterly report" });
	const patched = (await fire(
		"tool_result",
		result("read", {
			input: { path: "/docs/q3.docx" },
			content: [{ type: "text", text: "PK\u0003\u0004\u0000\u0000garbage" }],
		}),
	)) as { isError: boolean; content: { text: string }[] };
	assert.equal(patched.isError, false);
	assert.match(patched.content[0]?.text ?? "", /# Quarterly report/);
	assert.equal(calls.find((c) => c.kind === "read")?.fields.path, "/docs/q3.docx");
	assert.equal(calls.filter((c) => c.kind === "filter").length, 0, "garbage is never filtered");
});

test("a text document pi read fine is filtered, not converted", async () => {
	const { fire, calls } = harness({ readResult: "converted", filterResult: "compacted" });
	await fire(
		"tool_result",
		result("read", { input: { path: "data.csv" }, content: [{ type: "text", text: "a,b\n1,2" }] }),
	);
	assert.equal(calls.filter((c) => c.kind === "read").length, 0);
	assert.equal(calls.filter((c) => c.kind === "filter").length, 1);
});

test("a failed shell command is still compacted, and stays an error", async () => {
	const { fire, calls } = harness({ filterResult: "3 failures" });
	const patched = await fire(
		"tool_result",
		result("bash", {
			isError: true,
			input: { command: "npm test" },
			content: [{ type: "text", text: "…lots of test output…\n\nCommand exited with code 1" }],
		}),
	);
	assert.deepEqual(patched, {
		content: [{ type: "text", text: "3 failures\n\nCommand exited with code 1" }],
	});
	assert.equal(calls.find((c) => c.kind === "filter")?.text, "…lots of test output…");
});

test("other failed tools are not fed to the filter", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	await fire("tool_result", result("grep", { isError: true, input: { pattern: "(" } }));
	assert.equal(calls.filter((c) => c.kind === "filter").length, 0);
});

test("pi's continuation notices survive compaction verbatim", async () => {
	const { fire, calls } = harness({ filterResult: "compacted\n" });
	const notice = "\n\n[Showing lines 1-2000 of 9000. Use offset=2001 to continue.]";
	const patched = await fire(
		"tool_result",
		result("read", { input: { path: "big.log" }, content: [{ type: "text", text: `log lines${notice}` }] }),
	);
	assert.deepEqual(patched, { content: [{ type: "text", text: `compacted${notice}` }] });
	assert.equal(calls.find((c) => c.kind === "filter")?.text, "log lines");
});

test("DISABLE_BOOST=1 on a command returns its output exactly", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	for (const command of ["DISABLE_BOOST=1 diff -u a b", "cd x && DISABLE_BOOST=1 cat y"]) {
		assert.equal(await fire("tool_result", result("bash", { input: { command } })), undefined, command);
	}
	assert.equal(calls.filter((c) => c.kind === "filter").length, 0);
});

test("boost's own commands are not compacted a second time", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	for (const command of ["boost retrieve 147", "boost retrieve 147 --lines 1-40", "boost read a.pdf"]) {
		assert.equal(await fire("tool_result", result("bash", { input: { command } })), undefined, command);
	}
	assert.equal(calls.filter((c) => c.kind === "filter").length, 0);
});

test("the footer shows a running estimate of what Boost saved", async () => {
	const { fire, statuses } = harness({ filterResult: "short" });
	await fire("session_start", { reason: "startup" });
	await fire(
		"tool_result",
		result("bash", { input: { command: "npm test" }, content: [{ type: "text", text: "x".repeat(8005) }] }),
	);
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

test("tool telemetry is reported with a duration when opted in", async () => {
	const { fire, calls } = harness();
	await fire("tool_call", { toolName: "ls", toolCallId: "c1", input: {} });
	await fire("tool_result", result("ls"));
	const [post] = observed(calls, "PostToolUse");
	assert.equal(post?.fields.tool_name, "ls");
	assert.equal(typeof post?.fields.duration_ms, "number");
});

test("a failed tool is reported as a failure, not a result", async () => {
	const { fire, calls } = harness();
	await fire("tool_result", result("grep", { isError: true }));
	assert.equal(observed(calls, "PostToolUseFailure")[0]?.fields.error_message, "raw output");
	assert.equal(observed(calls, "PostToolUse").length, 0);
});

test("filtering still happens when telemetry is opted out", async () => {
	const { fire, calls } = harness({ filterResult: "compacted", observeEnabled: false });
	const patched = await fire("tool_result", result("bash", { input: { command: "npm test" } }));
	assert.deepEqual(patched, { content: [{ type: "text", text: "compacted" }] });
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
	await fire("tool_result", result("ls"));
	assert.ok(calls.length > 0);
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

const bash = () => result("bash", { input: { command: "npm test" } });

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
