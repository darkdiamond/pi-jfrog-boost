/**
 * Which tool results go to Boost, and by which route (spec §5).
 *
 * Every decision about a `tool_result` lives here, as a pure function of the
 * event and a snapshot of the extension's state, so the whole table can be
 * tested row by row without pi, Boost or a clock. A result that is not sent
 * gets a reason code; the counters (and later `/boost stats`) report them,
 * which is how a user finds out why a result was left alone.
 *
 * Pre-checks, in order, before any tool is looked at:
 *   nested     a call made by another tool (pi ≥ 1.x codemode, subagents):
 *              its output goes back to the calling script, not to the model
 *              (invariant 5)
 *   off        a kill switch, `--no-boost`, the session toggle or `enabled`
 *   not-ready  Boost not (yet) known to be usable; never waited for
 *   paused     the breaker is open after repeated slow or failed calls
 *   empty      no text to send
 *
 * Then, by tool:
 *   bash, powershell, extraTools   the shell route, unless the command
 *                                  bypasses Boost, the shell gate is off,
 *                                  the run was aborted, the output is an
 *                                  HTML document that was not fetched, or
 *                                  the body is outside minBytes…1 MiB
 *   read                           exact, except PDF/Office/OpenDocument
 *                                  files and whole reads of notebooks ≥ 16 KiB
 *                                  (`documents`, `notebooks`; converted by
 *                                  documents.ts), and whole reads of
 *                                  *.log/*.out with `readLogs` on
 *   mcp__*                         the MCP route (mcp.ts), unless `mcp` is
 *                                  off, the name matches `mcpExclude`, the
 *                                  call failed, Boost is older than 0.15.3
 *                                  or its `boost-mcp-filtering` flag is
 *                                  explicitly false, or the text is outside
 *                                  2 KiB…1 MiB or holds NUL
 *   everything else                untouched: grep, find and ls never
 *                                  compact on v0.15.4 and cost ~240 ms each;
 *                                  edit and write are what the model edits from
 *
 * The full-output route (WP6) is declared in {@link Route} but not produced
 * yet: truncated shell results go down the plain shell route until it lands.
 */

import type { BoostVersion } from "./boost-binary.ts";
import { looksLikeHtmlDocument, splitNotices } from "./content.ts";
import { documentMode, PI_OFFSET_ERROR } from "./documents.ts";
import { isMcpTool, type McpSkipReason, mcpSkip } from "./mcp.ts";
import { bypassesBoost, isWebFetch } from "./shell.ts";
import { extensionOf, isShell, LOG_EXTENSIONS, NEVER_EXTRA } from "./tools.ts";

/** The largest body any route sends to Boost (was 4 MiB in 0.3.0; spec §8.5). */
export const MAX_ROUTE_BYTES = 1024 * 1024;

export type SkipReason =
	| "nested"
	| "off"
	| "not-ready"
	| "paused"
	| "empty"
	| "bypass"
	| "shell-off"
	| "aborted"
	| "html"
	| "binary"
	| "small"
	| "large"
	| "error"
	| "exact"
	| "untouched"
	| McpSkipReason;

export type Route =
	| { kind: "skip"; reason: SkipReason }
	| { kind: "shell" }
	| { kind: "shell-full" }
	| { kind: "log" }
	| { kind: "document" }
	| { kind: "mcp" };

/** The settings the router reads. */
export interface RouteSettings {
	minBytes: number;
	readLogs: boolean;
	documents: boolean;
	notebooks: boolean;
	extraTools: readonly string[];
	mcp: boolean;
	mcpExclude: readonly string[];
}

/** A tool result and the state it is judged against, gathered by the caller. */
export interface RouteInput {
	toolName: string;
	input: Readonly<Record<string, unknown>>;
	/** The result's text blocks, joined. */
	text: string;
	isError: boolean;
	/** The event has a `parentToolCallId`. */
	nested: boolean;
	/** Any off switch is active. */
	off: boolean;
	/** Readiness is `ready`. */
	ready: boolean;
	/** The breaker is open (not half-open: that state's trial is the client's to hand out). */
	paused: boolean;
	/** The shell gate (spec §8.4) resolves on. */
	shellOn: boolean;
	/** The running Boost's version, when known (the MCP route needs ≥ 0.15.3). */
	boostVersion?: BoostVersion | undefined;
	/**
	 * `boost-mcp-filtering` as Boost will resolve it (env, then config).
	 * Only consulted for `mcp__*` tools; absent counts as unknown.
	 */
	mcpFlag?: boolean | "unknown";
	settings: RouteSettings;
}

const skip = (reason: SkipReason): Route => ({ kind: "skip", reason });

/** Whether the tool is routed like `bash`: a shell, or an `extraTools` name other than read/edit/write. */
export function isShellLike(toolName: string, extraTools: readonly string[]): boolean {
	return isShell(toolName) || (extraTools.includes(toolName) && !NEVER_EXTRA.has(toolName));
}

/** Skip reasons for a body outside the size window, or undefined when it fits. */
function sizeSkip(body: string, minBytes: number): Route | undefined {
	const bytes = Buffer.byteLength(body);
	if (bytes < minBytes) return skip("small");
	if (bytes > MAX_ROUTE_BYTES) return skip("large");
	return undefined;
}

