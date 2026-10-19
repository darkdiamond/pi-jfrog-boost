/**
 * The MCP route (spec §7.2): `mcp__*` tool results through Boost's MCP
 * filters, which only `boost hook claude` runs.
 *
 * Boost has per-server filters for MCP output (Slack user lists lose their
 * avatar URLs, GitHub listings their boilerplate) and a budget for browser
 * snapshots (a 209,690-byte Playwright snapshot came back as 3,939 bytes),
 * but none of them run on the stdin filter: they are reached only through
 * a PostToolUse hook payload in Claude Code's shape. So this route builds
 * that payload from pi's result and reads the hook's reply.
 *
 * What Boost reacts to was probed on v0.15.4 (Probe 2 §7, NP5, cmax-1):
 *
 *   - Only `tool_response: {content: [{type: "text", text}, …]}` fires a
 *     filter. A response carrying an image block, `structuredContent` or
 *     `isError`, a bare array or a string all get an empty reply. So only
 *     text blocks are sent, re-mapped to exactly `{type, text}`; images and
 *     `structuredContent` stay with pi and are put back untouched.
 *   - Filters match on the tool part of `mcp__<server>__<tool>`, so pi's tool
 *     names go as they are, with no server aliasing.
 *   - The reply is `hookSpecificOutput.updatedMCPToolOutput` (and the same
 *     string as `updatedToolOutput`): the text blocks joined with "\n" and
 *     filtered. A tool without a filter gets the joined text back at the same
 *     size (98,780 → 98,780 B), which is not a compaction and is not applied.
 *   - Nothing is written to the working directory, unlike the PreToolUse
 *     Bash hook's `.boost/hook-meta/` files.
 *
 * A call costs ~200 ms, so results under 2 KiB are not sent, and nothing over
 * 1 MiB (the stdin ceiling every route shares). That ceiling is on what goes
 * down the pipe, and here that is the JSON payload, not the text: escaping
 * alone grows JSON-heavy text by ~10% (1.10× on the Slack fixture), and the
 * envelope and `tool_input` add more. The router's gate on the text is the
 * cheap first cut; `compactMcpResult` measures the payload it built against
 * the same 1 MiB before calling Boost, so text just under the limit is
 * counted as `large` here rather than refused, less visibly, by the client.
 *
 * Privacy: Boost stores the full request and response of every MCP call it
 * filters in its local DB, and `boost sync` uploads them. `mcp: false` and
 * `mcpExclude` (e.g. `mcp__secrets__*`) are how the user keeps a server's
 * output away from Boost; the README and SECURITY say so.
 *
 * pi 1.x truncates an MCP tool's text to 20 KiB before any extension sees it
 * (`limitMcpContent` in pi's bundle: the middle is cut, a "Warning: truncated
 * output" header goes on top, and the whole text is saved to a temp file
 * named in a trailing `[Full output: …]` line and in `details.fullOutputPath`).
 * Sending that text would be worse than useless: the cut breaks the JSON
 * Boost's server filters parse, and a reply that dropped the trailing line
 * would lose the model its only way to the rest. So a truncated result is
 * re-read from pi's own full-output file, as the shell route does for bash
 * (§6.3), and replaced only when Boost's version of the whole output fits
 * within pi's 20 KiB; otherwise pi's truncated text stands.
 */
import { atLeast, type BoostVersion, MCP_MIN_VERSION } from "./boost-binary.ts";
import { type BoostCall, MAX_INPUT_BYTES } from "./boost-client.ts";
import {
	type ContentBlock,
	isMeaningfulReduction,
	isPlainObject,
	parseMarker,
	textBlocks,
} from "./content.ts";
import { excludedBy } from "./settings.ts";
import { type Compaction, type PiTempFileDeps, readPiTempFile } from "./shell.ts";

/** pi names every MCP tool `mcp__<server>__<tool>` (`createMcpToolName`). */
export const MCP_TOOL_PREFIX = "mcp__";
/** Below this, a ~200 ms hook call saves too little to be worth it (spec §8.5). */
export const MCP_MIN_BYTES = 2048;
/**
 * The largest payload sent (spec §8.5): the stdin ceiling the client enforces
 * on every route, so the two can never disagree.
 */
