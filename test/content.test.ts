import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ContentBlock,
	looksBinary,
	OBSERVE_TEXT_LIMIT,
	splitNotices,
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

test("pi's trailing notices are split off, in order", () => {
	const text =
		"out\n\n[Showing lines 1-5 of 9. Full output: /tmp/pi-bash-1.log]\n\nCommand exited with code 2";
	assert.deepEqual(splitNotices(text), {
		body: "out",
		notices: "\n\n[Showing lines 1-5 of 9. Full output: /tmp/pi-bash-1.log]\n\nCommand exited with code 2",
	});
});

test("every pi notice shape is recognised", () => {
	for (const notice of [
		"[Showing lines 1-2000 of 5000 (50.0KB limit). Use offset=2001 to continue.]",
		"[12 more lines in file. Use offset=41 to continue.]",
		"[100 matches limit reached. Use limit=200 for more, or refine pattern]",
		"[500 entries limit reached. Use limit=1000 for more]",
		"Command timed out after 30 seconds",
		"Command aborted",
		"Command terminated without an exit code",
	]) {
		assert.equal(splitNotices(`body\n\n${notice}`).body, "body", notice);
	}
});

test("brackets inside the body are not mistaken for notices", () => {
	const text = "[INFO] build\n\n[WARN] deprecated\nmore output";
	assert.deepEqual(splitNotices(text), { body: text, notices: "" });
});

test("raw document bytes look binary; text does not", () => {
	assert.equal(looksBinary("%PDF-1.5\n\u0000\u0001stream"), true);
	assert.equal(looksBinary("����ab"), true);
	assert.equal(looksBinary("name,total\nalice,3\n"), false);
	assert.equal(looksBinary(""), false);
});
