/**
 * End to end: pi's real tools, the real Boost binary, the real extension —
 * inside a throwaway HOME.
 *
 * The other suites pin the wiring against stand-ins. This one checks the
 * assumptions that wiring rests on — what pi's tools actually return, and
 * what Boost actually does with it — which is where earlier releases went
 * wrong: pi turned out to return a document's raw bytes rather than an error,
 * and (pi 1.x) a failing command's result rather than a throw.
 *
 * Hermetic by construction (test/helpers/hermetic.ts): before anything runs,
 * HOME, Boost's DB, temp and XDG dirs move into a temp directory with a
 * synthesized Boost config, proxies point at a refused port, and the real
 * `~/.boost` and history DB are fingerprinted. The last test fails if any of
 * them changed. 0.3.0's suite wrote the maintainer's real Boost history and
 * counted its retrieve towards Boost switching a filter off for every agent;
 * that must never happen again. Never point this suite at your real HOME.
 *
 * Opt-in: the suite runs only under PI_BOOST_E2E=1, which `npm run test:e2e`
 * (scripts/e2e.mjs) sets, and then a missing Boost binary is a failure. The
 * file matches `npm test`'s glob, but there — and so in `npm run check`,
 * prepublishOnly and CI, where Boost is not installed because installing it
 * means accepting JFrog's agreement — it skips without spawning Boost or
 * fingerprinting anything, whatever Boost the machine happens to have. A
 * release must not depend on the maintainer's Boost, or fail because another
 * agent on the machine used Boost mid-run and tripped the tripwire. Assertions stick
 * to behaviour this integration guarantees, not to how much a given Boost
 * release happens to compress, so they hold across Boost versions.
 *
 * Point it at a specific binary or terms source with BOOST_BIN and
 * BOOST_E2E_TERMS_FROM (or BOOST_E2E_HOME); see CONTRIBUTING.md. Document and
 * retrieve cases skip when no accepted terms are available, or fail under
 * PI_BOOST_E2E_STRICT=1.
 */
import "./helpers/spawn-spy.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createBashTool,
	createReadTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createBoostClient } from "../src/boost-client.ts";
import { createBoostExtension } from "../src/index.ts";
import {
	applyToolResultHandlers,
	type Block,
	type Handler,
	installedPiLine,
	type PiLine,
	textOfBlocks,
	toolResultEvent,
} from "./helpers/harness.ts";
import { createHermetic, type Hermetic } from "./helpers/hermetic.ts";
import { assertAllowedSpawn } from "./helpers/spawn-spy.ts";

const DOCX = join(import.meta.dirname, "fixtures", "sample.docx");
const MARKER = /boost retrieve (\d+)/;
/** Passing and failing cases in the generated TAP suite. */
const PASSING = 200;
const FAILING = 3;
const TAP = "node --test --test-reporter=tap tap.test.mjs";

const enabled = process.env.PI_BOOST_E2E === "1";
const strict = process.env.PI_BOOST_E2E_STRICT === "1";

// Built at load time, before any test spawns anything: it fingerprints the
// real Boost state first and resolves the binary while HOME is still real.
// Not built at all when the suite is off, so `npm test` creates no temp HOME
// and reads no real Boost state.
const hermetic: Hermetic | undefined = enabled ? createHermetic() : undefined;
const skip: string | false = hermetic
	? false
	: "real-Boost e2e is opt-in: run `npm run test:e2e` (sets PI_BOOST_E2E=1)";
/** The harness, in code that only runs when the suite is on. */
const h = (): Hermetic => {
	if (!hermetic) throw new Error("e2e: the hermetic harness is not set up (PI_BOOST_E2E is not 1)");
	return hermetic;
};
/**
 * Cases that need Boost's Preview Agreement recorded: `boost read` and
 * `boost retrieve` both exit 1 without it ("accept_terms is missing"), while
 * the stdin filter works regardless (spec F2, NP3).
 */
const termsSkip =
	skip || (hermetic && !hermetic.termsAvailable && !strict ? (hermetic.termsMissingReason ?? true) : false);

/** pi 1.x reports nested calls and structured output and returns failures; 0.86 throws them. */
const line: PiLine = installedPiLine();

interface Outcome {
	text: string;
	isError: boolean;
	/** Whether the extension replaced the tool's result. */
	changed: boolean;
	/** What pi would hand the model's structured channel (1.x), after the patch. */
	structuredContent: unknown;
	/** The tool's `structuredContent`, before the extension. */
	originalStructuredContent: unknown;
	/** The result's `details`, after the patch. */
	details: unknown;
	/** The tool's own text, before the extension. */
	original: string;
}

