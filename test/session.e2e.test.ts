/**
 * End to end through pi's own runner: a real AgentSession, the extension
 * loaded from src/index.ts the way pi loads a package, pi's real tools, the
 * real Boost binary — with a scripted model instead of a network one.
 *
 * test/e2e.test.ts calls the extension's handlers through a stub
 * ExtensionAPI and applies their results with the harness's copy of pi's
 * runner semantics. That cannot catch what only a real session does: the
 * runner's own tool_result patch merge, the loadout pi hands
 * `before_agent_start`, built-in MCP naming, exposure and truncation, and
 * codemode nesting. Two 0.4.0 problems (MCP under pi 1.x's default codemode
 * exposure, and the awareness text lagging deferred MCP tools by a prompt)
 * showed up only in a real session. Here the model is pi-ai's faux provider
 * (present in both supported pi lines): each scripted step is a tool call,
 * and what the session records — `session.messages`' tool results and the
 * context the model is sent — is what is asserted on.
 *
 * Same gate and the same hermetic harness as test/e2e.test.ts (read its
 * header): runs only under PI_BOOST_E2E=1 (`npm run test:e2e` runs both
 * files), in a throwaway HOME whose agent dir also holds pi's mcp.json, and
 * fails if the real Boost state changed. The MCP cases need pi ≥ 0.99, which
 * added built-in MCP; on 0.86 they skip.
 */
import "./helpers/spawn-spy.ts";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedPiLine, type PiLine } from "./helpers/harness.ts";
import { createHermetic, type Hermetic } from "./helpers/hermetic.ts";

const REPO = dirname(import.meta.dirname);
const EXTENSION = join(REPO, "src", "index.ts");
const MCP_SERVER = join(import.meta.dirname, "fixtures", "mcp-stub-server.mjs");
const MARKER = /boost retrieve (\d+)/;
const PASSING = 200;
const FAILING = 3;
const TAP = "node --test --test-reporter=tap tap.test.mjs";
/** How long Boost's readiness probe and MCP connections may take on a loaded machine. */
const SETTLE_MS = 30_000;

const enabled = process.env.PI_BOOST_E2E === "1";
const strict = process.env.PI_BOOST_E2E_STRICT === "1";
const hermetic: Hermetic | undefined = enabled ? createHermetic() : undefined;
/** Missing terms fail rather than skip: under STRICT, or when a terms source was named explicitly. */
const termsStrict = strict || (hermetic?.termsRequired ?? false);
const skip: string | false = hermetic
	? false
	: "real-Boost e2e is opt-in: run `npm run test:e2e` (sets PI_BOOST_E2E=1)";
const termsSkip =
	skip ||
	(hermetic && !hermetic.termsAvailable && !termsStrict ? (hermetic.termsMissingReason ?? true) : false);
const line: PiLine = installedPiLine();
const mcpSkip = skip || (line !== "1.2" ? "pi ≥ 0.99 only: 0.86 has no built-in MCP" : false);

const h = (): Hermetic => {
	if (!hermetic) throw new Error("session e2e: the hermetic harness is not set up (PI_BOOST_E2E is not 1)");
	return hermetic;
};

// pi's SDK and pi-ai, reached structurally: the two pi lines type them
// differently, and this suite typechecks against either.

interface Block {
	type: string;
	text?: string;
}
interface Message {
	role: string;
	toolName?: string;
	content: Block[] | string;
	isError?: boolean;
	details?: { jfrogBoost?: Record<string, unknown> } & Record<string, unknown>;
	structuredContent?: unknown;
}
interface Session {
	readonly messages: Message[];
	prompt(text: string): Promise<void>;
	bindExtensions?(bindings: object): Promise<void>;
	getAllTools?(): { name: string }[];
	readonly extensionRunner?: {
		hasHandlers(event: string): boolean;
		emit(event: object): Promise<unknown>;
	};
	dispose(): void;
}
type Step = unknown;
interface Faux {
	provider: unknown;
	getModel(): unknown;
	setResponses(steps: Step[]): void;
}
interface PiAi {
	fauxProvider(options: object): Faux;
	fauxAssistantMessage(content: unknown, options?: object): Step;
	fauxToolCall(name: string, args: Record<string, unknown>): unknown;
}
interface PiSdk {
	ModelRuntime: {
		create(options: object): Promise<{
			registerNativeProvider(provider: unknown): void;
			setRuntimeApiKey(provider: string, key: string): Promise<void> | void;
		}>;
	};
	SettingsManager: { inMemory(settings: object): unknown };
	SessionManager: { inMemory(cwd: string): unknown };
	DefaultResourceLoader: new (options: object) => { reload(): Promise<void> };
	createAgentSession(options: object): Promise<{
		session: Session;
		extensionsResult: { errors: { path?: string; error: string }[] };
	}>;
}

