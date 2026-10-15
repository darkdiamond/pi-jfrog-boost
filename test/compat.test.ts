/**
 * The structural accessors in compat.ts must read 1.2-shaped events and fall
 * back sensibly on 0.86-shaped ones, which lack the fields (spec §2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	aborted,
	asResult,
	canRenderTools,
	deferredTools,
	durationMs,
	hasStructured,
	loadout,
	messageType,
	parentToolCallId,
	structuredContentOf,
} from "../src/compat.ts";
import {
	agentSettledEvent,
	beforeAgentStartEvent,
	createPiStub,
	toolExecutionEndEvent,
	toolResult12,
	toolResult86,
} from "./helpers/harness.ts";

test("nested calls and structured content on 1.2; absent on 0.86", () => {
	const nested = toolResult12({
		toolName: "bash",
		parentToolCallId: "p1",
		structuredContent: { exitCode: 0 },
	});
	assert.equal(parentToolCallId(nested), "p1");
	assert.deepEqual(structuredContentOf(nested), { exitCode: 0 });
	assert.equal(hasStructured(nested), true);

	const old = toolResult86({ toolName: "bash", parentToolCallId: "p1", structuredContent: { exitCode: 0 } });
	assert.equal(parentToolCallId(old), undefined);
	assert.equal(structuredContentOf(old), undefined);
	assert.equal(hasStructured(old), false);
	assert.equal(parentToolCallId({ parentToolCallId: "" }), undefined, "an empty id is no parent");
	assert.equal(parentToolCallId(undefined), undefined);
});

test("durationMs only when pi measured it", () => {
	assert.equal(durationMs(toolExecutionEndEvent("1.2", { toolName: "bash", durationMs: 42 })), 42);
	assert.equal(durationMs(toolExecutionEndEvent("0.86", { toolName: "bash", durationMs: 42 })), undefined);
	assert.equal(durationMs({ durationMs: -1 }), undefined);
	assert.equal(durationMs({ durationMs: Number.NaN }), undefined);
});

test("aborted: the event's flag on 1.2, the context's signal on 0.86", () => {
	assert.equal(aborted(agentSettledEvent("1.2", { aborted: true })), true);
	assert.equal(aborted(agentSettledEvent("1.2", { aborted: false }), { signal: AbortSignal.abort() }), false);
	const settled86 = agentSettledEvent("0.86");
	assert.equal(aborted(settled86), false);
	assert.equal(aborted(settled86, { signal: AbortSignal.abort() }), true);
	assert.equal(aborted(settled86, { signal: new AbortController().signal }), false);
});

test("messageType defaults to user", () => {
	assert.equal(messageType(beforeAgentStartEvent("1.2", { messageType: "custom" })), "custom");
	assert.equal(messageType(beforeAgentStartEvent("1.2")), "user");
	assert.equal(messageType(beforeAgentStartEvent("0.86")), "user");
});

test("loadout reads selectedTools and hiddenTools when present", () => {
	assert.deepEqual(
		loadout({ systemPromptOptions: { selectedTools: ["bash", "read", 7], hiddenTools: ["read"] } }),
		{ selected: ["bash", "read"], hidden: ["read"] },
	);
	assert.deepEqual(loadout({ systemPromptOptions: { selectedTools: ["bash"] } }), { selected: ["bash"] });
	assert.deepEqual(loadout(beforeAgentStartEvent("0.86")), {});
	assert.deepEqual(loadout({}), {});
});

test("canRenderTools is feature detection, not a version check", () => {
	assert.equal(canRenderTools(createPiStub({ line: "1.2" }).pi), true);
	assert.equal(canRenderTools(createPiStub({ line: "0.86" }).pi), false);
	assert.equal(canRenderTools(createPiStub({ line: "0.86", renderer: true }).pi), true);
});

test("asResult is a cast: the patch, structuredContent included, passes through unchanged", () => {
	const patch = {
		content: [{ type: "text" as const, text: "x" }],
		structuredContent: { a: 1 },
		isError: false,
	};
	assert.equal(asResult(patch) as unknown, patch);
});

test("deferredTools names only registered tools with deferred exposure", () => {
	const pi = (getAllTools: unknown) => ({ getAllTools }) as unknown as Parameters<typeof deferredTools>[0];
	assert.deepEqual(
		deferredTools(
			pi(() => [
				{ name: "read", exposure: "direct" },
				{ name: "mcp__slack__slack_get_users", exposure: "deferred" },
				{ name: "mcp__gh__search", exposure: "codemode" },
				{ name: "mcp__x__y", exposure: "hidden" },
				{ name: "tool_search", exposure: "direct" },
			]),
		),
		["mcp__slack__slack_get_users"],
	);
	assert.deepEqual(deferredTools(pi(undefined)), [], "a pi without getAllTools");
	assert.deepEqual(deferredTools(pi(() => [{ name: "mcp__a__b" }])), [], "a pi without exposure");
	assert.deepEqual(
		deferredTools(
			pi(() => {
				throw new Error("not bound yet");
			}),
		),
		[],
	);
});
