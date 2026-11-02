/**
 * The MCP route (spec §7.2): the `mcpExclude` matcher, the hook payload, the
 * reply, the replacement, pi's own 20 KiB truncation, and the wiring through
 * the extension — against stand-ins. The real Boost is exercised by e2e
 * case 11.
 */
import "./helpers/spawn-spy.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import {
	type BoostCall,
	type BoostClient,
	createBoostClient,
	FILTER_STDOUT_CAP,
	filterTimeoutMs,
} from "../src/boost-client.ts";
import type { ProcessRunner, RunResult } from "../src/boost-process.ts";
import type { ContentBlock } from "../src/content.ts";
import { createCounters, type ReadinessState } from "../src/health.ts";
import { createBoostExtension } from "../src/index.ts";
import {
	buildMcpPayload,
	compactMcpResult,
	MCP_MAX_BYTES,
	type McpGateInput,
	type McpRequest,
	mcpSkip,
	PI_MCP_OUTPUT_FILE,
	PI_MCP_OUTPUT_MAX_BYTES,
	parseMcpReply,
	piTruncatedPath,
} from "../src/mcp.ts";
import { excludedBy, globMatches } from "../src/settings.ts";
import { readPiTempFile } from "../src/shell.ts";
import { type Block, createPiStub, type PiLine, toolResultEvent } from "./helpers/harness.ts";
import { call, fixedConfig, fixedReadiness, memorySettings, stubClient } from "./helpers/runtime.ts";
import { removeTempDir } from "./helpers/tmp.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const FAKE = join(FIXTURES, "fake-boost.mjs");

interface Fixture {
	toolName: string;
	input: Record<string, unknown>;
	content: Block[];
	details: unknown;
	structuredContent: unknown;
}

const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Fixture;
const SLACK = fixture("mcp-slack.json");
const SNAPSHOT = fixture("mcp-snapshot.json");

const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-mcp-"));
after(() => removeTempDir(root));

const MARKER = "[Boost compressed ~70%. Get the full original output simply with: boost retrieve 42]";
const BIG = Array.from(
	{ length: 200 },
	(_, i) => `{"id":${i},"name":"user ${i}","avatar":"https://x/${i}.png"}`,
).join("\n");
const SHORT = `${BIG.slice(0, 1000)}\n${MARKER}`;

/** What `boost hook claude` prints for a filtered MCP result. */
const hookReply = (fields: Record<string, unknown>) =>
	`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", ...fields } })}\n`;
const both = (text: string) => hookReply({ updatedToolOutput: text, updatedMCPToolOutput: text });

// ---------------------------------------------------------------------------
// mcpExclude

