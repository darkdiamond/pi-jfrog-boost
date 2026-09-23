/**
 * Helpers for pi's tool and message content arrays.
 *
 * pi models content as `(TextContent | ImageContent)[]`. Boost only ever deals
 * in text, so these narrow to the text blocks and put results back without
 * disturbing images.
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

/** The concatenated text of a content array; "" when there is none. */
export function textOf(content: readonly ContentBlock[] | undefined): string {
	if (!content) return "";
	return content
		.filter(isText)
		.map((block) => block.text)
		.join("\n");
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
 * A trailing paragraph pi appended to a tool's output: a truncation or
 * continuation hint (`[Showing lines 1-2000 of 5000. Use offset=2001 to
 * continue.]`, `[100 matches limit reached. …]`, `… Full output: /tmp/…]`) or a
 * shell status line (`Command exited with code 1`).
 */
const PI_NOTICE =
	/\n\n(?:\[[^\n]*\]|Command (?:exited with code -?\d+|timed out after [\d.]+ seconds|aborted|terminated without an exit code))[ \t]*\n?$/;

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
