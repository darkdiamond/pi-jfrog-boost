/**
 * Helpers for pi's tool and message content arrays, and the text checks the
 * router and the shell route share.
 *
 * pi models content as `(TextContent | ImageContent)[]`. Boost only ever deals
 * in text, so these narrow to the text blocks and put results back without
 * disturbing images. Everything here is pure: no I/O, no Boost.
 */
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

/** One block of a pi content array, derived from the SDK rather than redeclared. */
export type ContentBlock = ToolResultEvent["content"][number];
type TextBlock = Extract<ContentBlock, { type: "text" }>;

/** Observe payloads carry summaries, not transcripts. */
export const OBSERVE_TEXT_LIMIT = 16_000;

function isText(block: ContentBlock): block is TextBlock {
	return block.type === "text" && typeof block.text === "string";
}

/** The text of each text block, in order. */
export function textBlocks(content: readonly ContentBlock[] | undefined): string[] {
	return content ? content.filter(isText).map((block) => block.text) : [];
}

/** The concatenated text of a content array; "" when there is none. */
export function textOf(content: readonly ContentBlock[] | undefined): string {
	return textBlocks(content).join("\n");
}

/**
 * Replace a content array's text with `text`, keeping every non-text block.
 * Boost compresses the concatenation of all text blocks, so the replacement
 * collapses them into one at the position the first used to occupy.
 */
export function withText(content: readonly ContentBlock[], text: string): ContentBlock[] {
	const index = content.findIndex(isText);
	if (index < 0) return [...content, { type: "text", text }];
	const original = content[index];
	const replacement: TextBlock =
		original && isText(original) ? { ...original, text } : { type: "text", text };
	return content
		.map((block, i) => (i === index ? replacement : block))
		.filter((block, i) => i === index || !isText(block));
}

/**
 * One trailing notice pi appends to a tool's output, after the blank line pi
 * always puts before it. Matched narrowly, so ordinary output that happens to
 * end in brackets — a printed `[1, 2, 3]`, a JSON array, a `[INFO] done` log
 * line — stays part of the body and reaches Boost. 0.3.0 took any final
 * bracketed line for a notice. The shapes, from pi 1.2.0
 * `dist/core/tools/*.js` (0.86.1 emits the same):
 *
 *   bash, powershell  [Showing lines a-b of N. Full output: <path>]
 *                     [Showing lines a-b of N (50.0KB limit). Full output: <path>]
 *                     [Showing last 50.0KB of line N (line is 1.2MB). Full output: <path>]
 *                     Command exited with code N
 *                     Command timed out after N seconds
 *                     Command aborted
 *                     Command terminated without an exit code
 *   read              [Showing lines a-b of N. Use offset=X to continue.]
 *                     [Showing lines a-b of N (50.0KB limit). Use offset=X to continue.]
 *                     [N more lines in file. Use offset=X to continue.]
 *   grep, find, ls    [100 matches limit reached. Use limit=200 for more, or refine pattern]
 *                     [50.0KB limit reached]
 *                     [500 entries limit reached. Use limit=1000 for more]
 *
 * grep joins a "Some lines truncated" note onto a limit notice with ". ",
 * which the `limit reached` alternative still covers.
 */
const PI_NOTICE =
	/\n\n(?:\[(?:Showing (?:lines|last) [^\n]*|\d+ more lines in file\.[^\n]*|[^\n]*\blimit reached\b[^\n]*|[^\n]*Full output: [^\n]*)\]|Command (?:exited with code -?\d+|timed out after [\d.]+ seconds|aborted|terminated without an exit code))[ \t]*\n?$/;

/**
 * Split pi's trailing notices off a tool's output.
 *
 * They are how the model knows to continue with `offset=`, raise `limit=`, or
 * open the full output file, so Boost only ever sees the body and the notices
 * are put back verbatim afterwards — a filter that keeps the head or the tail
 * of its input can never drop them.
 */
export function splitNotices(text: string): { body: string; notices: string } {
	let body = text;
	let notices = "";
	for (let match = PI_NOTICE.exec(body); match; match = PI_NOTICE.exec(body)) {
		notices = `${match[0].replace(/\s+$/, "")}${notices}`;
		body = body.slice(0, match.index);
	}
	return { body, notices };
}

