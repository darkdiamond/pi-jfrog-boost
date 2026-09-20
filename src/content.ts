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

/** Clamp text destined for an observe payload. */
export function truncateForObserve(text: string): string {
	return text.length > OBSERVE_TEXT_LIMIT ? `${text.slice(0, OBSERVE_TEXT_LIMIT)}\n…[truncated]` : text;
}
