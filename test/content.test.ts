import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ContentBlock,
	isMeaningfulReduction,
	looksBinary,
	looksLikeHtmlDocument,
	mergeDetails,
	OBSERVE_TEXT_LIMIT,
	parseMarker,
	splitNotices,
	stripAnsi,
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

/**
 * Every notice pi 1.2.0 appends, copied verbatim from
 * `dist/core/tools/{bash,read,grep,find,ls}.js` with sample values filled in.
 */
const PI_NOTICES = [
	// bash.js (powershell.js shares it)
	"[Showing last 50.0KB of line 9000 (line is 1.2MB). Full output: /tmp/pi-bash-abc.log]",
	"[Showing lines 7001-9000 of 9000. Full output: /tmp/pi-bash-abc.log]",
	"[Showing lines 8001-9000 of 9000 (50.0KB limit). Full output: /tmp/pi-bash-abc.log]",
	"Command aborted",
	"Command timed out after 30 seconds",
	"Command terminated without an exit code",
	"Command exited with code 3",
	"Command exited with code -1",
	// read.js
	"[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]",
	"[Showing lines 1-1200 of 5000 (50.0KB limit). Use offset=1201 to continue.]",
	"[12 more lines in file. Use offset=41 to continue.]",
	// grep.js
	"[100 matches limit reached. Use limit=200 for more, or refine pattern]",
	"[50.0KB limit reached]",
	"[100 matches limit reached. Use limit=200 for more, or refine pattern. 50.0KB limit reached. Some lines truncated to 500 chars. Use read tool to see full lines]",
	// find.js
	"[1000 results limit reached. Use limit=2000 for more, or refine pattern]",
	"[1000 results limit reached]",
	// ls.js
	"[500 entries limit reached. Use limit=1000 for more]",
	"[500 entries limit reached. Use limit=1000 for more. 50.0KB limit reached]",
];

test("every notice pi 1.2.0 appends is recognised", () => {
	for (const notice of PI_NOTICES) {
		assert.deepEqual(splitNotices(`body\n\n${notice}`), { body: "body", notices: `\n\n${notice}` }, notice);
	}
});

test("bracketed output that is not a pi notice stays in the body", () => {
	for (const tail of [
		"[1, 2, 3]",
		'["a", "b"]',
		"[INFO] build finished",
		"[ERROR] 3 tests failed",
		"[Boost compressed ~90%. Get the full original output simply with: boost retrieve 1]",
		"[Showing nothing]x",
		"Command exited with code",
		"Command not found",
	]) {
		const text = `output\n\n${tail}`;
		assert.deepEqual(splitNotices(text), { body: text, notices: "" }, tail);
	}
});

test("a JSON array printed last is not a notice", () => {
	const json = JSON.stringify([1, 2, 3], null, 2);
	assert.deepEqual(splitNotices(`result:\n\n${json}`).notices, "");
	assert.deepEqual(splitNotices(`result:\n\n[1, 2, 3]`).notices, "");
});

test("a notice must follow a blank line, as pi writes it", () => {
	const text = "out\n[12 more lines in file. Use offset=41 to continue.]";
	assert.deepEqual(splitNotices(text), { body: text, notices: "" });
});

test("raw document bytes look binary; text does not", () => {
	assert.equal(looksBinary("%PDF-1.5\n\u0000\u0001stream"), true);
	assert.equal(looksBinary("����ab"), true);
	assert.equal(looksBinary("name,total\nalice,3\n"), false);
	assert.equal(looksBinary(""), false);
});