/** The part of pi's AgentToolResult this suite reads; reached structurally to typecheck on 0.86 and 1.2. */
interface ToolOutput {
	content: Block[];
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

let dir = "";
let callId = 0;
let restoreEnv: (() => void) | undefined;
const handlers = new Map<string, Handler[]>();

before(async () => {
	if (!hermetic) return;
	if (!hermetic.binary) assert.fail("PI_BOOST_E2E=1 but no Boost binary was found (set BOOST_BIN)");
	if (!hermetic.termsAvailable && strict)
		assert.fail(`PI_BOOST_E2E_STRICT=1: ${hermetic.termsMissingReason}`);

	restoreEnv = hermetic.apply();
	// Nothing below may spawn Boost unless this holds.
	hermetic.assertIsolated();

	dir = join(hermetic.home, "work");
	mkdirSync(dir, { recursive: true });
	// A node:test suite with many passes and a few failures: the noisy,
	// mostly-irrelevant output Boost exists to compact. Run through pi's real
	// bash, so Boost sees the command and output a model would produce.
	writeFileSync(
		join(dir, "tap.test.mjs"),
		[
			`import { test } from "node:test";`,
			`import assert from "node:assert/strict";`,
			`for (let i = 0; i < ${PASSING}; i++) test(\`case \${i} passes\`, () => {});`,
			`for (let i = 0; i < ${FAILING}; i++) test(\`case \${i} fails\`, () => assert.equal(i, 42));`,
		].join("\n"),
	);
	writeFileSync(join(dir, "big.log"), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"));

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: () => {},
		// Never reaches child_process, so hold it to the never-spawn rule here.
		exec: async (command: string, args: string[]) => {
			assertAllowedSpawn(command, args);
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	// Created after `apply()`: the client reads HOME and the environment live
	// from `process.env`, which now is the hermetic one.
	createBoostExtension(pi, { client: createBoostClient() });
	assert.equal(await createBoostClient().ready(), true, `Boost at ${hermetic.binary} is unusable or too old`);
});

after(() => {
	restoreEnv?.();
	hermetic?.dispose();
});

const ctx = () =>
	({
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionId: () => "pi-jfrog-boost-e2e", getBranch: () => [], getEntries: () => [] },
		ui: { notify: () => {}, setStatus: () => {} },
	}) as unknown as ExtensionContext;

/**
 * Run a real pi tool, then hand its result to the extension exactly as pi
 * does: pi 1.x returns failures (a non-zero exit) as `isError` results with
 * `structuredContent`; 0.86 throws, and pi reports the message as an error
 * result. Handler results are applied with pi's runner semantics.
 */
async function run(
	tool: "read" | "bash",
	input: Record<string, unknown>,
	options: { parentToolCallId?: string } = {},
): Promise<Outcome> {
	const definition = { read: createReadTool, bash: createBashTool }[tool](dir);
	const toolCallId = `e2e-${++callId}`;
	let output: ToolOutput;
	let isError = false;
	try {
		output = (await definition.execute(toolCallId, input as never)) as unknown as ToolOutput;
		isError = output.isError === true;
	} catch (error) {
		isError = true;
		output = { content: [{ type: "text", text: (error as Error).message }] };
	}
	const event = toolResultEvent(line, {
		toolName: tool,
		toolCallId,
		input,
		content: output.content,
		details: output.details,
		isError,
		structuredContent: output.structuredContent,
		parentToolCallId: options.parentToolCallId,
	});
	const patch = await applyToolResultHandlers(line, handlers.get("tool_result") ?? [], event, ctx());
	return {
		text: textOfBlocks(patch?.content ?? output.content),
		isError: patch?.isError ?? isError,
		changed: patch !== undefined,
		structuredContent: patch ? patch.structuredContent : output.structuredContent,
		originalStructuredContent: output.structuredContent,
		details: patch ? patch.details : output.details,
		original: textOfBlocks(output.content),
	};
}

const passLines = (text: string) =>
	text.split("\n").filter((l) => /^\s*ok \d+ - case \d+ passes/.test(l)).length;

test("the suite runs in a throwaway HOME, never the real one", { skip }, () => {
	h().assertIsolated();
	assert.equal(process.env.BOOST_DB_PATH, join(h().home, "history.db"));
	assert.equal(process.env.BOOST_BIN, h().binary);
});

test("a failing TAP run is compacted and carries a retrieve marker", { skip }, async () => {
	const tap = await run("bash", { command: TAP });
	assert.ok(tap.changed, `Boost left a ${PASSING + FAILING}-case TAP run alone`);
	assert.ok(tap.text.length < tap.original.length, "compacted output is shorter than the original");
	assert.match(tap.text, MARKER, "compacted output carries a retrieve marker");
});

test("the marker's retrieve recovers the original, which is not compacted again", {
	skip: termsSkip,
}, async () => {
	const tap = await run("bash", { command: TAP });
	const id = MARKER.exec(tap.text)?.[1];
	assert.ok(id, "compacted output carries a retrieve marker");

	const recovered = await run("bash", { command: `boost retrieve ${id}` });
	assert.equal(recovered.changed, false, "retrieved output must not be compacted again");
	assert.equal(passLines(recovered.text), PASSING);
});

test("DISABLE_BOOST=1 on a command returns exactly what it printed", { skip }, async () => {
	// The same run is compacted without the prefix — see the test above.
	const exact = await run("bash", { command: `DISABLE_BOOST=1 ${TAP}` });
	assert.equal(exact.changed, false);
	assert.equal(passLines(exact.text), PASSING);
});

test("a failed command is compacted, stays an error, and keeps pi's exit status", { skip }, async () => {
	const failed = await run("bash", { command: `${TAP}; exit 3` });
	assert.ok(failed.changed, "the failing command's output was not compacted");
	assert.equal(failed.isError, true);
	assert.match(failed.text, /\n\nCommand exited with code 3$/);
});

test("pi's continuation notice survives, whatever Boost does to the body", { skip }, async () => {
	const partial = await run("read", { path: "big.log", limit: 100 });
	assert.match(partial.text, /\[2900 more lines in file\. Use offset=101 to continue\.\]$/);
});

test("an Office file pi returns as raw bytes reaches the model as text", { skip: termsSkip }, async () => {
	const doc = await run("read", { path: DOCX });
	assert.equal(doc.isError, false);
	assert.ok(doc.changed, "pi's raw zip bytes were passed through");
	assert.match(doc.text, /Hello from the sample docx/);
	assert.doesNotMatch(doc.text, /\0/);
});

test("a small source read is left exactly as pi returned it", { skip }, async () => {
	writeFileSync(join(dir, "index.ts"), "export const answer = 42;\n");
	const source = await run("read", { path: "index.ts" });
	assert.equal(source.changed, false);
	assert.equal(source.text, "export const answer = 42;\n");
});

// Spec §16.3 cases 1 (structuredContent, details.jfrogBoost) and 12 (nested
// calls) need the integrity work of WP3: today's extension replaces content
// without passing structuredContent on, so pi 1.x drops it, and it does not
// look at parentToolCallId. Recorded here as `todo` so the gap shows in every
// e2e run without failing it; WP3 removes the `todo` and they must pass.
const onlyOn12 =
	skip || (line !== "1.2" ? "pi 1.x only: 0.86 has no structuredContent or nested calls" : false);

test("a compacted failure keeps pi's structuredContent and is marked in details", {
	skip: onlyOn12,
	todo: "WP3 (spec §16.3 case 1): preserve structuredContent and set details.jfrogBoost",
}, async () => {
	const failed = await run("bash", { command: `${TAP}; exit 3` });
	assert.ok(failed.changed, "the failing command's output was not compacted");
	assert.notEqual(failed.originalStructuredContent, undefined, "pi 1.x's bash returned structuredContent");
	assert.deepEqual(failed.structuredContent, failed.originalStructuredContent);
	const details = failed.details as { jfrogBoost?: unknown } | undefined;
	assert.ok(details?.jfrogBoost, "details.jfrogBoost is set");
});

test("a nested tool call is left exactly as pi returned it", {
	skip: onlyOn12,
	todo: "WP3 (spec §16.3 case 12): skip calls with a parentToolCallId",
}, async () => {
	const nested = await run("bash", { command: TAP }, { parentToolCallId: "e2e-parent" });
	assert.equal(nested.changed, false);
});

// Last on purpose: top-level tests run in order, so this sees every spawn above.
test("the real Boost config and history were not touched", { skip }, (t) => {
	for (const path of h().tripwire.paths) t.diagnostic(`tripwire watched ${path}`);
	h().tripwire.assertUnchanged();
	t.diagnostic("tripwire: no change to the real Boost state");
});
