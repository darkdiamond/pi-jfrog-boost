/**
 * The document route (spec §7.1): pi-identical paging, output validation,
 * the legacy advisory, the cache, and path resolution — against stand-in
 * conversions, so no Boost is needed.
 *
 * Paging is checked two ways: against notice strings copied verbatim from
 * pi 1.2.0 `dist/core/tools/read.js` (0.86.1 has the same), and against the
 * installed pi's own `read` tool on a file holding the converted text, for
 * every offset/limit shape. The second catches a pi release that changes
 * its paging before a user does.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import type { BoostCall } from "../src/boost-client.ts";
import {
	CACHE_MAX_ENTRIES,
	cacheKey,
	createDocumentCache,
	type DocumentDeps,
	documentMode,
	formatSize,
	headerFor,
	invalidOutput,
	isDocumentFile,
	legacyAdvisory,
	NOTEBOOK_MIN_BYTES,
	PI_MAX_BYTES,
	PI_MAX_LINES,
	PI_OFFSET_ERROR,
	readDocument,
	sliceLikePiRead,
} from "../src/documents.ts";
import { shellQuote } from "../src/tools.ts";
import { docx } from "./helpers/docx.ts";
import { call } from "./helpers/runtime.ts";

const root = mkdtempSync(join(tmpdir(), "pi-boost-documents-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** Numbered lines `line 1` … `line n`, joined by `\n`. */
const numbered = (n: number, width = 0) =>
	Array.from({ length: n }, (_, i) => `line ${i + 1}`.padEnd(width, "x")).join("\n");

// ---------------------------------------------------------------------------
// Notices, verbatim from pi 1.2.0 dist/core/tools/read.js

