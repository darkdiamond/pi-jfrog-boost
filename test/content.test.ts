import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ContentBlock,
	OBSERVE_TEXT_LIMIT,
	textOf,
	truncateForObserve,
	withText,
} from "../src/content.ts";

const image = { type: "image", data: "…", mimeType: "image/png" } as unknown as ContentBlock;

test("textOf joins every text block and ignores the rest", () => {
	assert.equal(textOf([{ type: "text", text: "a" }, image, { type: "text", text: "b" }]), "a\nb");
});

test("textOf tolerates missing or image-only content", () => {
	assert.equal(textOf(undefined), "");
	assert.equal(textOf([]), "");
	assert.equal(textOf([image]), "");
});

test("withText replaces the text in place and keeps images", () => {
	const result = withText([image, { type: "text", text: "raw" }], "compacted");
	assert.deepEqual(result, [image, { type: "text", text: "compacted" }]);
});

test("withText collapses several text blocks into the first one's position", () => {
	const result = withText([{ type: "text", text: "one" }, image, { type: "text", text: "two" }], "compacted");
	assert.deepEqual(result, [{ type: "text", text: "compacted" }, image]);
});

test("withText adds a block when there was no text to replace", () => {
	assert.deepEqual(withText([image], "compacted"), [image, { type: "text", text: "compacted" }]);
});

test("withText preserves a text block's other fields", () => {
	const signed = { type: "text", text: "raw", textSignature: "sig" } as ContentBlock;
	assert.deepEqual(withText([signed], "compacted"), [
		{ type: "text", text: "compacted", textSignature: "sig" },
	]);
});

test("withText does not mutate the array it was given", () => {
	const original: ContentBlock[] = [{ type: "text", text: "raw" }];
	withText(original, "compacted");
	assert.deepEqual(original, [{ type: "text", text: "raw" }]);
});

test("observe text is clamped to the limit and marked", () => {
	const clamped = truncateForObserve("x".repeat(OBSERVE_TEXT_LIMIT + 10));
	assert.equal(clamped, `${"x".repeat(OBSERVE_TEXT_LIMIT)}\n…[truncated]`);
});

test("text at or under the limit is passed through untouched", () => {
	assert.equal(truncateForObserve("short"), "short");
	const exact = "x".repeat(OBSERVE_TEXT_LIMIT);
	assert.equal(truncateForObserve(exact), exact);
});