/**
 * Terminal escape sequences, which pi's bash passes through untouched (a test
 * runner that believes it has a TTY colours its output):
 *   - CSI, 7-bit `ESC [` or 8-bit `\x9b`: colours, cursor moves, erases;
 *   - OSC, `ESC ]` or `\x9d`, up to BEL or ST: window titles, hyperlinks;
 *   - the remaining `ESC` sequences: charset selection, keypad modes.
 * Boost's filters match plain text — a coloured `✔ ok 12` is not a passing
 * test to them (boost-surfaces 10) — so they are given stripped text.
 *
 * An OSC body may not contain ESC, BEL, ST or another OSC introducer. That is
 * what keeps this linear: a lazy `[\s\S]*?` body rescans to the end of the
 * text from every unterminated `ESC ]`, which is quadratic — 1 MiB of them
 * (an extraTools fetch of a hostile page) blocked pi's main thread for two
 * minutes. With the body class excluding every character that can start or
 * end one, no two scans overlap. An OSC interrupted by another escape is no
 * OSC a terminal would honour either; its introducer is left as text.
 */
const ANSI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
	/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b\]|\u009d)[^\u0007\u001b\u009c\u009d]*(?:\u0007|\u001b\\|\u009c)|\u001b[()*+][0-9A-Za-z]|\u001b[@-Z\\^_=>78]/g;

/** `text` without terminal escape sequences. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** How much of the start of a result the HTML sniff looks at. */
const HTML_SNIFF_CHARS = 4096;
/** One escape sequence exactly at `lastIndex`. */
const ANSI_AT = new RegExp(ANSI.source, "y");
/** The next character that is not whitespace (a BOM counts as whitespace). */
const NOT_SPACE = /[^\s\uFEFF]/g;

/**
 * Where the text Boost will be given starts once it trims: the index of the
 * first character that is neither whitespace, a BOM nor part of a terminal
 * escape, or -1 when there is none. Linear: each step consumes what it looks
 * at, and an escape that does not match ends the scan.
 */
function contentStart(text: string): number {
	let at = 0;
	for (;;) {
		NOT_SPACE.lastIndex = at;
		const next = NOT_SPACE.exec(text);
		if (!next) return -1;
		ANSI_AT.lastIndex = next.index;
		if (!ANSI_AT.test(text)) return next.index;
		at = ANSI_AT.lastIndex;
	}
}
/** A doctype or `<html>` tag at the start of the text. */
const HTML_OPENING = /^(?:<!doctype\s+html|<html[\s>])/i;

/**
 * Boost's own trigger for turning HTML into article text (NP1): a document
 * that opens, after any comments, with a doctype or an `<html>` tag. Anchored,
 * so a fragment, or a page quoted inside other output, does not match —
 * Boost leaves those alone too.
 *
 * Scanned by hand rather than as `^(<!--[\s\S]*?-->\s*)*(<!doctype…)`: that
 * pattern backtracks exponentially on `<!--` followed by repeated `--><!--`
 * (26 repetitions took 230 ms, each one doubling it), and it runs on the head
 * of every shell result, so a command printing a few hundred such bytes
 * would hang pi. Each comment ends at its first `-->`, as in HTML.
 */
function opensHtmlDocument(head: string): boolean {
	let at = 0;
	while (head.startsWith("<!--", at)) {
		const end = head.indexOf("-->", at + 4);
		if (end < 0) return false;
		at = end + 3;
		while (at < head.length && /\s/.test(head[at] as string)) at++;
	}
	return HTML_OPENING.test(head.slice(at));
}

/**
 * Whether Boost would turn this text into readable article text. It does that
 * whatever command produced the text, and no environment variable stops it
 * (NP1, NP2), so `cat index.html` would hand the model prose instead of the
 * source it is about to edit. The router lets such output through only for
 * web fetches, where readable text is the point.
 *
 * Terminal escapes are stripped first, because Boost is sent the stripped
 * text (shell.ts): `pygmentize index.html` prints `ESC[38;5;12m<!DOCTYPE html>`,
 * which the anchored pattern would miss while Boost, given the clean page,
 * still converts it. The sniff must judge exactly what Boost will be given.
 * Likewise the window starts after any leading whitespace, BOM and escapes,
 * however long: Boost trims them before its own check, so a page rendered
 * after 5 KiB of blank template lines is still converted.
 */
