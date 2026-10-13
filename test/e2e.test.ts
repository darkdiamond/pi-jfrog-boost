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
 * Boost is not installed in CI (installing it means accepting JFrog's
 * agreement), so the suite skips when no binary is found. `npm run test:e2e`
 * sets PI_BOOST_E2E=1, which turns the skip into a failure. Assertions stick
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

const DOCX = join(import.meta.dirname, "fixtures", "sample.docx");
const MARKER = /boost retrieve (\d+)/;
/** Passing and failing cases in the generated TAP suite. */
const PASSING = 200;
const FAILING = 3;
const TAP = "node --test --test-reporter=tap tap.test.mjs";

const required = process.env.PI_BOOST_E2E === "1";
const strict = process.env.PI_BOOST_E2E_STRICT === "1";

// Built at load time, before any test spawns anything: it fingerprints the
// real Boost state first and resolves the binary while HOME is still real.
const hermetic: Hermetic = createHermetic();
const skip =
	!hermetic.binary && !required ? "Boost is not installed; run `npm run test:e2e` to require it" : false;
/**
 * Cases that need Boost's Preview Agreement recorded: `boost read` and
 * `boost retrieve` both exit 1 without it ("accept_terms is missing"), while
 * the stdin filter works regardless (spec F2, NP3).
 */
const termsSkip = skip || (!hermetic.termsAvailable && !strict ? hermetic.termsMissingReason : false);

/** pi 1.x reports nested calls and structured output and returns failures; 0.86 throws them. */
const line: PiLine = installedPiLine();

interface Outcome {
	text: string;
	isError: boolean;
	/** Whether the extension replaced the tool's result. */
	changed: boolean;
	/** What pi would hand the model's structured channel (1.x), after the patch. */
	structuredContent: unknown;
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
	if (skip) return;
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
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI;
	// Created after `apply()`: the client reads HOME and the environment live
	// from `process.env`, which now is the hermetic one.
	createBoostExtension(pi, { client: createBoostClient() });
	assert.equal(await createBoostClient().ready(), true, `Boost at ${hermetic.binary} is unusable or too old`);
});

after(() => {
	restoreEnv?.();
	hermetic.dispose();
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
async function run(tool: "read" | "bash", input: Record<string, unknown>): Promise<Outcome> {
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
	});
	const patch = await applyToolResultHandlers(line, handlers.get("tool_result") ?? [], event, ctx());
	return {
		text: textOfBlocks(patch?.content ?? output.content),
		isError: patch?.isError ?? isError,
		changed: patch !== undefined,
		structuredContent: patch ? patch.structuredContent : output.structuredContent,
		original: textOfBlocks(output.content),
	};
}

const passLines = (text: string) =>
	text.split("\n").filter((l) => /^\s*ok \d+ - case \d+ passes/.test(l)).length;

test("the suite runs in a throwaway HOME, never the real one", { skip }, () => {
	hermetic.assertIsolated();
	assert.equal(process.env.BOOST_DB_PATH, join(hermetic.home, "history.db"));
	assert.equal(process.env.BOOST_BIN, hermetic.binary);
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

// Last on purpose: top-level tests run in order, so this sees every spawn above.
test("the real Boost config and history were not touched", { skip }, (t) => {
	for (const path of hermetic.tripwire.paths) t.diagnostic(`tripwire watched ${path}`);
	hermetic.tripwire.assertUnchanged();
	t.diagnostic("tripwire: no change to the real Boost state");
});