export const MCP_MAX_BYTES = MAX_INPUT_BYTES;
/**
 * pi's cap on an MCP tool's text: `MCP_OUTPUT_MAX_BYTES = 20*1024` in pi
 * 1.2.0's bundle. A reply built from the full output must fit in it, so the
 * model never gets more than pi itself would have given it.
 */
export const PI_MCP_OUTPUT_MAX_BYTES = 20 * 1024;
/** The first line of pi's truncated MCP output (pi 1.2.0 `limitMcpContent`). */
const PI_TRUNCATED = /^Warning: truncated output \(original token count: \d+\)\n/;
/**
 * The name pi gives an MCP full-output file: `pi-mcp-<8 random bytes as
 * hex>.txt` (pi 1.2.0 `saveToTempFile` → `utils/output-files.js`
 * `createOutputFilePath("pi-mcp", ".txt")`).
 */
export const PI_MCP_OUTPUT_FILE = /^pi-mcp-[0-9a-f]{16}\.txt$/;

export function isMcpTool(toolName: string): boolean {
	return toolName.startsWith(MCP_TOOL_PREFIX);
}

/** Why an `mcp__*` result is not sent to Boost. */
export type McpSkipReason =
	| "mcp-off"
	| "excluded"
	| "mcp-unsupported"
	| "mcp-flag-off"
	| "error"
	| "binary"
	| "small"
	| "large";

export interface McpGateInput {
	toolName: string;
	isError: boolean;
	/** The result's text blocks, joined with "\n". */
	text: string;
	settings: { mcp: boolean; mcpExclude: readonly string[] };
	/** The running Boost's version, when known. */
	boostVersion: BoostVersion | undefined;
	/** `boost-mcp-filtering` as resolved from env and config (boost-config.ts `resolveFlag`). */
	mcpFlag: boolean | "unknown";
}

/**
 * The router's MCP row (spec §5), for a tool already known to be `mcp__*`
 * and past the pre-checks. Pure: no spawn, no file access.
 */
export function mcpSkip(r: McpGateInput): McpSkipReason | undefined {
	if (!r.settings.mcp) return "mcp-off";
	if (excludedBy(r.toolName, r.settings.mcpExclude) !== undefined) return "excluded";
	// Boost answers an error response with nothing (Probe 2 §7), and an error
	// is the one message the model must read exactly as the server sent it.
	if (r.isError) return "error";
	// MCP filtering arrived in v0.15.3. Older releases accept `hook claude`
	// but have nothing to apply, so each call would be ~200 ms for nothing.
	if (!atLeast(r.boostVersion, MCP_MIN_VERSION)) return "mcp-unsupported";
	// Only an explicit false stops the call. Unknown means Boost's built-in
	// default (on in v0.15.x), which Boost applies itself.
	if (r.mcpFlag === false) return "mcp-flag-off";
	if (r.text.includes("\0")) return "binary";
	const bytes = Buffer.byteLength(r.text);
	if (bytes < MCP_MIN_BYTES) return "small";
	if (bytes > MCP_MAX_BYTES) return "large";
	return undefined;
}

// ---------------------------------------------------------------------------
// Payload and reply

export interface McpPayloadFields {
	sessionId: string;
	cwd: string;
	toolName: string;
	toolInput: unknown;
	toolUseId: string;
	texts: readonly string[];
}

/**
 * The PostToolUse payload `boost hook claude` reads on stdin, in Claude
 * Code's shape. `transcript_path` is empty: pi's session file is not a
 * Claude transcript, and Boost does not need one to filter. Only text goes
 * in `tool_response` — see the module comment for why an image block or
 * `structuredContent` there would make Boost answer with nothing.
 */
export function buildMcpPayload(f: McpPayloadFields): string {
	return JSON.stringify({
		session_id: f.sessionId,
		transcript_path: "",
		cwd: f.cwd,
		hook_event_name: "PostToolUse",
		tool_name: f.toolName,
		tool_input: f.toolInput ?? {},
		tool_response: { content: f.texts.map((text) => ({ type: "text", text })) },
		tool_use_id: f.toolUseId,
	});
}

/**
 * The replacement text from the hook's stdout, or undefined when there is
 * none to use: empty output (no filter fired), anything that is not JSON, or
 * a reply that is not a string. `updatedMCPToolOutput` is the field Claude
 * Code applies to MCP tools; `updatedToolOutput` carries the same string on
 * v0.15.4 and is read only when the first is absent.
 */
