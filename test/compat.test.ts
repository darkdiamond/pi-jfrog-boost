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
	lastCustomEntry,
	loadout,
	mcpReachesRoute,
	messageType,
	parentToolCallId,
	processSingleton,
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

test("mcpReachesRoute: only an MCP tool pi declares, or tool_search can load, reaches the route", () => {
	const pi = (getAllTools: unknown, active: string[] = ["read", "bash", "codemode"]) =>
		({ getAllTools, getActiveTools: () => active }) as unknown as Parameters<typeof mcpReachesRoute>[0];
	// pi 1.2 registers a `codemode`-exposure server's tools as `deferred`.
	const codemodeServer = () => [
		{ name: "read", exposure: "direct" },
		{ name: "codemode", exposure: "model-only" },
		{ name: "mcp__slack__slack_get_users", exposure: "deferred" },
	];
	assert.equal(mcpReachesRoute(pi(codemodeServer)), false, "default codemode exposure: every call is nested");
	assert.equal(
		mcpReachesRoute(pi(codemodeServer, ["read", "codemode", "tool_search"])),
		true,
		"tool_search can load it into the active set",
	);
	assert.equal(
		mcpReachesRoute(pi(codemodeServer, ["read", "mcp__slack__slack_get_users"])),
		true,
		"already loaded",
	);
	assert.equal(
		mcpReachesRoute(pi(() => [...codemodeServer(), { name: "mcp__gh__search", exposure: "direct" }])),
		true,
		"a direct tool",
	);
	assert.equal(mcpReachesRoute(pi(() => [{ name: "mcp__x__y", exposure: "hidden" }])), false);
	assert.equal(mcpReachesRoute(pi(() => [{ name: "read", exposure: "direct" }])), false, "no MCP tool yet");
	// 0.86: no codemode, so every MCP call is top-level.
	assert.equal(mcpReachesRoute(pi(undefined)), true, "a pi without getAllTools");
	assert.equal(mcpReachesRoute(pi(() => [{ name: "read" }])), true, "a pi without exposure");
	assert.equal(
		mcpReachesRoute(
			pi(() => {
				throw new Error("not bound yet");
			}),
		),
		true,
	);
});

const custom = (customType: string, data: unknown) => ({ type: "custom", customType, data });

test("lastCustomEntry reads the newest accepted entry of its type on the branch", () => {
	const parse = (data: unknown) => (typeof data === "number" ? data : undefined);
	const branch = [custom("x", 1), custom("y", 9), custom("x", 2), custom("x", "bad"), { type: "message" }];
	const sm = { getBranch: () => branch, getEntries: () => [custom("x", 99)] };
	assert.equal(lastCustomEntry(sm, "x", parse), 2, "skips what parse rejects, and the other type");
	assert.equal(
		lastCustomEntry({ getBranch: () => [], getEntries: () => [custom("x", 99)] }, "x", parse),
		undefined,
	);
	const throws = () => {
		throw new Error("no branch");
	};
	assert.equal(lastCustomEntry({ getBranch: throws, getEntries: () => [custom("x", 3)] }, "x", parse), 3);
	assert.equal(lastCustomEntry({ getEntries: throws }, "x", parse), undefined);
	assert.equal(lastCustomEntry({ getBranch: () => "nope" }, "x", parse), undefined);
	assert.equal(lastCustomEntry(undefined, "x", parse), undefined);
});

test("processSingleton keeps one value per name on globalThis under the registered key", () => {
	const name = `test-${Math.random()}`;
	let made = 0;
	const first = processSingleton(name, () => ({ n: ++made }));
	assert.equal(
		processSingleton(name, () => ({ n: ++made })),
		first,
	);
	assert.equal(made, 1);
	assert.equal(
		(globalThis as unknown as Record<symbol, unknown>)[Symbol.for(`pi-jfrog-boost.${name}`)],
		first,
	);
	delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(`pi-jfrog-boost.${name}`)];
});