test("mcpExclude globs: `*` is any run, everything else literal, the whole name must match", () => {
	assert.equal(globMatches("mcp__secrets__*", "mcp__secrets__get"), true);
	assert.equal(globMatches("mcp__secrets__*", "mcp__secrets__"), true);
	assert.equal(globMatches("mcp__secrets__*", "mcp__secretsx__get"), false);
	assert.equal(globMatches("mcp__secrets__*", "xmcp__secrets__get"), false);
	assert.equal(globMatches("*__delete_*", "mcp__github__delete_repo"), true);
	assert.equal(globMatches("*__delete_*", "mcp__github__list_repos"), false);
	assert.equal(globMatches("mcp__*__*_secret", "mcp__vault__read_secret"), true);
	assert.equal(globMatches("mcp__*__*_secret", "mcp__vault__read_secrets"), false);
	assert.equal(globMatches("*", "anything"), true);
	assert.equal(globMatches("mcp__gh__dump", "mcp__gh__dump"), true);
	assert.equal(globMatches("mcp__gh__dump", "mcp__gh__dump2"), false);
	// Not a regex, not case-insensitive, no `?`.
	assert.equal(globMatches("mcp__.*", "mcp__slack__x"), false);
	assert.equal(globMatches("MCP__*", "mcp__slack__x"), false);
	assert.equal(globMatches("mcp__slack__?", "mcp__slack__x"), false);
	// The fixed ends may not overlap.
	assert.equal(globMatches("ab*ba", "aba"), false);
	assert.equal(globMatches("a*b*c", "a_c_b"), false);
	assert.equal(excludedBy("mcp__slack__x", ["mcp__github__*", " mcp__slack__* "]), " mcp__slack__* ");
	assert.equal(excludedBy("mcp__slack__x", []), undefined);
	// pi 1.2.0 turns everything outside [A-Za-z0-9_] in a tool name into "_";
	// a pattern written with the server's configured name is read the same
	// way, and reported as the user wrote it.
	assert.equal(excludedBy("mcp__my_secrets__get", ["mcp__my-secrets__*"]), "mcp__my-secrets__*");
	assert.equal(excludedBy("mcp__acme_slack__post", ["mcp__acme.slack__*"]), "mcp__acme.slack__*");
	assert.equal(excludedBy("mcp__acme_slack__post", ["mcp__acme slack__*"]), "mcp__acme slack__*");
	assert.equal(excludedBy("mcp__my_secrets__get", ["mcp__my-secret__*"]), undefined);
	// Extension-registered tools (all of them on pi 0.86) need not sanitize:
	// a name that keeps its "-" or "." must still match a pattern spelled the
	// same way, or the exact name, or the sanitized spelling.
	assert.equal(excludedBy("mcp__my-secrets__get", ["mcp__my-secrets__*"]), "mcp__my-secrets__*");
	assert.equal(excludedBy("mcp__a.b__get", ["mcp__a.b__*"]), "mcp__a.b__*");
	assert.equal(excludedBy("mcp__my-secrets__get", ["mcp__my-secrets__get"]), "mcp__my-secrets__get");
	assert.equal(excludedBy("mcp__my-secrets__get", ["mcp__my_secrets__*"]), "mcp__my_secrets__*");
	assert.equal(excludedBy("mcp__my-secrets__get", ["mcp__my-secret__*"]), undefined);
	assert.equal(excludedBy("mcp__my-secrets__get", ["mcp__other__*"]), undefined);
	// Normalising never widens a pattern past `*`.
	assert.equal(excludedBy("mcp__slack__x", ["mcp__slack__?"]), undefined);
	assert.equal(excludedBy("mcp__slack__x", ["mcp__.*"]), undefined);
});

// ---------------------------------------------------------------------------
// Payload and reply

test("the payload has exactly Claude Code's PostToolUse shape, with text blocks only", () => {
	const payload = JSON.parse(
		buildMcpPayload({
			sessionId: "sess-1",
			cwd: "/work",
			toolName: "mcp__slack__slack_get_users",
			toolInput: { limit: 16 },
			toolUseId: "call-7",
			texts: ["one", "two"],
		}),
	);
	assert.deepEqual(Object.keys(payload), [
		"session_id",
		"transcript_path",
		"cwd",
		"hook_event_name",
		"tool_name",
		"tool_input",
		"tool_response",
		"tool_use_id",
	]);
	assert.deepEqual(payload, {
		session_id: "sess-1",
		transcript_path: "",
		cwd: "/work",
		hook_event_name: "PostToolUse",
		tool_name: "mcp__slack__slack_get_users",
		tool_input: { limit: 16 },
		tool_response: {
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
		},
		tool_use_id: "call-7",
	});
});

test("the reply: updatedMCPToolOutput first, then updatedToolOutput, and only a string", () => {
	assert.equal(
		parseMcpReply(hookReply({ updatedMCPToolOutput: "mcp", updatedToolOutput: "generic" })),
		"mcp",
	);
	assert.equal(parseMcpReply(hookReply({ updatedToolOutput: "generic" })), "generic");
	assert.equal(parseMcpReply(""), undefined);
	assert.equal(parseMcpReply("  \n"), undefined);
	assert.equal(parseMcpReply("not json"), undefined);
	assert.equal(parseMcpReply('{"hookSpecificOutput":'), undefined);
	assert.equal(parseMcpReply("[]"), undefined);
	assert.equal(parseMcpReply("{}"), undefined);
	assert.equal(parseMcpReply('{"hookSpecificOutput":"x"}'), undefined);
	assert.equal(parseMcpReply(hookReply({ updatedMCPToolOutput: { content: [] } })), undefined);
	assert.equal(parseMcpReply(hookReply({ updatedMCPToolOutput: 42, updatedToolOutput: "x" })), undefined);
	assert.equal(parseMcpReply(hookReply({ updatedMCPToolOutput: null, updatedToolOutput: "x" })), "x");
});

// ---------------------------------------------------------------------------
// compactMcpResult