let sdk: PiSdk;
let ai: PiAi;
/** pi's built-in extensions (MCP, codemode, tool_search), which the CLI adds and the SDK does not. */
let builtins: unknown[] = [];
let dir = "";
let agentDir = "";
let restoreEnv: (() => void) | undefined;
const sessions: Session[] = [];

before(async () => {
	if (!hermetic) return;
	if (!hermetic.binary) assert.fail("PI_BOOST_E2E=1 but no Boost binary was found (set BOOST_BIN)");
	if (!hermetic.termsAvailable && termsStrict)
		assert.fail(
			strict ? `PI_BOOST_E2E_STRICT=1: ${hermetic.termsMissingReason}` : hermetic.termsMissingReason,
		);
	restoreEnv = hermetic.apply();
	hermetic.assertIsolated();

	// pi-ai is pi-coding-agent's dependency, not this package's: take the
	// copy the installed pi uses (nested under it when the versions differ).
	const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const piRoot = dirname(dirname(piMain));
	sdk = (await import(pathToFileURL(piMain).href)) as PiSdk;
	const nestedAi = join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
	const aiEntry = existsSync(nestedAi)
		? nestedAi
		: fileURLToPath(import.meta.resolve("@earendil-works/pi-ai", pathToFileURL(piMain).href));
	ai = (await import(pathToFileURL(aiEntry).href)) as PiAi;
	const builtinsEntry = join(piRoot, "dist", "extensions", "index.js");
	if (existsSync(builtinsEntry)) {
		builtins =
			((await import(pathToFileURL(builtinsEntry).href)) as { builtInExtensions?: unknown[] })
				.builtInExtensions ?? [];
	}

	agentDir = process.env.PI_CODING_AGENT_DIR ?? join(hermetic.home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	dir = join(hermetic.home, "work");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "tap.test.mjs"),
		[
			`import { test } from "node:test";`,
			`import assert from "node:assert/strict";`,
			`for (let i = 0; i < ${PASSING}; i++) test(\`case \${i} passes\`, () => {});`,
			`for (let i = 0; i < ${FAILING}; i++) test(\`case \${i} fails\`, () => assert.equal(i, 42));`,
		].join("\n"),
	);
	writeFileSync(join(dir, "index.ts"), "export const answer = 42;\n");
	copyFileSync(join(import.meta.dirname, "fixtures", "sample.docx"), join(dir, "sample.docx"));
});

/**
 * End a session the way pi's CLI does on quit: `session_shutdown` first, so
 * the extension saves its stats and kills its children and pi's MCP client
 * closes the stub servers, then dispose. `dispose` alone leaves both running.
 */
async function close(session: Session) {
	const runner = session.extensionRunner;
	try {
		if (runner?.hasHandlers("session_shutdown"))
			await runner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}

const closeAll = () => Promise.all(sessions.splice(0).map(close));

after(async () => {
	await closeAll();
	restoreEnv?.();
	hermetic?.dispose();
});

type Exposure = "direct" | "deferred" | "codemode";

/**
 * A real session on the faux model, with this extension loaded from
 * src/index.ts. `mcp` writes pi's mcp.json first: a `slack` server and a
 * `slackbig` one whose result pi truncates, both with that exposure.
 */
async function startSession(mcp?: Exposure) {
	// One MCP session at a time, so earlier sessions' stub servers are gone.
	if (mcp) await closeAll();
	const servers = mcp
		? {
				slack: { command: process.execPath, args: [MCP_SERVER], exposure: mcp },
				slackbig: { command: process.execPath, args: [MCP_SERVER, "--big"], exposure: mcp },
			}
		: {};
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));

	const faux = ai.fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 8_000 }],
	});
	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey("faux", "faux");
	const settingsManager = sdk.SettingsManager.inMemory({});
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: dir,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [EXTENSION],
		extensionFactories: builtins,
	});
	await resourceLoader.reload();
	const { session, extensionsResult } = await sdk.createAgentSession({
		cwd: dir,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(dir),
		settingsManager,
	});
	sessions.push(session);
	assert.deepEqual(extensionsResult.errors, [], "pi loaded the extension without errors");
	await session.bindExtensions?.({});

	/** The serialized context of each model call in the last `run`. */
	let contexts: string[] = [];
	const record = (context: unknown) => {
		contexts.push(JSON.stringify(context));
	};

	/**
	 * One prompt: the model calls each tool in turn, then stops. Returns the
	 * tool results the session recorded for it, and what the model was sent
	 * before each call.
	 */
	const run = async (calls: [string, Record<string, unknown>][]) => {
		contexts = [];
		const before = session.messages.length;
		faux.setResponses([
			...calls.map(([name, args]) => (context: unknown) => {
				record(context);
				return ai.fauxAssistantMessage(ai.fauxToolCall(name, args), { stopReason: "toolUse" });
			}),
			(context: unknown) => {
				record(context);
				return ai.fauxAssistantMessage("done");
			},
		]);
		await session.prompt("go");
		const results = session.messages.slice(before).filter((m) => m.role === "toolResult");
		assert.equal(results.length, calls.length, "one tool result per scripted call");
		return { results, contexts: [...contexts] };
	};

	// Boost's readiness is probed in the background; the awareness section
	// appears once Boost is ready (shell filtering is on in the hermetic
	// config), so wait for it the way a user's next prompt would see it.
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		const { contexts: sent } = await run([]);
		if (sent.some((c) => awareness(c) !== undefined)) break;
		if (Date.now() > deadline)
			assert.fail("the extension's awareness section never appeared: Boost not ready");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return { session, run };
}

