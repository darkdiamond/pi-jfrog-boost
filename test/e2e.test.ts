/**
 * End to end: pi's real tools, the real Boost binary, the real extension.
 *
 * The other suites pin the wiring against a stand-in client. This one checks
 * the assumptions that wiring rests on — what pi's tools actually return, and
 * what Boost actually does with it — which is where earlier releases went
 * wrong: pi turned out to return a document's raw bytes rather than an error.
 *
 * Boost cannot be installed in CI (its installer asks the user to accept an
 * agreement), so the suite skips when no binary is found. `npm run test:e2e`
 * sets PI_BOOST_E2E=1, which turns the skip into a failure. Assertions stick to
 * behaviour this integration guarantees, not to how much a given Boost release
 * happens to compress, so they hold across Boost versions and filter configs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createBashTool,
	createFindTool,
	createReadTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveBoostBinary } from "../src/boost-binary.ts";
import { createBoostClient } from "../src/boost-client.ts";
import { createBoostExtension } from "../src/index.ts";

const DOCX = join(import.meta.dirname, "fixtures", "sample.docx");
const MARKER = /boost retrieve (\d+)/;
const TOOLS = 10;
const DEPS = 20;
/** Markdown files in the generated tree. */
const LISTED = TOOLS * (1 + 2 * DEPS);
const LIST = "find node_modules -name '*.md'";

const binary = resolveBoostBinary({ env: process.env, platform: process.platform, home: homedir() });
const required = process.env.PI_BOOST_E2E === "1";
const skip = !binary && !required ? "Boost is not installed; run `npm run test:e2e` to require it" : false;

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface Outcome {
	text: string;
	isError: boolean;
	/** Whether the extension replaced the tool's result. */
	changed: boolean;
}

let dir = "";
let callId = 0;
const handlers = new Map<string, Handler[]>();

before(async () => {
	if (skip) return;
	if (!binary) assert.fail("PI_BOOST_E2E=1 but no Boost binary was found");

	dir = mkdtempSync(join(tmpdir(), "pi-boost-e2e-"));
	// Boost learns from retrieves: a filter whose output is retrieved three
	// times is switched off in the user's global config. A fresh history per run
	// keeps this suite's single retrieve from counting towards that, and keeps
	// its spans out of the user's `boost report`. Everything spawned below —
	// the extension's Boost calls and pi's shell alike — inherits it.
	process.env.XDG_DATA_HOME = join(dir, ".boost-data");
	// Boost's find filter collapses nested `node_modules` — vendored noise —
	// rather than long listings in general, so the tree is shaped like one.
	for (let i = 0; i < TOOLS; i++) {
		const tool = join(dir, "node_modules", `tool-${i}`);
		mkdirSync(tool, { recursive: true });
		writeFileSync(join(tool, "README.md"), "x\n");
		for (let j = 0; j < DEPS; j++) {
			const dep = join(tool, "node_modules", `dep-${j}`);
			mkdirSync(dep, { recursive: true });
			writeFileSync(join(dep, "README.md"), "x\n");
			writeFileSync(join(dep, "CHANGELOG.md"), "x\n");
		}
	}
	writeFileSync(join(dir, "big.log"), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n"));

	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI;
	createBoostExtension(pi, { client: createBoostClient() });
	assert.equal(await createBoostClient().ready(), true, `Boost at ${binary} is unusable or too old`);
});

after(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

const ctx = () =>
	({
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionId: () => "pi-jfrog-boost-e2e" },
		ui: { notify: () => {}, setStatus: () => {} },
	}) as unknown as ExtensionContext;

/** Run a real pi tool, then hand its result to the extension the way pi does. */
async function run(tool: "read" | "bash" | "find", input: Record<string, unknown>): Promise<Outcome> {
	const definition = { read: createReadTool, bash: createBashTool, find: createFindTool }[tool](dir);
	const toolCallId = `e2e-${++callId}`;
	let content: { type: string; text?: string }[];
	let isError = false;
	try {
		content = (await definition.execute(toolCallId, input as never)).content;
	} catch (error) {
		// pi reports a failed tool to extensions as an error result carrying the message.
		isError = true;
		content = [{ type: "text", text: (error as Error).message }];
	}
	const original = content.map((block) => block.text ?? "").join("\n");

	let patch: { content?: { text?: string }[]; isError?: boolean } | undefined;
	for (const handler of handlers.get("tool_result") ?? []) {
		patch = (await handler({ toolName: tool, toolCallId, input, content, isError }, ctx())) as typeof patch;
	}
	return {
		text: patch?.content?.map((block) => block.text ?? "").join("\n") ?? original,
		isError: patch?.isError ?? isError,
		changed: patch !== undefined,
	};
}

test("a large listing is compacted and can be recovered", { skip }, async () => {
	const listing = await run("bash", { command: LIST });
	assert.ok(listing.changed, `Boost left a ${LISTED}-line listing alone`);
	const id = MARKER.exec(listing.text)?.[1];
	assert.ok(id, "compacted output carries a retrieve marker");

	const recovered = await run("bash", { command: `boost retrieve ${id}` });
	assert.equal(recovered.changed, false, "retrieved output must not be compacted again");
	assert.equal(recovered.text.trim().split("\n").length, LISTED);
});

test("DISABLE_BOOST=1 on a command returns exactly what it printed", { skip }, async () => {
	// The same listing is compacted without the prefix — see the test above.
	const exact = await run("bash", { command: `DISABLE_BOOST=1 ${LIST}` });
	assert.equal(exact.changed, false);
	assert.equal(exact.text.trim().split("\n").length, LISTED);
});

test("a failed command is compacted, stays an error, and keeps pi's exit status", { skip }, async () => {
	const failed = await run("bash", { command: `${LIST}; exit 3` });
	assert.ok(failed.changed, "the failing command's output was not compacted");
	assert.equal(failed.isError, true);
	assert.match(failed.text, /\n\nCommand exited with code 3$/);
});

test("pi's continuation notice survives, whatever Boost does to the body", { skip }, async () => {
	const partial = await run("read", { path: "big.log", limit: 100 });
	assert.match(partial.text, /\[2900 more lines in file\. Use offset=101 to continue\.\]$/);
});

test("an Office file pi returns as raw bytes reaches the model as text", { skip }, async () => {
	const doc = await run("read", { path: DOCX });
	assert.equal(doc.isError, false);
	assert.ok(doc.changed, "pi's raw zip bytes were passed through");
	assert.match(doc.text, /Hello from the sample docx/);
	assert.doesNotMatch(doc.text, /\0/);
});

test("a small source read is left exactly as pi returned it", { skip }, async () => {
	writeFileSync(join(dir, "index.ts"), "export const answer = 42;\n");
	const source = await run("read", { path: "index.ts" });
	assert.equal(source.text, "export const answer = 42;\n");
});