const request = (over: Partial<McpRequest> = {}): McpRequest => ({
	toolName: "mcp__slack__slack_get_users",
	toolInput: { limit: 200 },
	toolUseId: "call-1",
	sessionId: "sess-1",
	cwd: "/work",
	content: [{ type: "text", text: BIG }] as ContentBlock[],
	details: { server: "slack", tool: "slack_get_users" },
	...over,
});

/** A hook that answers `stdout` and records each payload it was handed. */
function hook(stdout: string, code: number | null = 0) {
	const payloads: Record<string, unknown>[] = [];
	const fn = async (payload: string): Promise<BoostCall> => {
		payloads.push(JSON.parse(payload) as Record<string, unknown>);
		return call(stdout, code);
	};
	return Object.assign(fn, { payloads });
}

test("images, resources and structured content never reach Boost; text blocks go in order", async () => {
	const h = hook(both(SHORT));
	const content = [
		{ type: "text", text: BIG.slice(0, 3000) },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
		{ type: "text", text: BIG.slice(3000), annotations: { audience: ["user"] } },
	] as unknown as ContentBlock[];
	await compactMcpResult(request({ content }), h);
	const sent = h.payloads[0] as { tool_response: unknown };
	assert.deepEqual(sent.tool_response, {
		content: [
			{ type: "text", text: BIG.slice(0, 3000) },
			{ type: "text", text: BIG.slice(3000) },
		],
	});
	const raw = JSON.stringify(sent);
	assert.doesNotMatch(raw, /AAAA|image|structuredContent|isError|annotations/);
});

test("a meaningful reply becomes the text, with its retrieve id", async () => {
	const outcome = await compactMcpResult(request(), hook(both(`${SHORT}\n`)));
	assert.deepEqual(outcome.compaction, {
		text: SHORT,
		before: BIG.length,
		after: SHORT.length,
		retrieveId: 42,
	});
});

test("updatedMCPToolOutput wins over a different updatedToolOutput", async () => {
	const outcome = await compactMcpResult(
		request(),
		hook(hookReply({ updatedMCPToolOutput: SHORT, updatedToolOutput: "generic" })),
	);
	assert.equal(outcome.compaction?.text, SHORT);
});

test("empty output, invalid JSON, a non-string reply, an error exit or a refusal keep the original", async () => {
	for (const [label, stdout, code] of [
		["empty", "", 0],
		["invalid JSON", "{oops", 0],
		["non-string", hookReply({ updatedMCPToolOutput: { content: [{ type: "text", text: "x" }] } }), 0],
		["exit 1", both(SHORT), 1],
		["killed", both(SHORT), null],
	] as const) {
		const outcome = await compactMcpResult(request(), hook(stdout, code));
		assert.equal(outcome.compaction, undefined, label);
		assert.ok(outcome.call, label);
	}
	const refused = await compactMcpResult(request(), async () => ({
		...call(""),
		code: null,
		skipped: "busy",
	}));
	assert.equal(refused.compaction, undefined);
});

test("a generic same-size reply, or a whitespace-only change, is not applied", async () => {
	// What Boost answers for a tool it has no filter for: the joined text, as is.
	for (const reply of [BIG, `${BIG}\n\n`, BIG.slice(0, BIG.length - 100), ""]) {
		const outcome = await compactMcpResult(request(), hook(both(reply)));
		assert.equal(outcome.compaction, undefined, `${reply.length} chars`);
	}
	// Two blocks: the reply is compared with their "\n"-joined text.
	const halves = [BIG.slice(0, 5000), BIG.slice(5000)];
	const content = halves.map((text) => ({ type: "text", text })) as ContentBlock[];
	const joined = await compactMcpResult(request({ content }), hook(both(halves.join("\n"))));
	assert.equal(joined.compaction, undefined);
});

// ---------------------------------------------------------------------------
// pi's own truncation (pi 1.x `limitMcpContent`)

/** The text pi 1.2.0 hands on for an MCP result over 20 KiB (format copied from its bundle). */
function piTruncated(full: string, where: string): string {
	const half = PI_MCP_OUTPUT_MAX_BYTES / 2;
	const removed = full.length - 2 * half;
	return `Warning: truncated output (original token count: ${Math.ceil(Buffer.byteLength(full) / 4)})\nTotal output lines: ${full.split("\n").length}\n\n${full.slice(0, half)}…${removed} chars truncated…${full.slice(-half)}\n\n${where}`;
}

