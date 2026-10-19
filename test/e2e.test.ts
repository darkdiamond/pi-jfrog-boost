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
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createBashTool,
	createReadTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createBoostClient } from "../src/boost-client.ts";
import { createConfigReader } from "../src/boost-config.ts";
import { createBreaker } from "../src/health.ts";
import { createBoostExtension, createNotices, TERMS_NOTICE } from "../src/index.ts";
import { PI_MCP_OUTPUT_MAX_BYTES } from "../src/mcp.ts";
import { createSettingsStore } from "../src/settings.ts";
import { writeLongDocx } from "./helpers/docx.ts";
import {
	applyToolResultHandlers,
	type Block,
	beforeAgentStartEvent,
	type Handler,
	installedPiLine,
	type PiLine,
	sessionStartEvent,
	textOfBlocks,
	toolResultEvent,
} from "./helpers/harness.ts";
import { createHermetic, type Hermetic, type HomeVariant } from "./helpers/hermetic.ts";
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
	// A whole HTML page, well over minBytes: Boost would turn it into article
	// text if it were sent (NP1), which `cat` of a file the model is about to
	// edit must never get.
	writeFileSync(
		join(dir, "index.html"),
		`<!doctype html>\n<html lang="en">\n<head><title>Docs</title></head>\n<body>\n${Array.from(
			{ length: 120 },
			(_, i) => `  <section id="s${i}"><h2>Section ${i}</h2><p>Paragraph ${i} of the page.</p></section>`,
		).join("\n")}\n</body>\n</html>\n`,
	);
	// What a test run leaves behind as a log: exactly the kind of text Boost
	// compacts on stdin, which a `read` must still return byte for byte.
	writeFileSync(
		join(dir, "tap.log"),
		[
			"TAP version 13",
			...Array.from({ length: PASSING }, (_, i) => `ok ${i + 1} - case ${i} passes`),
			"not ok 201 - case 0 fails",
			`1..${PASSING + 1}`,
		].join("\n"),
	);

	await startExtension(handlers, {});
});