test("terminal escapes are stripped: CSI, OSC and 8-bit C1", () => {
	assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
	assert.equal(stripAnsi("\u001b[1;32;48;5;236m✔\u001b[39m ok"), "✔ ok");
	assert.equal(stripAnsi("a\u001b[2K\u001b[1Gb"), "ab");
	assert.equal(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007"), "link");
	assert.equal(stripAnsi("\u001b]0;title\u001b\\text"), "text");
	assert.equal(stripAnsi("\u009b1mbold\u009b0m"), "bold");
	assert.equal(stripAnsi("\u009d0;title\u009ctext"), "text");
	assert.equal(stripAnsi("\u001b(Bplain\u001b=x"), "plainx");
	assert.equal(stripAnsi("no escapes [31m here"), "no escapes [31m here");
});

test("an HTML document is recognised exactly as Boost recognises one", () => {
	for (const text of [
		"<!doctype html><html></html>",
		"<!DOCTYPE HTML PUBLIC>",
		"<html lang=en>",
		"<html>",
		"\uFEFF<!doctype html>",
		"  \n\t<!doctype html>",
		"<!-- generated -->\n<!-- twice -->\n<!doctype html>",
		"\u001b[38;5;12m<!DOCTYPE html>",
		"\u001b]0;title\u0007\u001b[1m  <html>",
		"<HTML>\n<body>",
	]) {
		assert.equal(looksLikeHtmlDocument(text), true, text);
	}
	for (const text of [
		"<div>fragment</div>",
		"<htmlx>",
		"<?xml version='1.0'?><html>",
		"text\n<!doctype html>",
		"<!-- unterminated <!doctype html>",
		`${" ".repeat(5000)}<!doctype html>`,
		"",
	]) {
		assert.equal(looksLikeHtmlDocument(text), false, text);
	}
});

const MARKER = "[Boost compressed ~84%. Get the full original output simply with: boost retrieve 147]";

test("the retrieve marker is read only from the last line", () => {
	assert.deepEqual(parseMarker(`summary\n${MARKER}`), { percent: 84, id: 147 });
	assert.deepEqual(parseMarker(`summary\n${MARKER}\n`), { percent: 84, id: 147 });
	assert.deepEqual(parseMarker(MARKER), { percent: 84, id: 147 });
	assert.equal(parseMarker(`${MARKER}\nmore output`), undefined, "a quoted marker is not one");
	assert.equal(parseMarker(`prefix ${MARKER}`), undefined, "not at the start of its line");
	assert.equal(parseMarker("[Boost compressed ~84%.]"), undefined);
	assert.equal(parseMarker(""), undefined);
});

test("a reduction must change more than whitespace and save max(256 B, 5%)", () => {
	const body = "x".repeat(10_000);
	assert.equal(isMeaningfulReduction(body, `${body}\n\n`), false);
	assert.equal(isMeaningfulReduction(`${body}\n`, body), false);
	assert.equal(isMeaningfulReduction(body, ""), false, "an empty reply is a malfunction, not a saving");
	assert.equal(isMeaningfulReduction(body, " \n "), false);
	assert.equal(isMeaningfulReduction(body, "x".repeat(9_501)), false, "499 B is under 5%");
	assert.equal(isMeaningfulReduction(body, "x".repeat(9_500)), true);
	assert.equal(isMeaningfulReduction("x".repeat(1000), "x".repeat(745)), false, "255 B is under 256 B");
	assert.equal(isMeaningfulReduction("x".repeat(1000), "x".repeat(744)), true);
	assert.equal(isMeaningfulReduction("é".repeat(1000), "é".repeat(800)), true, "measured in bytes");
});

test("details gain jfrogBoost only when they are a plain object or absent", () => {
	const boost = { kind: "compacted" as const, before: 10, after: 2 };
	assert.deepEqual(mergeDetails(undefined, boost), { jfrogBoost: boost });
	const own = { truncation: { truncated: true }, fullOutputPath: "/tmp/x" };
	assert.deepEqual(mergeDetails(own, boost), { ...own, jfrogBoost: boost });
	assert.deepEqual(own, { truncation: { truncated: true }, fullOutputPath: "/tmp/x" }, "not mutated");
	assert.deepEqual(mergeDetails(Object.create(null), boost), { jfrogBoost: boost });
	class Custom {
		value = 1;
	}
	for (const details of [null, [1, 2], "text", 3, new Custom(), new Map()]) {
		assert.equal(mergeDetails(details, boost), undefined, String(details));
	}
});

test("escape stripping stays linear on unterminated OSC sequences", () => {
	// A lazy OSC body rescans to the end from every `ESC ]`: 1 MiB of these
	// took two minutes on pi's main thread. Generous bound for slow CI.
	for (const unit of ["\u001b]a", "\u009da", "\u001b]\u001b]", "\u009d"]) {
		const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
		const started = performance.now();
		const out = stripAnsi(text);
		const ms = performance.now() - started;
		assert.ok(ms < 500, `${JSON.stringify(unit)}: ${ms.toFixed(0)} ms`);
		assert.ok(out.length <= text.length);
	}
	// Terminated sequences are still removed, unterminated ones left as text.
	assert.equal(stripAnsi("a\u001b]0;t\u0007b\u001b]8;;x"), "ab\u001b]8;;x");
});