function truncatedRequest(full: string, path: string | undefined): McpRequest {
	return request({
		content: [
			{ type: "text", text: piTruncated(full, `[Full output: ${path} (read it with offset/limit)]`) },
		],
		details: { server: "slack", tool: "slack_get_users", ...(path ? { fullOutputPath: path } : {}) },
	});
}

/** A full-output file name as pi 1.2.0 makes it (`pi-mcp-<8 random bytes, hex>.txt`). */
const piName = () => `pi-mcp-${randomBytes(8).toString("hex")}.txt`;

const HUGE = Array.from({ length: 2000 }, (_, i) => `{"id":${i},"avatar":"https://x/${i}.png"}`).join("\n");

test("a result pi truncated is recognised by its header, with or without a path", () => {
	assert.equal(piTruncatedPath(BIG, {}), undefined);
	assert.equal(
		piTruncatedPath(piTruncated(HUGE, "[x]"), { fullOutputPath: "/tmp/pi-mcp-1.txt" }),
		"/tmp/pi-mcp-1.txt",
	);
	assert.equal(piTruncatedPath(piTruncated(HUGE, "[Could not save the full output: EACCES]"), {}), null);
	// The header must open the text: a server that prints those words is not pi.
	assert.equal(piTruncatedPath(`log\nWarning: truncated output (original token count: 3)\n`, {}), undefined);
});

test("pi's full-output file is re-filtered, and the reply carries the file's path", async () => {
	const tmp = mkdtempSync(join(root, "tmp-"));
	const path = join(tmp, piName());
	writeFileSync(path, HUGE);
	const h = hook(both(SHORT));
	const outcome = await compactMcpResult(truncatedRequest(HUGE, path), h, { tmpdir: () => tmp });
	assert.deepEqual((h.payloads[0] as { tool_response: unknown }).tool_response, {
		content: [{ type: "text", text: HUGE }],
	});
	const text = `${SHORT}\n\n[Boost compacted the full 2000-line output. Full output: ${path} (read it with offset/limit)]`;
	assert.deepEqual(outcome.compaction, {
		text,
		before: piTruncated(HUGE, `[Full output: ${path} (read it with offset/limit)]`).length,
		after: text.length,
		retrieveId: 42,
		full: true,
	});
});

test("a reply over pi's 20 KiB cap keeps pi's truncated text, and says so", async () => {
	const tmp = mkdtempSync(join(root, "tmp-"));
	const path = join(tmp, piName());
	writeFileSync(path, HUGE);
	const tooBig = `${HUGE.slice(0, PI_MCP_OUTPUT_MAX_BYTES + 1)}\n${MARKER}`;
	const outcome = await compactMcpResult(truncatedRequest(HUGE, path), hook(both(tooBig)), {
		tmpdir: () => tmp,
	});
	assert.equal(outcome.compaction, undefined);
	assert.ok(outcome.call);
	// Boost ran and answered; pi's truncation is why the answer is unused.
	assert.equal(outcome.skipped, "truncated");
});

test("no usable full-output file: nothing is sent, pi's truncated text stands", async () => {
	const tmp = mkdtempSync(join(root, "tmp-"));
	const outside = mkdtempSync(join(root, "elsewhere-"));
	const elsewhere = join(outside, piName());
	writeFileSync(elsewhere, HUGE);
	const big = join(tmp, piName());
	writeFileSync(big, "x".repeat(1024 * 1024 + 1));
	const dir = join(tmp, piName());
	mkdirSync(dir);
	for (const [label, path] of [
		["outside the temp dir", elsewhere],
		["missing", join(tmp, "gone.txt")],
		["over 1 MiB", big],
		["a directory", dir],
		["no path", undefined],
	] as const) {
		const h = hook(both(SHORT));
		const outcome = await compactMcpResult(truncatedRequest(HUGE, path), h, { tmpdir: () => tmp });
		assert.deepEqual(outcome, { skipped: "truncated" }, label);
		assert.equal(h.payloads.length, 0, label);
	}
	assert.equal(await readMcpFile(elsewhere, { tmpdir: () => tmp }), undefined);
	assert.equal(await readMcpFile(`${tmp}-sibling/x`, { tmpdir: () => tmp }), undefined);
});

