import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookMeta, HookPayload } from "../src/boost-client.ts";
import { OBSERVE_TEXT_LIMIT } from "../src/content.ts";
import {
	capToolInput,
	createObserver,
	MAX_PENDING_STARTS,
	OBSERVE_ARG_STRING_LIMIT,
} from "../src/observe.ts";
import {
	agentSettledEvent,
	messageEndEvent,
	type PiLine,
	toolExecutionEndEvent,
	toolExecutionStartEvent,
} from "./helpers/harness.ts";

interface Sent {
	meta: HookMeta;
	fields: HookPayload;
}

function observer(
	options: { enabled?: () => boolean; now?: () => number; excluded?: (toolName: string) => boolean } = {},
) {
	const sent: Sent[] = [];
	const o = createObserver({
		enabled: options.enabled ?? (() => true),
		...(options.excluded ? { excluded: options.excluded } : {}),
		send: (meta, fields) => sent.push({ meta, fields }),
		...(options.now ? { now: options.now } : {}),
	});
	const meta = (toolCallId?: string): HookMeta => ({
		session_id: "s1",
		cwd: "/work",
		...(toolCallId ? { tool_use_id: toolCallId } : {}),
	});
	const names = () => sent.map((s) => s.fields.hook_event_name);
	return { o, sent, meta, names };
}

const output = (text: string) => ({ content: [{ type: "text", text }], details: {} });

for (const line of ["0.86", "1.2"] as PiLine[]) {
	test(`${line}: PreToolUse precedes PostToolUse, matched by tool_use_id, with the input on both`, () => {
		const { o, sent, meta, names } = observer();
		o.toolStart(
			toolExecutionStartEvent(line, { toolName: "bash", toolCallId: "t1", args: { command: "ls" } }),
			meta,
		);
		o.toolEnd(
			toolExecutionEndEvent(line, {
				toolName: "bash",
				toolCallId: "t1",
				result: output("a\nb"),
				durationMs: 42,
			}),
			meta,
		);
		assert.deepEqual(names(), ["PreToolUse", "PostToolUse"]);
		assert.deepEqual(sent[0]?.fields, {
			hook_event_name: "PreToolUse",
			tool_name: "bash",
			tool_input: { command: "ls" },
		});
		assert.equal(sent[0]?.meta.tool_use_id, "t1");
		assert.equal(sent[1]?.meta.tool_use_id, "t1");
		assert.deepEqual(sent[1]?.fields.tool_input, { command: "ls" });
		assert.equal(sent[1]?.fields.tool_output, "a\nb");
		assert.equal(typeof sent[1]?.fields.duration_ms, "number");
	});

	test(`${line}: a failed tool is a PostToolUseFailure with its message`, () => {
		const { o, sent, meta } = observer();
		o.toolStart(toolExecutionStartEvent(line, { toolName: "read", toolCallId: "t2" }), meta);
		o.toolEnd(
			toolExecutionEndEvent(line, {
				toolName: "read",
				toolCallId: "t2",
				isError: true,
				result: output("ENOENT"),
			}),
			meta,
		);
		assert.equal(sent[1]?.fields.hook_event_name, "PostToolUseFailure");
		assert.equal(sent[1]?.fields.error_message, "ENOENT");
		assert.equal(sent[1]?.fields.tool_output, undefined);
	});
}

test("nested calls are never observed (1.2 codemode; 0.86 has none)", () => {
	const { o, sent, meta } = observer();
	o.toolStart(
		toolExecutionStartEvent("1.2", { toolName: "bash", toolCallId: "n1", parentToolCallId: "p" }),
		meta,
	);
	o.toolEnd(
		toolExecutionEndEvent("1.2", { toolName: "bash", toolCallId: "n1", parentToolCallId: "p" }),
		meta,
	);
	assert.deepEqual(sent, []);
});

test("pi's durationMs is preferred over the fallback timer", () => {
	let clock = 1_000;
	const { o, sent, meta } = observer({ now: () => clock });
	o.toolStart(toolExecutionStartEvent("1.2", { toolName: "bash", toolCallId: "t1" }), meta);
	clock += 500;
	o.toolEnd(toolExecutionEndEvent("1.2", { toolName: "bash", toolCallId: "t1", durationMs: 42 }), meta);
	assert.equal(sent[1]?.fields.duration_ms, 42);
});

test("on 0.86, which has no durationMs, the start timer stands in", () => {
	let clock = 1_000;
	const { o, sent, meta } = observer({ now: () => clock });
	o.toolStart(toolExecutionStartEvent("0.86", { toolName: "bash", toolCallId: "t1" }), meta);
	clock += 120.4;
	o.toolEnd(toolExecutionEndEvent("0.86", { toolName: "bash", toolCallId: "t1", durationMs: 42 }), meta);
	assert.equal(sent[1]?.fields.duration_ms, 120);
});