export function looksLikeHtmlDocument(text: string): boolean {
	const start = contentStart(text);
	if (start < 0) return false;
	const head = stripAnsi(text.slice(start, start + HTML_SNIFF_CHARS)).trimStart();
	return opensHtmlDocument(head);
}

/**
 * The marker Boost appends to compacted output, always as its last line:
 * `[Boost compressed ~84%. Get the full original output simply with: boost retrieve 147]`.
 * Anchored to the end, so a marker that is merely quoted in the output (an
 * earlier session's log, this extension's own README) is never taken for one.
 */
const MARKER = /(?:^|\n)\[Boost compressed ~(\d+)%\.[^\n\]]*?\bboost retrieve (\d+)\][ \t]*\n?$/;

/** The retrieve id and percentage from Boost's trailing marker, when there is one. */
export function parseMarker(text: string): { id: number; percent: number } | undefined {
	const match = MARKER.exec(text);
	if (!match) return undefined;
	return { percent: Number(match[1]), id: Number(match[2]) };
}

/** A changed result must save at least this many bytes (spec §6.2, §17)… */
export const MIN_REDUCTION_BYTES = 256;
/** …and at least this share of the original. */
export const MIN_REDUCTION_RATIO = 0.05;

/**
 * Whether Boost's reply is worth replacing the original with: different once
 * trailing whitespace is ignored, and at least `max(256 B, 5%)` smaller.
 *
 * Below that bar the model gains fewer than ~60 tokens and pays for them with
 * output that is no longer exactly what the tool printed. A reply that only
 * changed whitespace, or came back empty, is never a compaction; 0.3.0
 * applied both.
 */
export function isMeaningfulReduction(original: string, reply: string): boolean {
	const before = original.trimEnd();
	const after = reply.trimEnd();
	if (!after.trim() || after === before) return false;
	const beforeBytes = Buffer.byteLength(before);
	const saved = beforeBytes - Buffer.byteLength(after);
	return saved >= Math.max(MIN_REDUCTION_BYTES, MIN_REDUCTION_RATIO * beforeBytes);
}

/**
 * What `details.jfrogBoost` records about a result the extension changed.
 * Numbers and labels only, never text: details are shown in pi's UI and
 * persisted with the session, and the badge (WP7) is built from them.
 */
export interface BoostDetails {
	kind: "compacted" | "converted" | "mcp";
	/** Characters of text before and after. */
	before?: number;
	after?: number;
	/** The id in Boost's trailing marker, for `boost retrieve`. */
	retrieveId?: number;
	[key: string]: unknown;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * The tool's `details` with `jfrogBoost` added, or undefined when the two
 * cannot be merged safely. pi's renderers, and other extensions, read a
 * tool's own details (bash's `truncation` and `fullOutputPath`), so those are
 * kept as they are: only a plain object, or nothing at all, gains the key.
 * Anything else — an array, a class instance a custom tool's renderer relies
 * on — is left alone, and that row simply shows no badge.
 */
export function mergeDetails(details: unknown, boost: BoostDetails): Record<string, unknown> | undefined {
	if (details === undefined) return { jfrogBoost: boost };
	if (!isPlainObject(details)) return undefined;
	return { ...details, jfrogBoost: boost };
}

/**
 * Raw binary that pi's `read` decoded as UTF-8. pi only special-cases images,
 * so a PDF or Office file comes back as NULs and replacement characters
 * rather than as an error.
 */
export function looksBinary(text: string): boolean {
	const sample = text.slice(0, 8192);
	if (sample.includes("\0")) return true;
	let replaced = 0;
	for (const char of sample) if (char === "�") replaced++;
	return sample.length > 0 && replaced / sample.length > 0.1;
}

/** Clamp text destined for an observe payload. */
export function truncateForObserve(text: string): string {
	return text.length > OBSERVE_TEXT_LIMIT ? `${text.slice(0, OBSERVE_TEXT_LIMIT)}\n…[truncated]` : text;
}