test("only a file named and owned the way pi writes it is read", async () => {
	const tmp = mkdtempSync(join(root, "tmp-"));
	const good = join(tmp, piName());
	writeFileSync(good, HUGE);
	assert.equal(await readMcpFile(good, { tmpdir: () => tmp }), HUGE);
	// Another program's temp file, though inside the temp dir and readable:
	// any `mcp__*` tool can name a path in `details`.
	for (const name of [
		"notes.txt",
		"pi-mcp-0123.txt",
		"pi-mcp-0123456789abcdef.json",
		"pi-mcp-0123456789ABCDEF.txt",
		"pi-bash-0123456789abcdef.txt",
		"xpi-mcp-0123456789abcdef.txt",
	]) {
		const path = join(tmp, name);
		writeFileSync(path, HUGE);
		assert.equal(await readMcpFile(path, { tmpdir: () => tmp }), undefined, name);
		const h = hook(both(SHORT));
		const outcome = await compactMcpResult(truncatedRequest(HUGE, path), h, { tmpdir: () => tmp });
		assert.deepEqual(outcome, { skipped: "truncated" }, name);
		assert.equal(h.payloads.length, 0, name);
	}
	// A well-named file someone else owns (pi creates its own 0600).
	const theirs = { isFile: () => true, size: 10, uid: 4242 };
	const deps = { tmpdir: () => tmp, uid: () => 501, stat: () => theirs, readFile: async () => HUGE };
	assert.equal(await readMcpFile(good, deps), undefined);
	assert.equal(await readMcpFile(good, { ...deps, uid: () => 4242 }), HUGE);
	// No user ids (Windows): the name and place are what is checked.
	assert.equal(await readMcpFile(good, { ...deps, uid: () => undefined }), HUGE);
});

test("the MCP route reads under the shell route's guards: absolute paths, size re-checked after the read", async () => {
	const tmp = mkdtempSync(join(root, "tmp-"));
	const good = join(tmp, piName());
	writeFileSync(good, HUGE);
	// A relative spelling is never resolved against whatever the cwd is.
	const fromTmp = { tmpdir: () => tmp, realpath: (p: string) => realpathSync(join(tmp, p)) };
	assert.equal(await readMcpFile(basename(good), fromTmp), undefined);
	// A file that grew past the cap between the stat and the read.
	const grown = "x".repeat(MCP_MAX_BYTES + 1);
	const small = { isFile: () => true, size: 10 };
	assert.equal(
		await readMcpFile(good, { tmpdir: () => tmp, stat: () => small, readFile: async () => grown }),
		undefined,
	);
	const h = hook(both(SHORT));
	const outcome = await compactMcpResult(truncatedRequest(HUGE, good), h, {
		tmpdir: () => tmp,
		stat: () => small,
		readFile: async () => grown,
	});
	assert.deepEqual(outcome, { skipped: "truncated" });
	assert.equal(h.payloads.length, 0);
});

/** The guards the MCP route reads pi's full-output file under. */
function readMcpFile(path: string, deps: Parameters<typeof readPiTempFile>[2]) {
	return readPiTempFile(path, { maxBytes: MCP_MAX_BYTES, name: PI_MCP_OUTPUT_FILE }, deps);
}

// ---------------------------------------------------------------------------
// Through the extension

const CONFIG_MCP_OFF = `[feature_flags."boost-mcp-filtering"]\nuser = false\n`;