test("pi's three continuation notices, byte for byte", () => {
	const lines = sliceLikePiRead(numbered(2500), undefined, undefined, "/a.pdf");
	assert.equal(lines.kind, "page");
	if (lines.kind !== "page") return;
	// `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
	assert.equal(lines.notice, "\n\n[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
	assert.deepEqual(lines.lines, [1, 2000, 2500]);

	const bytes = sliceLikePiRead(numbered(1500, 60), undefined, undefined, "/a.pdf");
	assert.equal(bytes.kind, "page");
	if (bytes.kind !== "page") return;
	// `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
	assert.equal(bytes.notice, "\n\n[Showing lines 1-839 of 1500 (50.0KB limit). Use offset=840 to continue.]");

	const limited = sliceLikePiRead(numbered(100), 11, 20, "/a.pdf");
	assert.equal(limited.kind, "page");
	if (limited.kind !== "page") return;
	// `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
	assert.equal(limited.notice, "\n\n[70 more lines in file. Use offset=31 to continue.]");
	assert.equal(limited.page, numbered(30).split("\n").slice(10).join("\n"));
	assert.deepEqual(limited.lines, [11, 30, 100]);
});

test("an offset past the end is pi's error, verbatim", () => {
	// `Offset ${offset} is beyond end of file (${allLines.length} lines total)`
	assert.deepEqual(sliceLikePiRead(numbered(10), 11, undefined, "/a.pdf"), {
		kind: "error",
		message: "Offset 11 is beyond end of file (10 lines total)",
	});
	assert.match("Offset 11 is beyond end of file (10 lines total)", PI_OFFSET_ERROR);
	assert.doesNotMatch("Offset 11 is beyond end of file (10 lines total). And more", PI_OFFSET_ERROR);
});

test("pi's limits and size format", () => {
	assert.equal(PI_MAX_LINES, 2000);
	assert.equal(PI_MAX_BYTES, 50 * 1024);
	assert.equal(formatSize(PI_MAX_BYTES), "50.0KB");
	assert.equal(formatSize(512), "512B");
	assert.equal(formatSize(3 * 1024 * 1024), "3.0MB");
});

test("a line over 50 KiB points at boost read, not at the binary file", () => {
	const slice = sliceLikePiRead(`short\n${"x".repeat(60 * 1024)}\nend`, 2, undefined, "/docs/my report.pdf");
	assert.equal(slice.kind, "page");
	if (slice.kind !== "page") return;
	assert.equal(slice.page, "");
	assert.equal(
		slice.notice,
		"[Line 2 is 60.0KB, exceeds 50.0KB limit. Use bash: boost read -- '/docs/my report.pdf' | sed -n '2p' | head -c 51200]",
	);
});

// ---------------------------------------------------------------------------
// The same text through pi's own read tool

async function piRead(
	path: string,
	offset?: number,
	limit?: number,
): Promise<{ text: string; error?: string; truncation?: Record<string, unknown> }> {
	const tool = createReadTool(root);
	const args: Record<string, unknown> = { path };
	if (offset !== undefined) args.offset = offset;
	if (limit !== undefined) args.limit = limit;
	try {
		const result = (await tool.execute("t", args as never)) as unknown as {
			content: { type: string; text?: string }[];
			details?: { truncation?: Record<string, unknown> };
		};
		const text = result.content.map((b) => b.text ?? "").join("");
		const truncation = result.details?.truncation;
		if (!truncation) return { text };
		const { content: _content, ...numbers } = truncation;
		return { text, truncation: numbers };
	} catch (error) {
		return { text: "", error: (error as Error).message };
	}
}

test("paging matches the installed pi's read on the same text, for every shape", async () => {
	const texts: Record<string, string> = {
		lines: numbered(4321),
		trailing: `${numbered(2100)}\n`,
		wide: numbered(3000, 70),
		multibyte: Array.from({ length: 1800 }, (_, i) => `${i} ${"é€".repeat(20)}`).join("\n"),
		small: "one\ntwo\nthree",
		empty: "",
	};
	const shapes: [number | undefined, number | undefined][] = [
		[undefined, undefined],
		[0, undefined],
		[1, undefined],
		[2001, undefined],
		[841, undefined],
		[4000, undefined],
		[undefined, 10],
		[5, 3],
		[3, 0],
		[1, 5000],
		[4321, 1],
		[4322, undefined],
		[99999, 5],
	];
	for (const [name, text] of Object.entries(texts)) {
		const file = join(root, `${name}.txt`);
		writeFileSync(file, text);
		for (const [offset, limit] of shapes) {
			const label = `${name} offset=${offset} limit=${limit}`;
			const pi = await piRead(file, offset, limit);
			const ours = sliceLikePiRead(text, offset, limit, file);
			if (pi.error !== undefined) {
				assert.deepEqual(ours, { kind: "error", message: pi.error }, label);
			} else {
				assert.equal(ours.kind, "page", label);
				if (ours.kind === "page") {
					assert.equal(`${ours.page}${ours.notice}`, pi.text, label);
					// What pi's renderer warns from: the same numbers, or none when pi sets none.
					assert.deepEqual(ours.truncation, pi.truncation, `${label} truncation`);
				}
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Header, advisory, validation

test("the header names the file and warns about line numbers, spreadsheets and notebooks", () => {
	assert.equal(
		headerFor("q3.pdf", ".pdf"),
		"[Converted from q3.pdf by JFrog Boost. Line numbers refer to this text, not the file.]",
	);
	assert.match(
		headerFor("t.xlsx", ".xlsx"),
		/ Spreadsheet cells are listed one per line; table layout is not preserved\.\]$/,
	);
	assert.match(headerFor("t.ods", ".ods"), /table layout is not preserved\.\]$/);
	assert.match(
		headerFor("n.ipynb", ".ipynb"),
		/ For the raw notebook JSON, read it again with offset=1\.\]$/,
	);
});

test("the legacy advisory quotes Boost's first line", () => {
	assert.equal(
		legacyAdvisory(
			"old.doc",
			"[boost] Legacy Office (.doc): save as docx/xlsx/pptx, then Read or boost read.\nmore\n",
		),
		"pi-jfrog-boost: old.doc is a legacy binary Office file that neither pi nor Boost can convert to text. Boost says: [boost] Legacy Office (.doc): save as docx/xlsx/pptx, then Read or boost read. Ask the user for a .docx/.xlsx/.pptx or text export.",
	);
});

test("only plain text is accepted from boost read", () => {
	assert.equal(invalidOutput("# Report\n\nText."), undefined);
	assert.equal(invalidOutput(""), "empty");
	assert.equal(invalidOutput(" \n\t\n"), "empty");
	assert.equal(invalidOutput("text\u0000more"), "binary");
	assert.equal(invalidOutput("%PDF-1.7\n1 0 obj"), "binary");
	assert.equal(invalidOutput("PK\u0003\u0004word/document.xml"), "binary");
	assert.equal(invalidOutput("�PNG\r\n\u001a\n"), "binary");
	assert.equal(invalidOutput("GIF89a"), "binary");
	assert.equal(invalidOutput("����JFIF"), "binary");
	assert.equal(invalidOutput("image /tmp/x.png 640x480"), "image");
	assert.equal(invalidOutput("[boost] Unsupported format"), "advisory");
	assert.equal(invalidOutput(`a${"�".repeat(50)}b`), "binary");
});

test("document modes by extension; CSV, RTF and HTML are not documents", () => {
	assert.equal(documentMode("a/B.PDF"), "binary");
	assert.equal(documentMode("x.odp"), "binary");
	assert.equal(documentMode("x.xls"), "legacy");
	assert.equal(documentMode("x.ipynb"), "notebook");
	for (const path of ["t.csv", "a.rtf", "i.html", "i.htm", "a.png", "a.txt", 42]) {
		assert.equal(documentMode(path), undefined, String(path));
	}
});

// ---------------------------------------------------------------------------
// Cache

test("the cache is an LRU bounded by entries and by memory", () => {
	const cache = createDocumentCache(3, 100);
	cache.set("a", "1");
	cache.set("b", "2");
	cache.set("c", "3");
	assert.equal(cache.get("a"), "1"); // a is now the most recent
	cache.set("d", "4");
	assert.equal(cache.get("b"), undefined, "the least recently used entry went");
	assert.deepEqual(
		["a", "c", "d"].map((k) => cache.get(k)),
		["1", "3", "4"],
	);
	cache.set("big", "x".repeat(49)); // 98 bytes as UTF-16: a and c go to get back under 100
	assert.deepEqual(
		["a", "c", "d"].map((k) => cache.get(k)),
		[undefined, undefined, "4"],
	);
	assert.equal(cache.size(), 2);
	cache.set("huge", "x".repeat(60)); // over the whole budget: not cached
	assert.equal(cache.get("huge"), undefined);
	assert.equal(CACHE_MAX_ENTRIES, 8);
	assert.notEqual(cacheKey("/a", 1, 2), cacheKey("/a", 1, 3));
	assert.notEqual(cacheKey("/a", 1, 2), cacheKey("/a", 2, 2));
});

// ---------------------------------------------------------------------------
// readDocument against real files and a stand-in convert

const DOCX = docx(["Hello"]);
const PDF = Buffer.from("%PDF-1.7\n\u0000\u0001binary", "latin1");
const OLE = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(64)]);

function file(name: string, data: Buffer | string): string {
	const path = join(root, name);
	writeFileSync(path, data);
	return path;
}

function converter(reply: BoostCall | ((abs: string) => BoostCall)) {
	const calls: string[] = [];
	const deps: DocumentDeps = {
		cache: createDocumentCache(),
		convert: async (abs) => {
			calls.push(abs);
			return typeof reply === "function" ? reply(abs) : reply;
		},
		home: join(root, "home"),
	};
	return { deps, calls };
}

const request = (
	path: string,
	over: { offset?: number; limit?: number; cwd?: string; termsAccepted?: boolean } = {},
) => ({
	path,
	offset: over.offset,
	limit: over.limit,
	cwd: over.cwd ?? root,
	termsAccepted: over.termsAccepted ?? true,
});

test("a document is converted, given a header, and paged like pi", async () => {
	file("report.docx", DOCX);
	const text = numbered(2500);
	const { deps, calls } = converter(call(text));
	const outcome = await readDocument(request("report.docx"), deps);
	assert.equal(outcome.kind, "page");
	if (outcome.kind !== "page") return;
	const header =
		"[Converted from report.docx by JFrog Boost. Line numbers refer to this text, not the file.]";
	const page = `${numbered(2000)}\n\n[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]`;
	assert.equal(outcome.text, `${header}\n${page}`);
	assert.equal(outcome.page, page);
	assert.deepEqual(outcome.lines, [1, 2000, 2500]);
	assert.equal(outcome.ext, ".docx");
	assert.deepEqual(calls, [join(root, "report.docx")]);
});

test("offset continues from the cache: the second page costs no spawn", async () => {
	file("long.pdf", PDF);
	const { deps, calls } = converter(call(numbered(2500)));
	await readDocument(request("long.pdf"), deps);
	const second = await readDocument(request("long.pdf", { offset: 2001 }), deps);
	assert.equal(second.kind, "page");
	if (second.kind !== "page") return;
	assert.match(second.text, /\nline 2001\n/);
	assert.match(second.text, /line 2500$/);
	assert.deepEqual(second.lines, [2001, 2500, 2500]);
	assert.equal(calls.length, 1);

	const past = await readDocument(request("long.pdf", { offset: 2501 }), deps);
	assert.deepEqual(past, {
		kind: "error",
		text: "Offset 2501 is beyond end of file (2500 lines total)",
		ext: ".pdf",
	});
	assert.equal(calls.length, 1);
});

test("a file changed in place is converted again", async () => {
	const path = file("changing.pdf", PDF);
	const { deps, calls } = converter(call("v1"));
	await readDocument(request(path), deps);
	writeFileSync(path, Buffer.concat([PDF, Buffer.from("more")]));
	await readDocument(request(path), deps);
	assert.equal(calls.length, 2);
});

test("@, ~ and a leading dash resolve the way pi's read does", async () => {
	mkdirSync(join(root, "home"), { recursive: true });
	file("-x.docx", DOCX);
	file("@at.docx", DOCX);
	file(join("home", "h.docx"), DOCX);
	const { deps, calls } = converter(call("text"));
	for (const path of ["-x.docx", "@-x.docx", "@@at.docx", "~/h.docx", join(root, "-x.docx")]) {
		const outcome = await readDocument(request(path), { ...deps, cache: createDocumentCache() });
		assert.equal(outcome.kind, "page", path);
	}
	assert.deepEqual(calls, [
		join(root, "-x.docx"),
		join(root, "-x.docx"),
		join(root, "@at.docx"),
		join(root, "home", "h.docx"),
		join(root, "-x.docx"),
	]);
});

test("not a regular file, or not the format its name claims: no spawn", async () => {
	mkdirSync(join(root, "dir.pdf"), { recursive: true });
	file("text.pdf", "just text, called .pdf");
	file("fake.docx", "<w:document/>");
	file("fake.doc", "plain");
	const { deps, calls } = converter(call("converted"));
	assert.deepEqual(await readDocument(request("dir.pdf"), deps), { kind: "skip", reason: "not-file" });
	assert.deepEqual(await readDocument(request("missing.pdf"), deps), { kind: "skip", reason: "not-file" });
	for (const name of ["text.pdf", "fake.docx", "fake.doc"]) {
		assert.deepEqual(await readDocument(request(name), deps), { kind: "skip", reason: "not-document" }, name);
	}
	assert.equal(calls.length, 0);
});

test("anything but plain text from Boost keeps pi's result", async () => {
	file("q.pdf", PDF);
	const cases: [BoostCall, string][] = [
		[call("text", 1), "exit"],
		[call("   \n"), "empty"],
		[call("a\u0000b"), "binary"],
		[call("%PDF-1.4 raw"), "binary"],
		[call("image /tmp/q.png"), "image"],
		[call("[boost] cannot convert"), "advisory"],
		[{ ...call(""), code: null, timedOut: true }, "failed"],
		[{ ...call(""), code: null, aborted: true }, "failed"],
		[{ ...call(""), code: null, skipped: "paused" }, "paused"],
		[{ ...call(""), code: null, skipped: "busy" }, "busy"],
	];
	for (const [reply, reason] of cases) {
		const { deps } = converter(reply);
		const outcome = await readDocument(request("q.pdf"), deps);
		assert.equal(outcome.kind, "skip", reason);
		if (outcome.kind === "skip") assert.equal(outcome.reason, reason);
		// A failure is never cached: the next read tries again.
		assert.equal(deps.cache.size(), 0, reason);
	}
});

test("legacy Office: Boost's advisory becomes an error, anything else keeps pi's result", async () => {
	file("old.doc", OLE);
	const advisory = "[boost] Legacy Office (.doc): save as docx/xlsx/pptx, then Read or boost read.\n";
	for (const code of [0, 1]) {
		const { deps, calls } = converter(call(advisory, code));
		const outcome = await readDocument(request("old.doc"), deps);
		assert.equal(outcome.kind, "error");
		if (outcome.kind === "error") assert.equal(outcome.text, legacyAdvisory("old.doc", advisory));
		await readDocument(request("old.doc"), deps);
		assert.equal(calls.length, 1, "the advisory is cached too");
	}
	for (const reply of [
		call("Some text Boost found"),
		call("", 1),
		{ ...call(""), code: null, skipped: "missing" as const },
	]) {
		const { deps } = converter(reply);
		assert.equal((await readDocument(request("old.doc"), deps)).kind, "skip");
	}
});

test("notebooks: whole reads of files ≥ 16 KiB only, from line 1", async () => {
	file("small.ipynb", JSON.stringify({ cells: [] }));
	file("big.ipynb", JSON.stringify({ cells: [], pad: "x".repeat(NOTEBOOK_MIN_BYTES) }));
	const { deps, calls } = converter(call("```\nprint(1)\n```\n"));
	assert.deepEqual(await readDocument(request("small.ipynb"), deps), { kind: "skip", reason: "small" });
	assert.deepEqual(await readDocument(request("big.ipynb", { offset: 1 }), deps), {
		kind: "skip",
		reason: "exact",
	});
	assert.deepEqual(await readDocument(request("big.ipynb", { limit: 5 }), deps), {
		kind: "skip",
		reason: "exact",
	});
	const whole = await readDocument(request("big.ipynb"), deps);
	assert.equal(whole.kind, "page");
	if (whole.kind === "page") {
		assert.match(whole.text, /^\[Converted from big\.ipynb by JFrog Boost\..*offset=1\.\]\n```\nprint\(1\)/);
		assert.deepEqual(whole.lines, [1, 4, 4]);
	}
	assert.equal(calls.length, 1);
});

test("a converted notebook over one page says how to reach the rest of the converted text", async () => {
	file("many.ipynb", JSON.stringify({ cells: [], pad: "x".repeat(NOTEBOOK_MIN_BYTES) }));
	const abs = join(root, "many.ipynb");
	const lines = Array.from({ length: 4748 }, (_, i) => `l${i + 1}`).join("\n");
	const { deps } = converter(call(lines));
	const outcome = await readDocument(request("many.ipynb"), deps);
	assert.equal(outcome.kind, "page");
	if (outcome.kind !== "page") return;
	assert.deepEqual(outcome.lines, [1, 2000, 4748]);
	assert.equal(outcome.truncation?.truncatedBy, "lines");
	assert.ok(
		outcome.text.endsWith(
			`\nl2000\n\n[Showing lines 1-2000 of 4748 of the converted notebook. To continue, use bash: boost read -- ${shellQuote(abs)} | sed -n '2001,4000p'. A read with offset returns the raw notebook JSON instead.]`,
		),
		outcome.text.slice(-300),
	);
	assert.doesNotMatch(outcome.text, /Use offset=/);
	// The offset read the notice warns about is pi's raw JSON, not this text.
	assert.deepEqual(await readDocument(request("many.ipynb", { offset: 2001 }), deps), {
		kind: "skip",
		reason: "exact",
	});

	// Cut by bytes: the next range is as many lines as this page showed.
	file("wide.ipynb", JSON.stringify({ cells: [], pad: "y".repeat(NOTEBOOK_MIN_BYTES) }));
	const wide = Array.from({ length: 300 }, () => "w".repeat(1000)).join("\n");
	const bytes = await readDocument(request("wide.ipynb"), converter(call(wide)).deps);
	assert.equal(bytes.kind, "page");
	if (bytes.kind !== "page") return;
	assert.deepEqual(bytes.lines, [1, 51, 300]);
	assert.ok(
		bytes.text.endsWith(
			`\n\n[Showing lines 1-51 of 300 of the converted notebook (50.0KB limit). To continue, use bash: boost read -- ${shellQuote(join(root, "wide.ipynb"))} | sed -n '52,102p'. A read with offset returns the raw notebook JSON instead.]`,
		),
		bytes.text.slice(-300),
	);

	// A PDF keeps pi's own notice: its offset reads do page the converted text.
	file("many.pdf", PDF);
	const pdf = await readDocument(request("many.pdf"), converter(call(lines)).deps);
	assert.ok(
		pdf.kind === "page" && pdf.text.endsWith("[Showing lines 1-2000 of 4748. Use offset=2001 to continue.]"),
	);
});

test("offset and limit that pi would not accept leave the read alone", async () => {
	file("args.pdf", PDF);
	const { deps, calls } = converter(call("text"));
	const outcome = await readDocument(
		{ path: "args.pdf", offset: "5", limit: undefined, cwd: root, termsAccepted: true },
		deps,
	);
	assert.deepEqual(outcome, { kind: "skip", reason: "exact" });
	assert.equal(calls.length, 0);
});

test("without the Preview Agreement: no spawn, but only a real document counts as `terms`", async () => {
	file("t.pdf", PDF);
	file("t-text.pdf", "just text, called .pdf");
	file("t-small.ipynb", JSON.stringify({ cells: [] }));
	const { deps, calls } = converter(call("converted"));
	const noTerms = { termsAccepted: false };
	assert.deepEqual(await readDocument(request("t.pdf", noTerms), deps), { kind: "skip", reason: "terms" });
	assert.deepEqual(await readDocument(request("t-text.pdf", noTerms), deps), {
		kind: "skip",
		reason: "not-document",
	});
	assert.deepEqual(await readDocument(request("t-small.ipynb", noTerms), deps), {
		kind: "skip",
		reason: "small",
	});
	assert.equal(calls.length, 0);
	// Converted while the terms were there, unchanged since: still served.
	await readDocument(request("t.pdf"), deps);
	assert.equal((await readDocument(request("t.pdf", noTerms), deps)).kind, "page");
	assert.equal(calls.length, 1);
});

test("a PDF header anywhere in the first 1 KiB counts; an encrypted (OLE2) OOXML file does not", async () => {
	file("bom.pdf", Buffer.concat([Buffer.from("\ufeff\r\n", "utf-8"), PDF]));
	file(
		"preamble.pdf",
		Buffer.concat([Buffer.from(`Content-Type: application/pdf\n${" ".repeat(900)}\n`), PDF]),
	);
	file("late.pdf", Buffer.concat([Buffer.alloc(1100, 0x20), PDF]));
	file("locked.xlsx", OLE);
	file("locked.odt", OLE);
	const { deps, calls } = converter(call("text"));
	for (const name of ["bom.pdf", "preamble.pdf"]) {
		assert.equal((await readDocument(request(name), deps)).kind, "page", name);
	}
	// Past the window; and OLE2 under an OOXML/ODF name, which Boost would
	// only echo back as raw bytes.
	for (const name of ["late.pdf", "locked.xlsx", "locked.odt"]) {
		assert.deepEqual(await readDocument(request(name), deps), { kind: "skip", reason: "not-document" }, name);
	}
	assert.equal(calls.length, 2);
});

test("isDocumentFile: zip and OLE at byte 0 only; notebooks have no magic", () => {
	const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]);
	assert.equal(isDocumentFile(".docx", zip), true);
	assert.equal(isDocumentFile(".docx", Buffer.concat([Buffer.from(" "), zip])), false);
	assert.equal(isDocumentFile(".doc", OLE), true);
	assert.equal(isDocumentFile(".doc", zip), false);
	assert.equal(isDocumentFile(".ipynb", Buffer.alloc(0)), true);
});

test("a page carries pi's truncation numbers when pi's read would, and only then", async () => {
	file("trunc.pdf", PDF);
	const long = await readDocument(request("trunc.pdf"), converter(call(numbered(2500))).deps);
	assert.equal(long.kind, "page");
	if (long.kind === "page") {
		assert.deepEqual(long.truncation, {
			truncated: true,
			truncatedBy: "lines",
			totalLines: 2500,
			totalBytes: Buffer.byteLength(numbered(2500)),
			outputLines: 2000,
			outputBytes: Buffer.byteLength(numbered(2000)),
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines: 2000,
			maxBytes: 51200,
		});
	}
	const short = await readDocument(request("trunc.pdf"), converter(call("one\ntwo")).deps);
	assert.equal(short.kind === "page" && short.truncation, undefined);
	const limited = await readDocument(request("trunc.pdf", { limit: 2 }), converter(call(numbered(10))).deps);
	assert.equal(limited.kind === "page" && limited.truncation, undefined, "pi sets none for a user limit");
	const wide = await readDocument(request("trunc.pdf"), converter(call(`${"x".repeat(60_000)}\nend`)).deps);
	assert.equal(wide.kind === "page" && wide.truncation?.firstLineExceedsLimit, true);
});

test("pi's look-alike names are tried in pi's order", async () => {
	// A macOS screenshot name (narrow no-break space before PM) and a curly apostrophe.
	file("Shot 1.02.03\u202FPM.pdf", PDF);
	file("Capture d\u2019\u00e9cran.pdf".normalize("NFD"), PDF);
	const { deps, calls } = converter(call("text"));
	for (const typed of ["Shot 1.02.03 PM.pdf", "Capture d'\u00e9cran.pdf"]) {
		assert.equal((await readDocument(request(typed), deps)).kind, "page", typed);
	}
	// Compared in NFC: on a normalisation-insensitive file system (APFS) the
	// NFC curly variant already exists, exactly as it does for pi.
	assert.deepEqual(
		calls.map((c) => c.normalize("NFC")),
		[join(root, "Shot 1.02.03\u202FPM.pdf"), join(root, "Capture d\u2019\u00e9cran.pdf")],
	);
});
