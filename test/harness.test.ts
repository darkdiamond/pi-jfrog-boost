/**
 * Self-tests for the shared pi host stub: the event factories must match what
 * each pi line really emits, and the patch semantics must match pi's runner,
 * or every suite built on them proves the wrong thing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoostExtension } from "../src/index.ts";
import {
	agentSettledEvent,
	applyToolResultHandlers,
	beforeAgentStartEvent,
	createPiStub,
	installedPiVersion,
	textOfBlocks,
	toolExecutionEndEvent,
	toolResult12,
	toolResult86,
} from "./helpers/harness.ts";
import { fixedConfig, memorySettings, stubClient } from "./helpers/runtime.ts";
import { takeViolations, violations } from "./helpers/spawn-spy.ts";

test("the installed pi is one of the supported lines", () => {
	const version = installedPiVersion();
	assert.ok(version, "pi's manifest was found");
	assert.match(version, /^(0\.86\.|0\.(8[7-9]|9\d)\.|1\.)/);
});

test("0.86-shaped events carry none of the 1.x-only fields", () => {
	const result = toolResult86({
		toolName: "bash",
		structuredContent: { output: "x" },
		parentToolCallId: "p",
	});
	assert.equal("structuredContent" in result, false);
	assert.equal("parentToolCallId" in result, false);
	assert.equal("durationMs" in toolExecutionEndEvent("0.86", { toolName: "bash", durationMs: 5 }), false);
	assert.equal("aborted" in agentSettledEvent("0.86"), false);
	assert.equal("messageType" in beforeAgentStartEvent("0.86"), false);
});

test("1.2-shaped events carry them", () => {
	const result = toolResult12({
		toolName: "bash",
		structuredContent: { output: "x" },
		parentToolCallId: "p",
	});
	assert.deepEqual(result.structuredContent, { output: "x" });
	assert.equal(result.parentToolCallId, "p");
	assert.equal(toolExecutionEndEvent("1.2", { toolName: "bash", durationMs: 5 }).durationMs, 5);
	assert.deepEqual(agentSettledEvent("1.2", { aborted: true }), { type: "agent_settled", aborted: true });
	const custom = beforeAgentStartEvent("1.2", { messageType: "custom" });
	assert.equal("messageType" in custom && custom.messageType, "custom");
});

test("on 1.2, replacing content without structuredContent drops it, as pi's runner does", async () => {
	const ctx = createPiStub().ctx();
	const event = toolResult12({ toolName: "bash", content: "long", structuredContent: { output: "long" } });
	const replace = async () => ({ content: [{ type: "text" as const, text: "short" }] });
	const dropped = await applyToolResultHandlers("1.2", [replace], event, ctx);
	assert.equal(dropped?.structuredContent, undefined);

	const keep = async () => ({
		content: [{ type: "text" as const, text: "short" }],
		structuredContent: { output: "long" },
	});
	const kept = await applyToolResultHandlers("1.2", [keep], event, ctx);
	assert.deepEqual(kept?.structuredContent, { output: "long" });
	assert.equal(textOfBlocks(kept?.content), "short");
});

test("no handler change means no patch, and a throwing handler is skipped", async () => {
	const stub = createPiStub();
	const errors: unknown[] = [];
	const throws = () => {
		throw new Error("boom");
	};
	const patch = await applyToolResultHandlers(
		"1.2",
		[throws, () => undefined],
		toolResult12({ toolName: "bash", content: "x" }),
		stub.ctx(),
		errors,
	);
	assert.equal(patch, undefined);
	assert.equal(errors.length, 1);
});

test("the stub records registrations and scripts UI answers", async () => {
	const stub = createPiStub({
		ui: { select: ["b"], confirm: [true], input: ["42"] },
		flags: { "no-boost": true },
	});
	const api = stub.pi as unknown as Record<string, (...a: unknown[]) => unknown>;
	api.registerFlag?.("no-boost", { type: "boolean", default: false });
	assert.equal(api.getFlag?.("no-boost"), true, "a preset flag value wins over the default");
	api.registerCommand?.("x", { handler: async () => "ran", getArgumentCompletions: () => [] });
	assert.equal(await stub.command("x"), "ran");
	api.appendEntry?.("jfrog-boost-stats", { v: 1 });
	assert.deepEqual(stub.appended, [{ customType: "jfrog-boost-stats", data: { v: 1 } }]);

	const ui = stub.ctx().ui;
	assert.equal(await ui.select("pick", ["a", "b"]), "b");
	assert.equal(await ui.confirm("sure?", "really"), true);
	assert.equal(await ui.input("n"), "42");
	assert.equal(await ui.select("again", ["a"]), undefined, "an exhausted script answers like Escape");
	assert.equal(ui.theme.fg("dim", "plain"), "plain");
	assert.equal(stub.ctx().sessionManager.getBranch().length, 0);
});

test("registerToolRenderer exists on the 1.2 stub only", () => {
	assert.equal(
		typeof (createPiStub({ line: "1.2" }).pi as unknown as Record<string, unknown>).registerToolRenderer,
		"function",
	);
	assert.equal(
		(createPiStub({ line: "0.86" }).pi as unknown as Record<string, unknown>).registerToolRenderer,
		undefined,
	);
});

test("the current extension loads on both stub lines", async () => {
	for (const line of ["0.86", "1.2"] as const) {
		const stub = createPiStub({ line, hasUI: false });
		createBoostExtension(stub.pi, {
			client: stubClient({ binary: () => undefined }),
			settings: memorySettings(),
			config: fixedConfig(),
		});
		assert.ok(stub.handlers.has("tool_result"), line);
		assert.equal(
			await stub.emitToolResult(toolResultEvent(line)),
			undefined,
			`${line}: disabled Boost passes through`,
		);
		assert.deepEqual(stub.errors, [], line);
	}
});

test("the stub's pi.exec holds the never-spawn rule, like the spawn spy", async () => {
	const stub = createPiStub();
	assert.deepEqual(violations(), []);
	await assert.rejects(stub.pi.exec("boost", ["retrieve", "7"]), /forbidden Boost command `retrieve 7`/);
	await assert.rejects(stub.pi.exec("/opt/boost", ["init"]), /forbidden/);
	// Recorded, so a caller that swallows the rejection still fails the run.
	const caught = takeViolations();
	assert.deepEqual(
		caught.map((v) => [v.file, ...v.args]),
		[
			["boost", "retrieve", "7"],
			["/opt/boost", "init"],
		],
	);
	assert.deepEqual(await stub.pi.exec("boost", ["report", "-t"]), {
		stdout: "",
		stderr: "",
		code: 0,
		killed: false,
	});
	assert.equal(stub.execCalls.length, 3, "every call, allowed or not, is recorded");
});

function toolResultEvent(line: "0.86" | "1.2") {
	return (line === "1.2" ? toolResult12 : toolResult86)({ toolName: "bash", content: "x".repeat(4096) });
}