test("an end without a seen start is reported without a duration", () => {
	const { o, sent, meta } = observer();
	o.toolEnd(toolExecutionEndEvent("0.86", { toolName: "bash", toolCallId: "lost" }), meta);
	assert.equal(sent[0]?.fields.hook_event_name, "PostToolUse");
	assert.equal("duration_ms" in (sent[0]?.fields ?? {}), false);
	assert.deepEqual(sent[0]?.fields.tool_input, {});
});

test("starts whose end never comes are bounded", () => {
	let clock = 0;
	const { o, sent, meta } = observer({ now: () => clock++ });
	for (let i = 0; i <= MAX_PENDING_STARTS; i++) {
		o.toolStart(toolExecutionStartEvent("0.86", { toolName: "bash", toolCallId: `t${i}` }), meta);
	}
	o.toolEnd(toolExecutionEndEvent("0.86", { toolName: "bash", toolCallId: "t0" }), meta);
	assert.equal("duration_ms" in (sent.at(-1)?.fields ?? {}), false, "the oldest was dropped");
	o.toolEnd(toolExecutionEndEvent("0.86", { toolName: "bash", toolCallId: `t${MAX_PENDING_STARTS}` }), meta);
	assert.equal(typeof sent.at(-1)?.fields.duration_ms, "number", "the newest kept");
});

test("tool output is capped at 16k characters", () => {
	const { o, sent, meta } = observer();
	o.toolEnd(
		toolExecutionEndEvent("1.2", { toolName: "bash", toolCallId: "t1", result: output("x".repeat(40_000)) }),
		meta,
	);
	const text = String(sent[0]?.fields.tool_output);
	assert.equal(OBSERVE_TEXT_LIMIT, 16_000);
	assert.ok(text.length < 16_100, `${text.length}`);
	assert.ok(text.endsWith("…[truncated]"));
});

test("off: nothing is sent and nothing is kept", () => {
	let on = false;
	const { o, sent, meta } = observer({ enabled: () => on });
	o.sessionStart(meta);
	o.toolStart(toolExecutionStartEvent("1.2", { toolName: "bash", toolCallId: "t1" }), meta);
	o.toolEnd(toolExecutionEndEvent("1.2", { toolName: "bash", toolCallId: "t1" }), meta);
	o.message(messageEndEvent("assistant", "secret reply"));
	on = true;
	o.settled(agentSettledEvent("1.2"), {}, meta);
	o.preCompact({ reason: "manual" }, meta);
	on = false;
	o.postCompact(meta);
	assert.deepEqual(
		sent.map((s) => s.fields.hook_event_name),
		["preCompact"],
		"no reply was captured while off, so none is sent once on",
	);
});

test("the last assistant reply is sent when the agent settles, once", () => {
	const { o, sent, meta } = observer();
	o.message(messageEndEvent("assistant", "first"));
	o.message(messageEndEvent("user", "a prompt"));
	o.message(messageEndEvent("assistant", "  done  "));
	o.settled(agentSettledEvent("1.2"), {}, meta);
	o.settled(agentSettledEvent("1.2"), {}, meta);
	assert.deepEqual(sent, [{ meta: meta(), fields: { hook_event_name: "afterAgentResponse", text: "done" } }]);
});

test("an aborted run's reply is not sent: 1.2's flag, or 0.86's context signal", () => {
	for (const [event, ctx] of [
		[agentSettledEvent("1.2", { aborted: true }), {}],
		[agentSettledEvent("0.86"), { signal: { aborted: true } }],
	] as const) {
		const { o, sent, meta } = observer();
		o.message(messageEndEvent("assistant", "half a reply"));
		o.settled(event, ctx, meta);
		assert.deepEqual(sent, []);
		// And it does not leak into the next settle.
		o.settled(agentSettledEvent("1.2"), {}, meta);
		assert.deepEqual(sent, []);
	}
	const { o, sent, meta } = observer();
	o.message(messageEndEvent("assistant", "a reply"));
	o.settled(agentSettledEvent("0.86"), { signal: { aborted: false } }, meta);
	assert.equal(sent.length, 1, "0.86 with a live signal is not aborted");
});

test("compaction is reported on both sides, with its trigger", () => {
	const { o, sent, meta } = observer();
	o.preCompact({ reason: "threshold" }, meta);
	o.preCompact({ reason: "manual" }, meta);
	o.postCompact(meta);
	assert.deepEqual(
		sent.map((s) => s.fields),
		[
			{ hook_event_name: "preCompact", trigger: "auto" },
			{ hook_event_name: "preCompact", trigger: "manual" },
			{ hook_event_name: "postCompact" },
		],
	);
});