export function parseMcpReply(stdout: string): string | undefined {
	if (!stdout.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) return undefined;
	const hook = parsed.hookSpecificOutput;
	if (!isPlainObject(hook)) return undefined;
	const reply = hook.updatedMCPToolOutput ?? hook.updatedToolOutput;
	return typeof reply === "string" ? reply : undefined;
}

// ---------------------------------------------------------------------------
// pi's own truncation

/**
 * The full-output file pi saved for a truncated MCP result, or `null` when
 * the result was truncated but its file cannot be used, or undefined when
 * pi did not truncate the result at all.
 */
export function piTruncatedPath(text: string, details: unknown): string | null | undefined {
	if (!PI_TRUNCATED.test(text)) return undefined;
	const path = isPlainObject(details) ? details.fullOutputPath : undefined;
	return typeof path === "string" && path ? path : null;
}

// ---------------------------------------------------------------------------
// The route

export interface McpOutcome {
	call?: BoostCall;
	compaction?: Compaction;
	/**
	 * Why the result was left alone, when that was decided here rather than by
	 * the router or the client: `truncated` when pi's own truncated text
	 * stands (no usable full-output file, or Boost's version of it would not
	 * fit pi's cap), `large` when the payload is over the stdin ceiling.
	 * With `call` set, Boost did run; the caller counts this reason instead of
	 * "unchanged".
	 */
	skipped?: "truncated" | "large";
}

export interface McpRequest {
	toolName: string;
	toolInput: unknown;
	toolUseId: string;
	sessionId: string;
	cwd: string;
	content: readonly ContentBlock[];
	details: unknown;
}

/**
 * Send one routed `mcp__*` result to Boost and decide what, if anything,
 * replaces its text. `hook` runs `boost hook claude` with the payload on
 * stdin (boost-client.ts `mcp`). Never throws for Boost's sake: every way a
 * call can fail leaves the original result.
 */
export async function compactMcpResult(
	request: McpRequest,
	hook: (payload: string) => Promise<BoostCall>,
	deps: PiTempFileDeps = {},
): Promise<McpOutcome> {
	const texts = textBlocks(request.content);
	const shown = texts.join("\n");
	let sent = texts;
	let sentText = shown;
	const fullPath = piTruncatedPath(shown, request.details);
	if (fullPath === null) return { skipped: "truncated" };
	if (fullPath !== undefined) {
		// Only a file named the way pi names these (`pi-mcp-<16 hex>.txt`) and
		// within the 1 MiB every route is capped at; a pi release that names it
		// differently only costs the re-filter.
		const full = await readPiTempFile(fullPath, { maxBytes: MCP_MAX_BYTES, name: PI_MCP_OUTPUT_FILE }, deps);
		if (full === undefined || Buffer.byteLength(full) < MCP_MIN_BYTES) return { skipped: "truncated" };
		// pi saved the text blocks joined with "\n": one block says the same.
		sent = [full];
		sentText = full;
	}
	const payload = buildMcpPayload({
		sessionId: request.sessionId,
		cwd: request.cwd,
		toolName: request.toolName,
		toolInput: request.toolInput,
		toolUseId: request.toolUseId,
		texts: sent,
	});
	// The ceiling is on the payload (see the module comment): text the router
	// let through can still escape past it.
	if (Buffer.byteLength(payload) > MCP_MAX_BYTES) return { skipped: "large" };
	const call = await hook(payload);
	if (call.skipped || call.code !== 0) return { call };
	const reply = parseMcpReply(call.stdout);
	if (reply === undefined || !isMeaningfulReduction(sentText, reply)) return { call };
	const body = reply.trimEnd();
	const marker = parseMarker(body);
	let text = body;
	if (fullPath !== undefined) {
		// More than pi's own cap would hand the model more than pi meant it to
		// see; pi's truncated text, with its pointer to the file, stands.
		if (Buffer.byteLength(body) > PI_MCP_OUTPUT_MAX_BYTES) return { call, skipped: "truncated" };
		const lines = sentText.split("\n").length;
		text = `${body}\n\n[Boost compacted the full ${lines}-line output. Full output: ${fullPath} (read it with offset/limit)]`;
	}
	return {
		call,
		compaction: {
			text,
			before: shown.length,
			after: text.length,
			...(marker ? { retrieveId: marker.id } : {}),
			...(fullPath !== undefined ? { full: true as const } : {}),
		},
	};
}