export function route(r: RouteInput): Route {
	if (r.nested) return skip("nested");
	if (r.off) return skip("off");
	if (!r.ready) return skip("not-ready");
	if (r.paused) return skip("paused");
	if (!r.text.trim()) return skip("empty");

	if (isShellLike(r.toolName, r.settings.extraTools)) return routeShell(r);
	if (r.toolName === "read") return routeRead(r);
	if (isMcpTool(r.toolName)) return routeMcp(r);
	return skip("untouched");
}

function routeMcp(r: RouteInput): Route {
	const reason = mcpSkip({
		toolName: r.toolName,
		isError: r.isError,
		text: r.text,
		settings: r.settings,
		boostVersion: r.boostVersion,
		mcpFlag: r.mcpFlag ?? "unknown",
	});
	return reason ? skip(reason) : { kind: "mcp" };
}

function routeShell(r: RouteInput): Route {
	const command = r.input.command;
	if (bypassesBoost(command)) return skip("bypass");
	// No spawn when Boost would not filter anyway: on a default v0.15 install
	// CLI filtering is off, and every call would be a ~200 ms no-op.
	if (!r.shellOn) return skip("shell-off");
	// pi throws on abort and reports what was printed so far. Half a run is
	// not worth summarising, and the model is about to be interrupted anyway.
	if (r.text.trimEnd().endsWith("Command aborted")) return skip("aborted");
	const { body } = splitNotices(r.text);
	// Boost turns a whole HTML page into article text, whatever produced it.
	// Wanted for a fetched page; not for `cat index.html`, which the model is
	// about to edit. An extraTools tool without a command (a fetch tool) was
	// opted in by the user for exactly this, so its pages go through too.
	const fetched = isWebFetch(command) || (!isShell(r.toolName) && typeof command !== "string");
	if (looksLikeHtmlDocument(body) && !fetched) return skip("html");
	// Binary on stdout (`cat image.png`): Boost filters text.
	if (body.includes("\0")) return skip("binary");
	// Shell failures are compacted too — a failing test run is the noisiest
	// output there is — and keep `isError`.
	return sizeSkip(body, r.settings.minBytes) ?? { kind: "shell" };
}

function routeRead(r: RouteInput): Route {
	const path = r.input.path;
	const document = routeDocument(r);
	if (document) return document;
	// A refused read (missing file, permission, a directory) is a short
	// message, and must never turn into a conversion of something else.
	if (r.isError) return skip("error");
	if (typeof path !== "string" || !LOG_EXTENSIONS.has(extensionOf(path))) return skip("exact");
	// Logs are opt-in: Boost's filters are written for command output, and on
	// generic logs one can misfire and drop most of the file (trivy on an ISO
	// timestamped app log: 51% gone, boost-surfaces 11). Only whole reads: a
	// read with offset or limit is the model asking for exact lines.
	if (!r.settings.readLogs || r.input.offset !== undefined || r.input.limit !== undefined) {
		return skip("exact");
	}
	const { body } = splitNotices(r.text);
	if (looksLikeHtmlDocument(body)) return skip("html");
	if (!r.shellOn) return skip("shell-off");
	if (body.includes("\0")) return skip("binary");
	return sizeSkip(body, r.settings.minBytes) ?? { kind: "log" };
}

/**
 * The document rows of the table, or undefined for any other read.
 *
 * PDF, Office and OpenDocument files go to Boost whatever pi's text looks
 * like. pi's `read` returns a document's raw bytes, but not always in a form
 * that looks binary: a stored zip's XML part is one line far over 50 KiB, so
 * pi answers with its "line too long" notice instead, and a page past the
 * first is a slice of bytes that may be plain XML. Whether the file really is
 * a document is decided on the file itself, by its magic number
 * (documents.ts), before anything is spawned.
 *
 * One refused read is routed too: pi's "Offset N is beyond end of file" for
 * a document. pi counts lines in the raw bytes — a compressed PDF may have
 * a few hundred, a stored .docx three — while the model is paging through
 * the converted text, whose `[Showing lines 1-1248 of 3001 …]` told it to
 * continue at offset=1249. Without this, the second page of almost every
 * document would be an error. pi only says this after it opened the file,
 * so no other refusal (missing, permission, a directory) can take this row.
 *
 * Notebooks are text, and their JSON is what a partial read asks for, so
 * only whole reads are converted (the size floor is checked on the file).
 *
 * Boost's Preview Agreement is not checked here. `boost read` exits 1
 * without it (NP3), so documents.ts skips the read as `terms` before any
 * spawn — after the stat, the notebook size floor and the magic-number check,
 * so a read that would not have been converted anyway is counted as what it
 * is (`small`, `not-document`), and the terms notice is not shown for it.
 * Shell and MCP filtering work without the terms (F2), so they gate nothing
 * else.
 */
function routeDocument(r: RouteInput): Route | undefined {
	const mode = documentMode(r.input.path);
	if (!mode) return undefined;
	if (r.isError) {
		const offsetPastRawEnd =
			mode !== "notebook" && r.input.offset !== undefined && PI_OFFSET_ERROR.test(r.text.trim());
		if (!offsetPastRawEnd) return skip("error");
	}
	if (!r.settings.documents) return skip("exact");
	if (mode === "notebook") {
		if (!r.settings.notebooks || r.input.offset !== undefined || r.input.limit !== undefined) {
			return skip("exact");
		}
	}
	return { kind: "document" };
}