function extension(
	line: PiLine,
	options: {
		mcp?: BoostClient["mcp"];
		state?: ReadinessState;
		file?: Record<string, unknown>;
		config?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
) {
	const stub = createPiStub({ line });
	const calls: { payload: Record<string, unknown>; toolInput: unknown }[] = [];
	const counters = createCounters();
	const env = options.env ?? {};
	createBoostExtension(stub.pi, {
		client: stubClient({
			mcp:
				options.mcp ??
				(async (_meta, payload, callOptions) => {
					calls.push({ payload: JSON.parse(payload), toolInput: callOptions?.toolInput });
					return call(both(SHORT));
				}),
		}),
		env,
		settings: memorySettings({ env, ...(options.file ? { file: options.file } : {}) }),
		config: fixedConfig(options.config ?? ""),
		readiness: fixedReadiness(options.state),
		counters,
	});
	return { stub, calls, counters, start: () => stub.fire("session_start", { type: "session_start" }) };
}

const mcpEvent = (line: PiLine, f: Fixture, over: Record<string, unknown> = {}) =>
	toolResultEvent(line, {
		toolName: f.toolName,
		input: f.input,
		content: f.content,
		details: f.details,
		structuredContent: f.structuredContent,
		...over,
	});

test("an MCP result is compacted in place: images keep their position, structuredContent passes", async () => {
	const { stub, calls } = extension("1.2");
	const event = mcpEvent("1.2", SNAPSHOT);
	const patch = await stub.emitToolResult(event);
	assert.ok(patch);
	assert.deepEqual(patch.content, [{ type: "text", text: SHORT }, SNAPSHOT.content[1]]);
	assert.deepEqual(patch.structuredContent, SNAPSHOT.structuredContent);
	const text = (SNAPSHOT.content[0] as { text: string }).text;
	assert.deepEqual(patch.details, {
		server: "playwright",
		tool: "browser_snapshot",
		jfrogBoost: { kind: "mcp", before: text.length, after: SHORT.length, retrieveId: 42 },
	});
	// The payload: pi's name, input and call id, the text block only.
	assert.equal(calls.length, 1);
	const payload = calls[0]?.payload as Record<string, unknown>;
	assert.equal(payload.tool_name, "mcp__playwright__browser_snapshot");
	assert.equal(payload.tool_use_id, event.toolCallId);
	assert.equal(payload.session_id, "sess-1");
	assert.equal(payload.cwd, "/work");
	assert.equal(payload.transcript_path, "");
	assert.deepEqual(payload.tool_response, { content: [{ type: "text", text }] });
	assert.deepEqual(calls[0]?.toolInput, SNAPSHOT.input);
	assert.deepEqual(stub.errors, []);
});

test("an image before the text stays first; text blocks collapse into the first text position", async () => {
	const { stub } = extension("1.2");
	const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
	const content: Block[] = [
		image,
		{ type: "text", text: BIG.slice(0, 4000) },
		{ ...image, data: "BBBB" },
		{ type: "text", text: BIG.slice(4000) },
	];
	const patch = await stub.emitToolResult(toolResultEvent("1.2", { toolName: "mcp__x__y", content }));
	assert.deepEqual(patch?.content, [image, { type: "text", text: SHORT }, { ...image, data: "BBBB" }]);
});

test("on pi 0.86 (MCP from an extension) the same patch applies, without structuredContent", async () => {
	const { stub } = extension("0.86");
	const patch = await stub.emitToolResult(mcpEvent("0.86", SLACK));
	assert.deepEqual(patch?.content, [{ type: "text", text: SHORT }]);
	assert.equal(patch && "structuredContent" in patch, false);
});

test("a pattern naming a server as configured (`my-secrets`) excludes pi's `my_secrets` tools", async () => {
	const { stub, calls, counters, start } = extension("1.2", { file: { mcpExclude: ["mcp__my-secrets__*"] } });
	await start();
	const event = mcpEvent("1.2", SLACK, { toolName: "mcp__my_secrets__get_secret" });
	assert.equal(await stub.emitToolResult(event), undefined);
	assert.equal(calls.length, 0);
	assert.deepEqual(counters.skips(), { excluded: 1 });
});

test("nested, failed, small and excluded calls are never sent", async () => {
	const { stub, calls, counters, start } = extension("1.2", { file: { mcpExclude: ["mcp__slack__*"] } });
	await start();
	const cases = [
		mcpEvent("1.2", SNAPSHOT, { parentToolCallId: "parent-1" }),
		mcpEvent("1.2", SNAPSHOT, { isError: true }),
		mcpEvent("1.2", SNAPSHOT, { content: [{ type: "text", text: "x".repeat(2047) }] }),
		mcpEvent("1.2", SLACK),
		// Only images: no text to send.
		mcpEvent("1.2", SNAPSHOT, { content: [SNAPSHOT.content[1]] }),
	];
	for (const event of cases) assert.equal(await stub.emitToolResult(event), undefined);
	assert.equal(calls.length, 0);
	assert.deepEqual(counters.skips(), { nested: 1, error: 1, small: 1, excluded: 1, empty: 1 });
});

test("Boost 0.15.2, an explicit boost-mcp-filtering = false, mcp: false and PI_BOOST_MCP=0 skip", async () => {
	for (const [label, options, reason] of [
		["0.15.2", { state: { kind: "ready", version: [0, 15, 2] } }, "mcp-unsupported"],
		["flag false", { config: CONFIG_MCP_OFF }, "mcp-flag-off"],
		[
			"force-disabled",
			{ env: { BOOST_FEATURE_FLAGS_FORCE_DISABLED: "boost-mcp-filtering" } },
			"mcp-flag-off",
		],
		["setting", { file: { mcp: false } }, "mcp-off"],
		["env", { env: { PI_BOOST_MCP: "0" } }, "mcp-off"],
	] as const) {
		const { stub, calls, counters, start } = extension("1.2", options as Parameters<typeof extension>[1]);
		await start();
		assert.equal(await stub.emitToolResult(mcpEvent("1.2", SLACK)), undefined, label);
		assert.equal(calls.length, 0, label);
		assert.deepEqual(counters.skips(), { [reason]: 1 }, label);
	}
	// 0.15.3 and a remote `true` are enough.
	const ok = extension("1.2", {
		state: { kind: "ready", version: [0, 15, 3] },
		config: `[feature_flags."boost-mcp-filtering"]\nremote = true\n`,
	});
	assert.ok(await ok.stub.emitToolResult(mcpEvent("1.2", SLACK)));
});

test("a reply that is not a compaction leaves the result alone and is counted as unchanged", async () => {
	const text = (SLACK.content[0] as { text: string }).text;
	for (const stdout of ["", "garbage", both(text), hookReply({ updatedMCPToolOutput: 1 })]) {
		const { stub, counters } = extension("1.2", { mcp: async () => call(stdout) });
		assert.equal(await stub.emitToolResult(mcpEvent("1.2", SLACK)), undefined, stdout.slice(0, 20));
		assert.deepEqual(counters.skips(), { unchanged: 1 });
	}
	const { stub, counters } = extension("1.2", {
		mcp: async () => ({ ...call(""), timedOut: true, code: null }),
	});
	assert.equal(await stub.emitToolResult(mcpEvent("1.2", SLACK)), undefined);
	assert.deepEqual(counters.errors(), { timeout: 1 });
});

test("a non-zero exit is counted as `exit`, not lost and not `unchanged`", async () => {
	const { stub, counters } = extension("1.2", { mcp: async () => call(both(SHORT), 1) });
	assert.equal(await stub.emitToolResult(mcpEvent("1.2", SLACK)), undefined);
	assert.deepEqual(counters.skips(), { exit: 1 });
	assert.deepEqual(counters.errors(), {});
});

test("a full-output reply over pi's 20 KiB cap is counted as `truncated`, once", async () => {
	const path = join(root, piName());
	writeFileSync(path, HUGE);
	const tooBig = `${HUGE.slice(0, PI_MCP_OUTPUT_MAX_BYTES + 1)}\n${MARKER}`;
	const { stub, counters } = extension("1.2", { mcp: async () => call(both(tooBig)) });
	const req = truncatedRequest(HUGE, path);
	const event = mcpEvent("1.2", SLACK, { content: req.content, details: req.details });
	assert.equal(await stub.emitToolResult(event), undefined);
	assert.deepEqual(counters.skips(), { truncated: 1 });
});

test("text under the router's 1 MiB whose JSON payload is over it is not sent, and counted as large", async () => {
	// A quote doubles under JSON escaping: 600 KiB of text, 1.2 MiB of payload.
	const text = '"'.repeat(600 * 1024);
	assert.ok(Buffer.byteLength(text) < MCP_MAX_BYTES);
	const gate: McpGateInput = {
		toolName: "mcp__slack__x",
		isError: false,
		text,
		settings: { mcp: true, mcpExclude: [] },
		boostVersion: [0, 15, 4],
		mcpFlag: "unknown",
	};
	assert.equal(mcpSkip(gate), undefined, "the router routes it");
	const h = hook(both(SHORT));
	const outcome = await compactMcpResult(request({ content: [{ type: "text", text }] }), h);
	assert.deepEqual(outcome, { skipped: "large" });
	assert.equal(h.payloads.length, 0);
	// An ordinary payload goes through.
	const fits = await compactMcpResult(request({ content: [{ type: "text", text: BIG } as ContentBlock] }), h);
	assert.ok(fits.call);
	// Through the extension: one `large`, no spawn.
	const { stub, calls, counters } = extension("1.2");
	assert.equal(
		await stub.emitToolResult(mcpEvent("1.2", SLACK, { content: [{ type: "text", text }] })),
		undefined,
	);
	assert.equal(calls.length, 0);
	assert.deepEqual(counters.skips(), { large: 1 });
});

test("a throwing MCP call never reaches pi", async () => {
	const { stub } = extension("1.2", {
		mcp: async () => {
			throw new Error("boom");
		},
	});
	assert.equal(await stub.emitToolResult(mcpEvent("1.2", SLACK)), undefined);
	assert.deepEqual(stub.errors, []);
});

test("a kill switch flipped while Boost runs wins over its reply", async () => {
	const env: NodeJS.ProcessEnv = {};
	const { stub } = extension("1.2", {
		env,
		mcp: async () => {
			env.DISABLE_BOOST = "1";
			return call(both(SHORT));
		},
	});
	assert.equal(await stub.emitToolResult(mcpEvent("1.2", SLACK)), undefined);
});

// ---------------------------------------------------------------------------
// The real client, with the Node stand-in for Boost

test("the client runs `boost hook claude` with the payload on stdin and the hot-path env", async () => {
	const log = join(root, "hook.jsonl");
	const client = createBoostClient({
		env: {
			PATH: process.env.PATH ?? "",
			SYSTEMROOT: process.env.SYSTEMROOT,
			FAKE_BOOST_MODE: "hook-reply",
			FAKE_BOOST_REPLY: both(SHORT),
			FAKE_BOOST_LOG: log,
		},
		resolveBinary: () => FAKE,
		launcher: (exe) => ({ file: process.execPath, args: [exe] }),
		config: fixedConfig("").read,
	});
	const { stub } = createPiStubFor(client);
	const cwd = mkdtempSync(join(root, "cwd-"));
	const patch = await stub.emitToolResult(mcpEvent("1.2", SLACK), stub.ctx({ cwd }));
	assert.deepEqual(patch?.content, [{ type: "text", text: SHORT }]);
	const [only] = readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { argv: string[]; stdin: string; cwd: string; env: Record<string, string> });
	assert.deepEqual(only?.argv, ["hook", "claude"]);
	const payload = JSON.parse(only?.stdin ?? "{}");
	assert.equal(payload.tool_name, "mcp__slack__slack_get_users");
	assert.equal(payload.cwd, cwd);
	assert.equal(only?.env.BOOST_FEATURE_FLAGS_TTL, "24h");
	// No last_updated_at in this config: flag fetching is off for the call (F2).
	assert.equal(only?.env.BOOST_FEATURE_FLAGS_DISABLE, "1");
	assert.equal(JSON.parse(only?.env.BOOST_HOOK_META ?? "{}").agent_type, "pi");
	assert.equal(existsSync(join(cwd, ".boost")), false);
});