test("reset forgets the reply and pending starts", () => {
	let clock = 0;
	const { o, sent, meta } = observer({ now: () => clock++ });
	o.message(messageEndEvent("assistant", "old"));
	o.toolStart(toolExecutionStartEvent("0.86", { toolName: "bash", toolCallId: "t1" }), meta);
	o.reset();
	o.settled(agentSettledEvent("1.2"), {}, meta);
	o.toolEnd(toolExecutionEndEvent("0.86", { toolName: "bash", toolCallId: "t1" }), meta);
	assert.deepEqual(
		sent.map((s) => s.fields.hook_event_name),
		["PreToolUse", "PostToolUse"],
	);
	assert.equal("duration_ms" in (sent[1]?.fields ?? {}), false);
});

test("nothing throws: a throwing sender, a stale context's meta, malformed events", () => {
	const o = createObserver({
		enabled: () => true,
		send: () => {
			throw new Error("spawn failed");
		},
	});
	const stale = (): HookMeta => {
		throw new Error("stale ctx");
	};
	assert.doesNotThrow(() => {
		o.sessionStart(stale);
		o.toolStart(undefined, stale);
		o.toolStart({ toolCallId: 3, args: "x" }, stale);
		o.toolEnd(null, stale);
		o.toolEnd({ toolCallId: "t", result: { content: "not an array" } }, stale);
		o.message({ message: { role: "assistant", content: 7 } });
		o.message(undefined);
		o.settled(undefined, undefined, stale);
		o.preCompact(undefined, stale);
		o.postCompact(stale);
	});
});

// ---------------------------------------------------------------------------
// Privacy and size: mcpExclude, and capped arguments

for (const line of ["0.86", "1.2"] as PiLine[]) {
	test(`${line}: a tool matched by mcpExclude is not observed at all, Pre or Post`, () => {
		const { o, sent, meta } = observer({ excluded: (name) => name.startsWith("mcp__secrets__") });
		const secret = { toolName: "mcp__secrets__get", toolCallId: "s1", args: { name: "prod-db" } };
		o.toolStart(toolExecutionStartEvent(line, secret), meta);
		o.toolEnd(toolExecutionEndEvent(line, { ...secret, result: output("hunter2") }), meta);
		assert.deepEqual(sent, []);
		// Other tools still are.
		o.toolStart(toolExecutionStartEvent(line, { toolName: "mcp__slack__post", toolCallId: "s2" }), meta);
		assert.equal(sent.length, 1);
	});
}

test("an exclusion check that throws drops the event rather than sending it", () => {
	const { o, sent, meta } = observer({
		excluded: () => {
			throw new Error("boom");
		},
	});
	assert.doesNotThrow(() =>
		o.toolStart(toolExecutionStartEvent("1.2", { toolName: "mcp__x__y", toolCallId: "e1" }), meta),
	);
	assert.deepEqual(sent, []);
});

test("large arguments are capped in PreToolUse and PostToolUse alike; small ones pass unchanged", () => {
	const { o, sent, meta } = observer();
	const content = "x".repeat(200_000);
	const args = { path: "/work/big.txt", content };
	o.toolStart(toolExecutionStartEvent("1.2", { toolName: "write", toolCallId: "w1", args }), meta);
	o.toolEnd(
		toolExecutionEndEvent("1.2", { toolName: "write", toolCallId: "w1", result: output("ok") }),
		meta,
	);
	for (const s of sent) {
		const input = s.fields.tool_input as Record<string, unknown>;
		assert.equal(input.path, "/work/big.txt", "the small fields survive");
		assert.ok(typeof input.content === "string" && input.content.length < OBSERVE_ARG_STRING_LIMIT + 20);
		assert.ok(JSON.stringify(input).length <= OBSERVE_TEXT_LIMIT, String(s.fields.hook_event_name));
	}
	assert.equal(args.content.length, 200_000, "the tool's own arguments are not mutated");
	const small = { command: "ls -la" };
	assert.equal(capToolInput(small), small);
});

test("arguments too large even with every string cut become one JSON excerpt", () => {
	const many = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, "v".repeat(10)]));
	const capped = capToolInput(many);
	assert.deepEqual(Object.keys(capped), ["truncated_input"]);
	assert.ok(String(capped.truncated_input).length <= OBSERVE_TEXT_LIMIT + 20);
	assert.ok(String(capped.truncated_input).endsWith("…[truncated]"));
});