/** The last `<jfrog-boost>` section in a serialized context, if any. */
function awareness(context: string): string | undefined {
	const start = context.lastIndexOf("<jfrog-boost>");
	if (start < 0) return undefined;
	const end = context.indexOf("</jfrog-boost>", start);
	return context.slice(start, end < 0 ? undefined : end);
}

const textOf = (message: Message): string =>
	typeof message.content === "string"
		? message.content
		: message.content
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
const passLines = (text: string) =>
	text.split("\n").filter((l) => /^\s*ok \d+ - case \d+ passes/.test(l)).length;

let plain: Awaited<ReturnType<typeof startSession>> | undefined;
const plainSession = async () => {
	plain ??= await startSession();
	return plain;
};

test("the session runs in a throwaway HOME, never the real one", { skip }, () => {
	h().assertIsolated();
	assert.equal(process.env.BOOST_DB_PATH, join(h().home, "history.db"));
	assert.ok(agentDir.startsWith(h().home), agentDir);
});

test("pi's runner loads the extension, and the model is told what Boost shortens", { skip }, async () => {
	const { run } = await plainSession();
	const { contexts } = await run([["read", { path: "index.ts" }]]);
	const section = awareness(contexts[0] ?? "");
	assert.ok(section, "the <jfrog-boost> section reached the model");
	assert.match(section, /`bash` output/);
	assert.match(section, /DISABLE_BOOST=1/);
});

test("a failing TAP run through pi's bash is compacted, keeps its failures, and is marked", {
	skip,
}, async () => {
	const { run } = await plainSession();
	const {
		results: [tap],
	} = await run([["bash", { command: TAP }]]);
	assert.ok(tap);
	const text = textOf(tap);
	// node --test exits 1 on failures: pi 1.x returns that as an error result,
	// 0.86 throws and the runner records the same.
	assert.equal(tap.isError, true);
	assert.match(text, MARKER, "compacted output carries a retrieve marker");
	assert.match(text, /not ok \d+ - case \d+ fails/, "the failures survive compaction");
	assert.ok(passLines(text) < PASSING, `${passLines(text)} passing lines left`);
	const jb = tap.details?.jfrogBoost;
	assert.equal(jb?.kind, "compacted");
	assert.ok((jb?.after as number) < (jb?.before as number), JSON.stringify(jb));
});

test("a failing command stays an error with pi's exit notice, compacted", { skip }, async () => {
	const { run } = await plainSession();
	const {
		results: [failed],
	} = await run([["bash", { command: `${TAP}; exit 3` }]]);
	assert.ok(failed);
	assert.equal(failed.isError, true);
	assert.match(textOf(failed), /\n\nCommand exited with code 3$/);
	assert.match(textOf(failed), MARKER);
	assert.equal(failed.details?.jfrogBoost?.kind, "compacted");
});

test("DISABLE_BOOST=1 returns the command's output untouched", { skip }, async () => {
	const { run } = await plainSession();
	const {
		results: [exact],
	} = await run([["bash", { command: `DISABLE_BOOST=1 ${TAP}` }]]);
	assert.ok(exact);
	assert.equal(passLines(textOf(exact)), PASSING);
	assert.doesNotMatch(textOf(exact), MARKER);
	assert.equal(exact.details?.jfrogBoost, undefined);
});