/** A pi host whose handlers land in `map`. */
function piFor(map: Map<string, Handler[]>): ExtensionAPI {
	return {
		on: (event: string, handler: Handler) => map.set(event, [...(map.get(event) ?? []), handler]),
		registerCommand: () => {},
		// Never reaches child_process, so hold it to the never-spawn rule here.
		exec: async (command: string, args: string[]) => {
			assertAllowedSpawn(command, args);
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
}

/**
 * Create the extension on `map` and wait until Boost is ready. Readiness is
 * probed in the background from session_start and never awaited by a tool
 * result (spec §8.1), so wait for it the way a session's first turn does —
 * with a generous bound for a loaded machine — then read the verdict from
 * the extension's own readiness state (the `/boost status` title).
 *
 * Not from the `jfrog-boost` awareness section: that is only written when a
 * surface is active (awareness.ts), and a ready Boost can have none — e.g.
 * CLI filtering off in Boost's config, no Preview Agreement (so no
 * documents), and no MCP in the loadout, which is exactly the canary runner.
 */
async function startExtension(map: Map<string, Handler[]>, deps: Parameters<typeof createBoostExtension>[1]) {
	// Its own notice registry: "once per process" must not let one case's
	// notice swallow another's in this shared test process.
	const extension = createBoostExtension(piFor(map), {
		firstTurnWaitMs: 10_000,
		notices: createNotices(),
		...deps,
	});
	for (const handler of map.get("session_start") ?? []) await handler(sessionStartEvent(), ctx());
	const sections: Record<string, string> = {};
	for (const handler of map.get("before_agent_start") ?? []) {
		await handler(beforeAgentStartEvent(line, { sections }), ctx());
	}
	const title = extension.statusReport().split("\n", 1)[0];
	assert.equal(
		title,
		"JFrog Boost — ready",
		`Boost at ${h().binary} did not become ready (unusable or too old)`,
	);
}

/**
 * A second extension whose Boost children see a variant HOME (spec §16.3
 * cases 6 and 9), with `extra` in its environment. pi's own tools keep
 * running in the default hermetic HOME; only what the extension reads and
 * spawns moves. Every filter and convert call is counted, so "zero spawns"
 * is checked where the spawn would happen, and notices are collected from a
 * context with a UI.
 */
async function variantExtension(variant: HomeVariant, extra: NodeJS.ProcessEnv) {
	const home = h().variantHome(variant);
	const env: NodeJS.ProcessEnv = { ...h().envFor(home), ...extra };
	const config = createConfigReader({ home: () => home });
	const settings = createSettingsStore({ env, home: () => home });
	const breaker = createBreaker();
	const real = createBoostClient({
		env,
		home,
		config: config.read,
		shellMode: () => settings.effective().shell,
		breaker,
	});
	let filters = 0;
	let converts = 0;
	const client = {
		...real,
		filter: (...args: Parameters<typeof real.filter>) => {
			filters++;
			return real.filter(...args);
		},
		convert: (...args: Parameters<typeof real.convert>) => {
			converts++;
			return real.convert(...args);
		},
	};
	const notices: string[] = [];
	const map = new Map<string, Handler[]>();
	await startExtension(map, { client, env, settings, config, breaker });
	return {
		handlers: map,
		client: real,
		filters: () => filters,
		converts: () => converts,
		notices,
		ctx: () => ctx(notices),
	};
}

after(() => {
	restoreEnv?.();
	hermetic?.dispose();
});

/**
 * Hoisted (a declaration, not a const) because `before()` above uses it.
 * With `notices`, the context has a UI and collects what it is told.
 */
function ctx(notices?: string[]): ExtensionContext {
	return {
		cwd: dir,
		hasUI: notices !== undefined,
		sessionManager: { getSessionId: () => "pi-jfrog-boost-e2e", getBranch: () => [], getEntries: () => [] },
		ui: { notify: (message: string) => notices?.push(message), setStatus: () => {} },
	} as unknown as ExtensionContext;
}

/**
 * Run a real pi tool, then hand its result to the extension exactly as pi
 * does: pi 1.x returns failures (a non-zero exit) as `isError` results with
 * `structuredContent`; 0.86 throws, and pi reports the message as an error
 * result. Handler results are applied with pi's runner semantics.
 */
async function run(
	tool: "read" | "bash",
	input: Record<string, unknown>,
	options: {
		parentToolCallId?: string;
		handlers?: Map<string, Handler[]>;
		ctx?: () => ExtensionContext;
	} = {},
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
	const map = options.handlers ?? handlers;
	const patch = await applyToolResultHandlers(
		line,
		map.get("tool_result") ?? [],
		event,
		(options.ctx ?? ctx)(),
	);
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

	// By bare name (the binary's directory is on PATH), and by full path, the
	// way the model calls it when `boost` is not on PATH (our-code 6).
	for (const command of [`boost retrieve ${id}`, `'${h().binary}' retrieve ${id}`]) {
		const recovered = await run("bash", { command });
		assert.equal(recovered.changed, false, `${command}: retrieved output must not be compacted again`);
		assert.equal(passLines(recovered.text), PASSING, command);
	}
});

test("DISABLE_BOOST=1 or BOOST_DISABLED=1 on a command returns exactly what it printed", {
	skip,
}, async () => {
	// The same run is compacted without the prefix — see the tests above.
	for (const prefix of ["DISABLE_BOOST=1", "BOOST_DISABLED=1", "export DISABLE_BOOST=1;"]) {
		const exact = await run("bash", { command: `${prefix} ${TAP}` });
		assert.equal(exact.changed, false, prefix);
		assert.equal(exact.text, exact.original, prefix);
		assert.equal(passLines(exact.text), PASSING, prefix);
	}
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
	assert.match(
		doc.text,
		/^\[Converted from sample\.docx by JFrog Boost\. Line numbers refer to this text, not the file\.\]\n/,
	);
	assert.match(doc.text, /Hello from the sample docx/);
	assert.doesNotMatch(doc.text, /\0/);
	if (line === "1.2")
		assert.equal(typeof doc.structuredContent, "string", "read's structured output stays a string");
	const details = doc.details as { jfrogBoost?: { kind?: string; ext?: string } } | undefined;
	assert.deepEqual([details?.jfrogBoost?.kind, details?.jfrogBoost?.ext], ["converted", ".docx"]);
});

// Spec §16.3 case 8.
test("a long document is paged like pi's read, and offset continues from the cache", {
	skip: termsSkip,
}, async () => {
	writeLongDocx(join(dir, "long.docx"), 3000, 40);
	const ext = await variantExtension("default", {});
	const read = (input: Record<string, unknown>) => run("read", input, { handlers: ext.handlers });

	const first = await read({ path: "long.docx" });
	assert.ok(first.changed, "the long docx was not converted");
	assert.equal(first.isError, false);
	const [header, ...rest] = first.text.split("\n");
	assert.match(header ?? "", /^\[Converted from long\.docx by JFrog Boost\./);
	const notice =
		/\n\n\[Showing lines 1-(\d+) of (\d+) \(50\.0KB limit\)\. Use offset=(\d+) to continue\.\]$/.exec(
			first.text,
		);
	assert.ok(notice, `pi's byte-limit notice ends the page: ${first.text.slice(-120)}`);
	const page = rest.join("\n").replace(/\n\n\[Showing[^\n]*\]$/, "");
	assert.ok(page.split("\n").length <= 2000, "at most 2000 lines");
	assert.ok(Buffer.byteLength(page) <= 50 * 1024, "at most 50 KiB");
	assert.match(page, /^Paragraph 1 /);
	const next = Number(notice[3]);
	assert.equal(next, Number(notice[1]) + 1);

	// pi counts the raw zip's few lines, so it refuses this offset; the
	// converted text answers it.
	const second = await read({ path: "long.docx", offset: next });
	assert.ok(second.changed);
	assert.equal(second.isError, false, second.text.slice(0, 200));
	assert.match(second.text, new RegExp(`\\]\\nParagraph ${next} `));
	await read({ path: "long.docx", offset: next, limit: 10 });
	await read({ path: "long.docx" });
	assert.equal(ext.converts(), 1, "every read after the first came from the cache: one boost read in all");
});

// Spec §16.3 case 9; also run with BOOST_E2E_TERMS_FROM pointing at a config without terms.
test("without the Preview Agreement a document fails open, and the user is told once", { skip }, async () => {
	const ext = await variantExtension("no-terms", {});
	for (let i = 0; i < 2; i++) {
		const doc = await run("read", { path: DOCX }, { handlers: ext.handlers, ctx: ext.ctx });
		assert.equal(doc.changed, false);
		assert.equal(doc.text, doc.original);
	}
	assert.equal(ext.converts(), 0, "no boost read without the agreement");
	assert.deepEqual(
		ext.notices.filter((n) => n === TERMS_NOTICE),
		[TERMS_NOTICE],
	);
	// NP3: Boost itself refuses `read` without the agreement.
	const direct = await ext.client.convert({ session_id: "e2e", cwd: dir }, DOCX);
	assert.equal(direct.code, 1, `boost read without terms: ${direct.stdout}`);
});

// Spec §16.3 case 10.
test("a large notebook read whole is converted; offset=1 returns its raw JSON", {
	skip: termsSkip,
}, async () => {
	const notebook = {
		cells: Array.from({ length: 60 }, (_, i) => ({
			cell_type: "code",
			execution_count: i,
			metadata: {},
			source: [`print(${i})\n`, "x = 1\n"],
			outputs: [{ output_type: "stream", name: "stdout", text: [`${"a".repeat(200)}\n`] }],
		})),
		metadata: {},
		nbformat: 4,
		nbformat_minor: 5,
	};
	writeFileSync(join(dir, "nb.ipynb"), JSON.stringify(notebook, null, 1));
	const whole = await run("read", { path: "nb.ipynb" });
	assert.ok(whole.changed, "the notebook was not converted");
	assert.match(
		whole.text,
		/^\[Converted from nb\.ipynb by JFrog Boost\.[^\n]* read it again with offset=1\.\]\n/,
	);
	assert.match(whole.text, /print\(0\)/);
	assert.doesNotMatch(whole.text, /"cell_type"/);
	const raw = await run("read", { path: "nb.ipynb", offset: 1 });
	assert.equal(raw.changed, false);
	assert.equal(raw.text, raw.original);
	assert.match(raw.text, /"cell_type": "code"/);
});

test("a converted notebook over one page points past its first page at the converted text", {
	skip: termsSkip,
}, async () => {
	const notebook = {
		cells: Array.from({ length: 250 }, (_, i) => ({
			cell_type: "code",
			execution_count: i,
			metadata: {},
			source: Array.from({ length: 6 }, (_, j) => `v${i}_${j} = ${j}\n`),
			outputs: [{ output_type: "stream", name: "stdout", text: [`out ${i}\n`] }],
		})),
		metadata: {},
		nbformat: 4,
		nbformat_minor: 5,
	};
	writeFileSync(join(dir, "many.ipynb"), JSON.stringify(notebook, null, 1));
	const whole = await run("read", { path: "many.ipynb" });
	assert.ok(whole.changed, "the notebook was not converted");
	const notice = whole.text.match(
		/\n\n\[Showing lines 1-(\d+) of (\d+) of the converted notebook[^\]]*\. To continue, use bash: boost read -- (\S+) \| sed -n '(\d+),(\d+)p'\. A read with offset returns the raw notebook JSON instead\.\]$/,
	);
	assert.ok(notice, whole.text.slice(-400));
	const [last, total, next] = [notice[1], notice[2], notice[4]].map(Number) as [number, number, number];
	assert.equal(next, last + 1);
	assert.ok(total > last);
	assert.doesNotMatch(whole.text, /Use offset=/);
	// The text the notice's command pages is the text this page came from.
	const ext = await variantExtension("default", {});
	const converted = await ext.client.convert({ session_id: "e2e", cwd: dir }, join(dir, "many.ipynb"));
	assert.equal(converted.code, 0);
	const lines = converted.stdout.split("\n");
	assert.equal(lines.length, total);
	assert.ok(whole.text.endsWith(`\n${lines[last - 1]}${notice[0]}`));
	assert.doesNotMatch(lines[next - 1] ?? "", /"cell_type"/);
});

test("a small source read is left exactly as pi returned it", { skip }, async () => {
	writeFileSync(join(dir, "index.ts"), "export const answer = 42;\n");
	const source = await run("read", { path: "index.ts" });
	assert.equal(source.changed, false);
	assert.equal(source.text, "export const answer = 42;\n");
});

test("HTML and log files are byte-exact, through read and through cat", { skip }, async () => {
	for (const [tool, input] of [
		["read", { path: "index.html" }],
		["bash", { command: "cat index.html" }],
		["read", { path: "tap.log" }],
	] as const) {
		const outcome = await run(tool, input);
		assert.equal(outcome.changed, false, `${tool} ${JSON.stringify(input)}`);
		assert.equal(outcome.text, outcome.original, `${tool} ${JSON.stringify(input)}`);
	}
	const page = await run("bash", { command: "cat index.html" });
	assert.match(page.text, /^<!doctype html>/, "the source, not article text");
});

test("output under 2 KiB is left exactly as printed", { skip }, async () => {
	const small = await run("bash", {
		command: `node -e "for (let i = 0; i < 20; i++) console.log('ok ' + i + ' - case ' + i)"`,
	});
	assert.ok(Buffer.byteLength(small.original) < 2048, `${Buffer.byteLength(small.original)} B`);
	assert.equal(small.changed, false);
	assert.equal(small.text, small.original);
});

test("with CLI filtering off in Boost's config, nothing is sent; shell: on compacts anyway", {
	skip,
}, async () => {
	// HOME with `boost-cli-filtering` user = false and `shell: auto`: the gate
	// is off, so not a single filter call is made (spec §8.4).
	const auto = await variantExtension("user-false", {});
	const untouched = await run("bash", { command: TAP }, { handlers: auto.handlers });
	assert.equal(untouched.changed, false);
	assert.equal(auto.filters(), 0, "zero filter spawns with the gate off");

	// The same HOME with PI_BOOST_SHELL=on: CLI filtering is forced on in pi's
	// own child environment only (F1), and config.toml is left as it was.
	const configPath = join(h().variantHome("user-false"), ".boost", "config.toml");
	const configBefore = readFileSync(configPath, "utf8");
	const forced = await variantExtension("user-false", { PI_BOOST_SHELL: "on" });
	const compacted = await run("bash", { command: TAP }, { handlers: forced.handlers });
	assert.equal(forced.filters(), 1);
	assert.ok(compacted.changed, "forced on, Boost compacted the run although config says user = false");
	assert.ok(compacted.text.length < compacted.original.length);
	assert.equal(readFileSync(configPath, "utf8"), configBefore, "Boost's config was not written");
});

// Spec §16.3 case 1: structuredContent and details.jfrogBoost. On 0.86 the
// first half is moot (no structuredContent); the details half still holds.
test("a compacted failure keeps pi's structuredContent and is marked in details", { skip }, async () => {
	const failed = await run("bash", { command: `${TAP}; exit 3` });
	assert.ok(failed.changed, "the failing command's output was not compacted");
	assert.equal(failed.isError, true);
	assert.match(failed.text, /\n\nCommand exited with code 3$/);
	if (line === "1.2") {
		assert.notEqual(failed.originalStructuredContent, undefined, "pi 1.x's bash returned structuredContent");
		assert.deepEqual(failed.structuredContent, failed.originalStructuredContent);
	}
	const details = failed.details as
		| { jfrogBoost?: { kind?: string; before?: number; after?: number } }
		| undefined;
	assert.equal(details?.jfrogBoost?.kind, "compacted");
	assert.ok((details?.jfrogBoost?.after ?? Infinity) < (details?.jfrogBoost?.before ?? 0));
});

// ---------------------------------------------------------------------------
// MCP (spec §16.3 case 11)

interface McpFixture {
	toolName: string;
	input: Record<string, unknown>;
	content: Block[];
	details: unknown;
	structuredContent: unknown;
}

const mcpFixture = (name: string): McpFixture =>
	JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as McpFixture;

/**
 * Hand a synthetic MCP result to the extension as pi 1.x's MCP client would
 * deliver it. There is no MCP server here: what is under test is what Boost's
 * `hook claude` does with pi's result shape, and how it is put back.
 */
async function emitMcp(
	f: McpFixture,
	target: { handlers: Map<string, Handler[]>; ctx: () => ExtensionContext } = { handlers, ctx },
): Promise<Outcome & { content: Block[] }> {
	const event = toolResultEvent(line, {
		toolName: f.toolName,
		toolCallId: `e2e-${++callId}`,
		input: f.input,
		content: f.content,
		details: f.details,
		structuredContent: f.structuredContent,
	});
	const patch = await applyToolResultHandlers(
		line,
		target.handlers.get("tool_result") ?? [],
		event,
		target.ctx(),
	);
	return {
		text: textOfBlocks(patch?.content ?? f.content),
		content: patch?.content ?? f.content,
		isError: patch?.isError ?? false,
		changed: patch !== undefined,
		structuredContent: patch ? patch.structuredContent : event.structuredContent,
		originalStructuredContent: event.structuredContent,
		details: patch ? patch.details : f.details,
		original: textOfBlocks(f.content),
	};
}

test("MCP results are compacted by Boost's MCP filters; images and structuredContent stay", {
	skip,
}, async () => {
	for (const name of ["mcp-slack.json", "mcp-snapshot.json"]) {
		const f = mcpFixture(name);
		const outcome = await emitMcp(f);
		assert.ok(outcome.changed, `${f.toolName}: Boost left the result alone`);
		assert.ok(outcome.text.length < outcome.original.length, f.toolName);
		assert.match(outcome.text, MARKER, `${f.toolName}: compacted output carries a retrieve marker`);
		// Non-text blocks keep their places; the text collapses into the first text slot.
		assert.deepEqual(
			outcome.content.map((block) => block.type),
			f.content.map((block) => block.type),
			f.toolName,
		);
		assert.deepEqual(
			outcome.content.filter((block) => block.type !== "text"),
			f.content.filter((block) => block.type !== "text"),
			f.toolName,
		);
		if (line === "1.2") assert.deepEqual(outcome.structuredContent, f.structuredContent, f.toolName);
		const details = outcome.details as { jfrogBoost?: { kind?: string; retrieveId?: number } } | undefined;
		assert.equal(details?.jfrogBoost?.kind, "mcp", f.toolName);
		assert.equal(String(details?.jfrogBoost?.retrieveId), MARKER.exec(outcome.text)?.[1], f.toolName);
	}
	// NP5: the hook writes nothing into the project, unlike Boost's Bash hook.
	assert.equal(existsSync(join(dir, ".boost")), false, "no .boost/ in the working directory");
});

test("with no MCP flag recorded, Boost's own default applies and nothing is lost", { skip }, async (t) => {
	// What most users run: their config.toml says nothing about
	// boost-mcp-filtering, the router counts that as eligible, and Boost
	// decides. v0.15.4 compacts Slack and leaves snapshots whole, but a
	// release may change that default, so only fail-open behaviour is
	// asserted: each result is either compacted (with a marker) or exactly
	// pi's, and its images and structuredContent are untouched either way.
	const ext = await variantExtension("mcp-unset", {});
	for (const name of ["mcp-slack.json", "mcp-snapshot.json"]) {
		const f = mcpFixture(name);
		const outcome = await emitMcp(f, { handlers: ext.handlers, ctx: ext.ctx });
		t.diagnostic(`${f.toolName}: ${outcome.changed ? "compacted" : "left alone"} by Boost's default`);
		if (outcome.changed) {
			assert.ok(outcome.text.length < outcome.original.length, f.toolName);
			assert.match(outcome.text, MARKER, f.toolName);
		} else {
			assert.deepEqual(outcome.content, f.content, f.toolName);
		}
		assert.deepEqual(
			outcome.content.filter((block) => block.type !== "text"),
			f.content.filter((block) => block.type !== "text"),
			f.toolName,
		);
		if (line === "1.2") assert.deepEqual(outcome.structuredContent, f.structuredContent, f.toolName);
	}
});

test("an MCP tool Boost has no filter for comes back the same size and is left alone", { skip }, async () => {
	const text = Array.from({ length: 300 }, (_, i) => `row ${i}: ${"value ".repeat(8)}`).join("\n");
	const outcome = await emitMcp({
		toolName: "mcp__gh__dump",
		input: {},
		content: [{ type: "text", text }],
		details: { server: "gh", tool: "dump" },
		structuredContent: { rows: 300 },
	});
	assert.equal(outcome.changed, false);
	assert.equal(outcome.text, text);
});

test("an MCP result pi truncated is re-filtered from pi's full-output file", { skip }, async () => {
	// pi 1.x cuts MCP text to 20 KiB in the middle and saves the whole of it
	// under os.tmpdir() (the hermetic HOME's tmp here); the format is copied
	// from pi 1.2.0's `limitMcpContent`.
	const snapshot = mcpFixture("mcp-snapshot.json");
	const page = (snapshot.content[0] as { text: string }).text;
	const items = page.split("\n").filter((l) => l.startsWith("      ") || l.startsWith("    - list "));
	const full = [page, ...Array.from({ length: 12 }, () => items.join("\n"))].join("\n");
	assert.ok(Buffer.byteLength(full) > 4 * PI_MCP_OUTPUT_MAX_BYTES);
	// Named as pi 1.2.0 names it: the route reads no other file.
	const path = join(tmpdir(), `pi-mcp-${randomBytes(8).toString("hex")}.txt`);
	writeFileSync(path, full);
	const half = PI_MCP_OUTPUT_MAX_BYTES / 2;
	const truncated = `Warning: truncated output (original token count: ${Math.ceil(Buffer.byteLength(full) / 4)})\nTotal output lines: ${full.split("\n").length}\n\n${full.slice(0, half)}\u2026${full.length - 2 * half} chars truncated\u2026${full.slice(-half)}\n\n[Full output: ${path} (read it with offset/limit)]`;
	const outcome = await emitMcp({
		...snapshot,
		content: [{ type: "text", text: truncated }, ...snapshot.content.slice(1)],
		details: { server: "playwright", tool: "browser_snapshot", fullOutputPath: path },
	});
	assert.ok(outcome.changed, "Boost left pi's truncated snapshot alone");
	assert.match(outcome.text, MARKER);
	assert.ok(
		outcome.text.endsWith(`Full output: ${path} (read it with offset/limit)]`),
		outcome.text.slice(-200),
	);
	assert.doesNotMatch(outcome.text, /chars truncated/, "built from the whole output, not pi's cut");
	assert.ok(Buffer.byteLength(outcome.text) < truncated.length);
});

// Spec §16.3 case 13.
test("a long run pi truncated is re-filtered whole, so its early failures reach the model", {
	skip,
}, async (t) => {
	// ~9000 lines of TAP whose three failures come first: pi keeps the last
	// 2000 lines (or 50 KiB), which are all passes, and saves the whole run
	// under os.tmpdir() — the hermetic HOME's tmp here.
	writeFileSync(
		join(dir, "long.test.mjs"),
		[
			`import { test } from "node:test";`,
			`import assert from "node:assert/strict";`,
			`for (let i = 0; i < ${FAILING}; i++) test(\`early \${i} fails\`, () => assert.equal(i, 42));`,
			`for (let i = 0; i < 1490; i++) test(\`case \${i} passes\`, () => {});`,
		].join("\n"),
	);
	const command = "node --test --test-reporter=tap long.test.mjs";
	const long = await run("bash", { command });
	const notice =
		/\n\n(\[Showing lines \d+-(\d+) of (\d+)[^\n]*\. Full output: ([^\n]+)\])\n\nCommand exited with code 1$/.exec(
			long.original,
		);
	assert.ok(notice, `pi truncated the run: ${long.original.slice(-200)}`);
	const [, piNotice, , total] = notice;
	assert.ok(Number(total) >= 8000, `${total} lines`);
	assert.doesNotMatch(long.original, /^not ok \d+ - early 0 fails$/m, "pi's tail dropped the early failures");

	/** The whole run, filtered, with pi's notice rewritten and `status` (pi's exit notice) after it. */
	const assertRefiltered = (outcome: Outcome, status: string) => {
		assert.ok(outcome.changed, "the truncated run was left as pi's tail");
		// Each run has a file of its own.
		const file = /\. Full output: ([^\n]+)\]/.exec(outcome.original)?.[1];
		for (let i = 0; i < FAILING; i++) {
			assert.match(outcome.text, new RegExp(`not ok \\d+ - early ${i} fails`), `early failure ${i} surfaced`);
		}
		assert.ok(
			outcome.text.endsWith(
				`\n\n[Boost compacted the full ${total}-line output. Full output: ${file}]${status}`,
			),
			outcome.text.slice(-300),
		);
		const body = outcome.text.slice(0, outcome.text.indexOf("\n\n[Boost compacted the full"));
		assert.ok(body.split("\n").length <= 2000 && Buffer.byteLength(body) <= 50 * 1024, "within pi's page");
		const details = outcome.details as { jfrogBoost?: { kind?: string; full?: boolean } } | undefined;
		assert.deepEqual([details?.jfrogBoost?.kind, details?.jfrogBoost?.full], ["compacted", true]);
	};

	assert.equal(long.isError, true);
	if (line === "1.2") {
		assertRefiltered(long, "\n\nCommand exited with code 1");
		assert.deepEqual(long.structuredContent, long.originalStructuredContent);
	} else {
		// pi 0.86 throws a failed command, and the error result it builds from
		// the message carries no `details`, so no `fullOutputPath`: the path is
		// only in the text, which is not trusted for it (§6.3). The run keeps
		// the tail route — compacted, but without the early failures. A known
		// 0.86 limitation, asserted so a change in it is noticed.
		assert.ok(long.changed, "the tail route still compacted the run");
		assert.ok(long.text.endsWith(`\n\n${piNotice}\n\nCommand exited with code 1`), long.text.slice(-300));
		assert.doesNotMatch(long.text, /early 0 fails/);
		// The same run ending in exit 0 is returned, with its `details`: the
		// re-filter works end to end on 0.86 too when pi names the file.
		const passed = await run("bash", { command: `${command}; true` });
		assert.equal(passed.isError, false);
		assertRefiltered(passed, "");
	}
	t.diagnostic(
		`pi's tail ${Buffer.byteLength(long.original)} B → ${Buffer.byteLength(long.text)} B from ${total} lines`,
	);
});

const onlyOn12 = skip || (line !== "1.2" ? "pi 1.x only: 0.86 has no nested calls" : false);

test("a nested tool call is left exactly as pi returned it", { skip: onlyOn12 }, async () => {
	const nested = await run("bash", { command: TAP }, { parentToolCallId: "e2e-parent" });
	assert.equal(nested.changed, false);
	assert.equal(nested.text, nested.original);
	// A codemode script's MCP call: its result goes back to the script.
	const f = mcpFixture("mcp-snapshot.json");
	const event = toolResultEvent(line, { ...f, parentToolCallId: "e2e-parent" });
	const patch = await applyToolResultHandlers(line, handlers.get("tool_result") ?? [], event, ctx());
	assert.equal(patch, undefined);
});

// Last on purpose: top-level tests run in order, so this sees every spawn above.
test("the real Boost config and history were not touched", { skip }, (t) => {
	for (const path of h().tripwire.paths) t.diagnostic(`tripwire watched ${path}`);
	h().tripwire.assertUnchanged();
	t.diagnostic("tripwire: no change to the real Boost state");
});
