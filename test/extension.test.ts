/**
 * Drives the extension through a stand-in for pi's extension host, so the
 * wiring itself is under test: which results reach Boost, what gets replaced,
 * and — most importantly — that a failing Boost never reaches pi.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoostClient, HookMeta, HookPayload } from "../src/boost-client.ts";
import { createBoostExtension } from "../src/index.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface Recorded {
	kind: "filter" | "read" | "observe" | "sync";
	meta: HookMeta;
	fields: HookPayload;
}

interface HarnessOptions {
	overrides?: Partial<BoostClient>;
	filterResult?: string;
	readResult?: string;
	observeEnabled?: boolean;
}

function harness({ overrides = {}, filterResult, readResult, observeEnabled = true }: HarnessOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands: string[] = [];
	const notices: string[] = [];
	const calls: Recorded[] = [];

	const client: BoostClient = {
		enabled: () => true,
		observeEnabled: () => observeEnabled,
		binary: () => "/fake/boost",
		refresh: () => {},
		ready: async () => true,
		filter: async (meta, toolInput, _text) => {
			calls.push({ kind: "filter", meta, fields: toolInput });
			return filterResult;
		},
		read: async (meta, path) => {
			calls.push({ kind: "read", meta, fields: { path } });
			return readResult;
		},
		observe: async () => undefined,
		observeDetached: (meta, fields) => calls.push({ kind: "observe", meta, fields }),
		sync: (meta) => calls.push({ kind: "sync", meta, fields: {} }),
		exec: async () => ({ code: 0, stdout: "" }),
		...overrides,
	};

	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string) => commands.push(name),
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: "/work",
		hasUI: true,
		sessionManager: { getSessionId: () => "sess-1" },
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;

	createBoostExtension(pi, { client, syncDelayMs: 5 });

	const fire = async (event: string, payload: unknown) => {
		const results = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload as never, ctx));
		}
		return results.at(-1);
	};

	return { fire, calls, commands, notices };
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

test("a failed tool's output is never fed to the filter", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	await fire("tool_result", result("bash", { isError: true, input: { command: "false" } }));
	assert.equal(calls.filter((c) => c.kind === "filter").length, 0);
});

test("the system prompt gains the Boost instructions and the daily tip", async () => {
	const { fire } = harness({
		overrides: { observe: async () => ({ additional_context: "Tip of the day." }) },
	});
	await fire("session_start", { reason: "startup" });
	await new Promise((r) => setImmediate(r));
	const patched = (await fire("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string };
	assert.ok(patched.systemPrompt.startsWith("base"));
	assert.ok(patched.systemPrompt.includes("boost retrieve <id>"));
	assert.ok(patched.systemPrompt.endsWith("Tip of the day."));
});

test("the tip is injected once, not on every turn", async () => {
	const { fire } = harness({ overrides: { observe: async () => ({ additional_context: "Tip." }) } });
	await fire("session_start", { reason: "startup" });
	await new Promise((r) => setImmediate(r));
	await fire("before_agent_start", { systemPrompt: "base" });
	const second = (await fire("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string };
	assert.ok(!second.systemPrompt.includes("Tip."));
});

test("nothing is added to the system prompt when Boost is not usable", async () => {
	const { fire } = harness({ overrides: { ready: async () => false } });
	assert.equal(await fire("before_agent_start", { systemPrompt: "base" }), undefined);
});

test("a missing Boost is reported once, with the command that fixes it", async () => {
	const { fire, notices } = harness({ overrides: { binary: () => undefined } });
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

test("every payload carries the session id and working directory", async () => {
	const { fire, calls } = harness({ filterResult: "compacted" });
	await fire("tool_result", result("ls"));
	assert.ok(calls.length > 0);
	for (const call of calls) {
		assert.equal(call.meta.session_id, "sess-1");
		assert.equal(call.meta.cwd, "/work");
	}
});