test("a text file read is exact; a .docx read is converted", { skip: termsSkip }, async () => {
	const { run } = await plainSession();
	const {
		results: [source, doc],
	} = await run([
		["read", { path: "index.ts" }],
		["read", { path: "sample.docx" }],
	]);
	assert.ok(source && doc);
	assert.equal(textOf(source), "export const answer = 42;\n");
	assert.equal(source.details?.jfrogBoost, undefined);
	assert.equal(doc.isError, false);
	assert.match(
		textOf(doc),
		/^\[Converted from sample\.docx by JFrog Boost\. Line numbers refer to this text, not the file\.\]\n/,
	);
	assert.match(textOf(doc), /Hello from the sample docx/);
	assert.deepEqual([doc.details?.jfrogBoost?.kind, doc.details?.jfrogBoost?.ext], ["converted", ".docx"]);
});

// ---------------------------------------------------------------------------
// MCP, through pi's built-in MCP client (pi ≥ 0.99)

const SLACK = "mcp__slack__slack_get_users";
const SLACK_BIG = "mcp__slackbig__slack_get_users";

/** Wait until pi has connected the stub servers and registered their tools. */
async function waitForTools(session: Session, names: string[]) {
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		const have = new Set((session.getAllTools?.() ?? []).map((t) => t.name));
		if (names.every((n) => have.has(n))) return;
		if (Date.now() > deadline) assert.fail(`pi never registered ${names.join(", ")}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function assertMcpCompacted(result: Message | undefined, full = false) {
	assert.ok(result);
	const text = textOf(result);
	assert.equal(result.isError, false, text.slice(0, 200));
	const jb = result.details?.jfrogBoost;
	assert.match(
		text,
		MARKER,
		`${result.toolName}: no retrieve marker (details.jfrogBoost: ${JSON.stringify(jb)})`,
	);
	assert.equal(jb?.kind, "mcp", JSON.stringify(jb));
	assert.equal(String(jb?.retrieveId), MARKER.exec(text)?.[1]);
	if (full) {
		assert.equal(jb?.full, true, "re-filtered from pi's full-output file");
		assert.doesNotMatch(text, /chars truncated/, "built from the whole output, not pi's cut");
	}
}

test("direct MCP tools are compacted, including a result pi truncated", { skip: mcpSkip }, async () => {
	const { session, run } = await startSession("direct");
	await waitForTools(session, [SLACK, SLACK_BIG]);
	const { results, contexts } = await run([
		[SLACK, { limit: 16 }],
		[SLACK_BIG, { limit: 64 }],
	]);
	assertMcpCompacted(results[0]);
	assertMcpCompacted(results[1], true);
	assert.match(awareness(contexts[0] ?? "") ?? "", /MCP tool results/);
});

test("a deferred MCP tool is compacted, and awareness names MCP in the prompt that loads it", {
	skip: mcpSkip,
}, async () => {
	const { session, run } = await startSession("deferred");
	await waitForTools(session, [SLACK]);
	const { results, contexts } = await run([
		["tool_search", { query: "slack users" }],
		[SLACK, { limit: 16 }],
	]);
	assert.equal(results[0]?.toolName, "tool_search");
	assertMcpCompacted(results[1]);
	// Before tool_search ran, the MCP tool was not in the loadout yet.
	assert.match(awareness(contexts[0] ?? "") ?? "", /MCP tool results/);
});

test("under codemode exposure the nested MCP call is left alone", { skip: mcpSkip }, async () => {
	const { session, run } = await startSession("codemode");
	await waitForTools(session, [SLACK]);
	const {
		results: [script],
	} = await run([
		["codemode", { code: `const r = await tools.${SLACK}({ limit: 16 });\nreturn r.content[0].text;` }],
	]);
	assert.ok(script);
	const text = textOf(script);
	assert.match(text, /^Script completed/, text.slice(0, 300));
	assert.doesNotMatch(text, MARKER, "the script got pi's result, not Boost's");
	assert.match(text, /"real_name"/, "the Slack payload came back whole");
	assert.equal(script.details?.jfrogBoost, undefined);
});

// Last on purpose: top-level tests run in order, so this sees every spawn above.
test("the real Boost config and history were not touched", { skip }, async (t) => {
	await closeAll();
	for (const path of h().tripwire.paths) t.diagnostic(`tripwire watched ${path}`);
	h().tripwire.assertUnchanged();
});