test("the hook gets the size-scaled filter timeout and the 2 MiB stdout cap (§8.5)", async () => {
	const seen: { args: readonly string[]; timeoutMs: number; maxStdout: number; input?: string }[] = [];
	const runner: ProcessRunner = {
		run: async (_exe, args, options): Promise<RunResult> => {
			seen.push({
				args,
				timeoutMs: options.timeoutMs,
				maxStdout: options.maxStdout,
				...(options.input !== undefined ? { input: options.input } : {}),
			});
			return call("");
		},
		detached: () => {},
		active: () => 0,
		killAll: () => {},
	};
	const client = createBoostClient({
		env: {},
		resolveBinary: () => "/fake/boost",
		runner,
		config: fixedConfig("").read,
	});
	const meta = { session_id: "s", cwd: root };
	for (const size of [10, 300 * 1024, 900 * 1024]) {
		const payload = JSON.stringify({ text: "x".repeat(size) });
		await client.mcp(meta, payload);
		const last = seen.at(-1);
		assert.deepEqual(last?.args, ["hook", "claude"]);
		assert.equal(last?.input, payload);
		assert.equal(last?.timeoutMs, filterTimeoutMs(Buffer.byteLength(payload)), `${size} B`);
		assert.equal(last?.maxStdout, FILTER_STDOUT_CAP);
	}
	// 3 s plus 4 ms per started KiB of payload. (The 10 s ceiling is past the
	// 1 MiB stdin limit for MCP, so a payload never reaches it.)
	assert.deepEqual(
		seen.map((s) => s.timeoutMs),
		[3_004, 4_204, 6_604],
	);
});

function createPiStubFor(client: BoostClient) {
	const stub = createPiStub({ line: "1.2" });
	createBoostExtension(stub.pi, {
		client,
		env: {},
		settings: memorySettings(),
		config: fixedConfig(""),
		readiness: fixedReadiness(),
	});
	return { stub };
}
