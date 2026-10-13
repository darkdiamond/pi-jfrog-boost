/**
 * The routing table (spec §5), row by row: for every row a case that takes it
 * and a case that just misses it, so a change to one condition shows up as
 * exactly the rows it moved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isShellLike, MAX_ROUTE_BYTES, type Route, type RouteInput, route } from "../src/router.ts";

const big = (bytes = 4096, line = "ok 1 - passes\n") => line.repeat(Math.ceil(bytes / line.length));
const HTML = `<!doctype html>\n<html><body>${"<p>text</p>".repeat(400)}</body></html>`;

function input(over: Partial<RouteInput> = {}): RouteInput {
	return {
		toolName: "bash",
		input: { command: "npm test" },
		text: big(),
		isError: false,
		nested: false,
		off: false,
		ready: true,
		paused: false,
		shellOn: true,
		termsAccepted: true,
		settings: { minBytes: 2048, readLogs: false, documents: true, notebooks: true, extraTools: [] },
		...over,
	};
}

const reason = (r: Route) => (r.kind === "skip" ? r.reason : r.kind);
const settings = (over: Partial<RouteInput["settings"]>) => ({
	minBytes: 2048,
	readLogs: false,
	documents: true,
	notebooks: true,
	extraTools: [] as string[],
	...over,
});

test("the baseline: a large bash result goes down the shell route", () => {
	assert.deepEqual(route(input()), { kind: "shell" });
});

// ---------------------------------------------------------------------------
// Pre-checks, in order

test("pre-check order: nested, off, not-ready, paused, empty", () => {
	const all = { nested: true, off: true, ready: false, paused: true, text: " " };
	assert.equal(reason(route(input(all))), "nested");
	assert.equal(reason(route(input({ ...all, nested: false }))), "off");
	assert.equal(reason(route(input({ ...all, nested: false, off: false }))), "not-ready");
	assert.equal(reason(route(input({ ...all, nested: false, off: false, ready: true }))), "paused");
	assert.equal(
		reason(route(input({ ...all, nested: false, off: false, ready: true, paused: false }))),
		"empty",
	);
});

test("the pre-checks apply to every tool, read and untouched ones included", () => {
	for (const toolName of ["bash", "read", "grep", "mcp__x__y"]) {
		assert.equal(reason(route(input({ toolName, nested: true }))), "nested", toolName);
		assert.equal(reason(route(input({ toolName, off: true }))), "off", toolName);
		assert.equal(reason(route(input({ toolName, text: "" }))), "empty", toolName);
	}
});

// ---------------------------------------------------------------------------
// bash, powershell, extraTools

test("shell rows: bypass", () => {
	assert.equal(reason(route(input({ input: { command: "DISABLE_BOOST=1 npm test" } }))), "bypass");
	assert.equal(reason(route(input({ input: { command: "~/.local/bin/boost retrieve 3" } }))), "bypass");
	assert.equal(reason(route(input({ input: { command: "grep -rn boost src" } }))), "shell");
});

test("shell rows: the shell gate off means no spawn", () => {
	assert.equal(reason(route(input({ shellOn: false }))), "shell-off");
	// The bypass is checked first: it explains more than "shell off" would.
	assert.equal(reason(route(input({ shellOn: false, input: { command: "boost retrieve 1" } }))), "bypass");
});

test("shell rows: an aborted run", () => {
	assert.equal(reason(route(input({ text: `${big()}\n\nCommand aborted`, isError: true }))), "aborted");
	assert.equal(
		reason(route(input({ text: `${big()}\n\nCommand exited with code 1`, isError: true }))),
		"shell",
	);
});

test("shell rows: an HTML document passes only for a web fetch", () => {
	assert.equal(reason(route(input({ text: HTML, input: { command: "cat index.html" } }))), "html");
	for (const command of ["curl -s https://example.com", "wget -qO- https://example.com", "iwr https://x"]) {
		assert.equal(reason(route(input({ text: HTML, input: { command } }))), "shell", command);
	}
	// A fragment is not a document: Boost leaves it alone, so it is not guarded.
	const fragment = `<div>${"<p>text</p>".repeat(400)}</div>`;
	assert.equal(reason(route(input({ text: fragment, input: { command: "cat part.html" } }))), "shell");
});

test("shell rows: binary output is not sent", () => {
	assert.equal(reason(route(input({ text: `${big()}\u0000\u0001` }))), "binary");
});

test("shell rows: the size window is minBytes…1 MiB, measured without pi's notices", () => {
	assert.equal(reason(route(input({ text: "x".repeat(2047) }))), "small");
	assert.equal(reason(route(input({ text: "x".repeat(2048) }))), "shell");
	assert.equal(
		reason(
			route(input({ text: `${"x".repeat(2000)}\n\n[Showing lines 1-5 of 9. Full output: /tmp/a.log]` })),
		),
		"small",
		"the notice does not count towards the body",
	);
	assert.equal(reason(route(input({ text: "x".repeat(MAX_ROUTE_BYTES) }))), "shell");
	assert.equal(reason(route(input({ text: "x".repeat(MAX_ROUTE_BYTES + 1) }))), "large");
	assert.equal(reason(route(input({ text: "x".repeat(100), settings: settings({ minBytes: 0 }) }))), "shell");
});

test("shell rows: a failed command is still routed, so its isError is kept", () => {
	assert.equal(reason(route(input({ isError: true }))), "shell");
});

test("powershell routes like bash", () => {
	assert.equal(reason(route(input({ toolName: "powershell", input: { command: "npm test" } }))), "shell");
	assert.equal(
		reason(route(input({ toolName: "powershell", input: { command: "$env:DISABLE_BOOST=1; npm test" } }))),
		"bypass",
	);
});

test("extraTools route like bash; read, edit and write never do", () => {
	const extra = settings({ extraTools: ["fetch", "grep", "read", "edit", "write"] });
	assert.equal(reason(route(input({ toolName: "fetch", input: { url: "x" }, settings: extra }))), "shell");
	assert.equal(reason(route(input({ toolName: "grep", input: { pattern: "x" }, settings: extra }))), "shell");
	assert.equal(reason(route(input({ toolName: "fetch", input: { url: "x" } }))), "untouched");
	assert.equal(reason(route(input({ toolName: "read", input: { path: "a.ts" }, settings: extra }))), "exact");
	assert.equal(reason(route(input({ toolName: "edit", settings: extra }))), "untouched");
	assert.equal(isShellLike("write", ["write"]), false);
});

test("an extraTools fetch tool without a command may return a whole page", () => {
	const extra = settings({ extraTools: ["fetch", "runner"] });
	assert.equal(
		reason(route(input({ toolName: "fetch", input: { url: "x" }, text: HTML, settings: extra }))),
		"shell",
	);
	// …but one that runs a command is held to the command rule.
	assert.equal(
		reason(
			route(input({ toolName: "runner", input: { command: "cat a.html" }, text: HTML, settings: extra })),
		),
		"html",
	);
});

// ---------------------------------------------------------------------------
// read

const read = (over: Partial<RouteInput> = {}) =>
	input({ toolName: "read", input: { path: "/var/log/app.log" }, ...over });
const logsOn = settings({ readLogs: true });

test("read: a refused read is never routed", () => {
	assert.equal(reason(route(read({ isError: true, settings: logsOn }))), "error");
	assert.equal(reason(route(read({ isError: true, input: { path: "a.pdf" } }))), "error");
});

test("read: text files are exact — source, JSON, Markdown, HTML, CSV, SVG", () => {
	for (const path of ["src/a.ts", "data.json", "README.md", "index.html", "t.csv", "logo.svg", "Makefile"]) {
		assert.equal(reason(route(read({ input: { path }, settings: logsOn }))), "exact", path);
	}
	assert.equal(reason(route(read({ input: { path: "index.html" }, text: HTML }))), "exact");
});

test("read: PDF, Office and OpenDocument files take the document route", () => {
	for (const path of ["q3.pdf", "a.docx", "b.XLSX", "c.pptx", "d.odt", "e.ods", "f.odp"]) {
		assert.deepEqual(route(read({ input: { path }, text: "%PDF\u0000\u0001" })), { kind: "document" }, path);
	}
	// Whatever pi's text looks like: its "line too long" notice for a stored
	// zip, or a page of plain XML past the zip header. The file's magic number
	// decides (documents.ts), not pi's rendering of it.
	const longLine = "[Line 1 is 120.2KB, exceeds 50.0KB limit. Use bash: sed -n '1p' a.docx | head -c 51200]";
	assert.equal(reason(route(read({ input: { path: "a.docx" }, text: longLine }))), "document");
	assert.equal(
		reason(route(read({ input: { path: "a.docx", offset: 3 }, text: "<w:p>x</w:p>" }))),
		"document",
	);
	// Partial reads too: a converted document is paged like any read.
	assert.equal(reason(route(read({ input: { path: "q3.pdf", offset: 2001, limit: 50 } }))), "document");
});

test("read: legacy Office files take the document route (for Boost's advisory)", () => {
	for (const path of ["a.doc", "b.xls", "c.PPT"]) {
		assert.equal(
			reason(route(read({ input: { path }, text: "\u00d0\u00cf\u0011\u00e0\u0000" }))),
			"document",
		);
	}
});

test("read: documents need the setting and the Preview Agreement", () => {
	const off = settings({ documents: false });
	assert.equal(reason(route(read({ input: { path: "q3.pdf" }, settings: off }))), "exact");
	assert.equal(reason(route(read({ input: { path: "n.ipynb" }, settings: off }))), "exact");
	assert.equal(reason(route(read({ input: { path: "q3.pdf" }, termsAccepted: false }))), "terms");
	assert.equal(reason(route(read({ input: { path: "a.doc" }, termsAccepted: false }))), "terms");
});

test("read: notebooks are converted only on a whole read with `notebooks` on", () => {
	assert.equal(reason(route(read({ input: { path: "n.ipynb" } }))), "document");
	assert.equal(reason(route(read({ input: { path: "n.ipynb", offset: 1 } }))), "exact");
	assert.equal(reason(route(read({ input: { path: "n.ipynb", limit: 10 } }))), "exact");
	assert.equal(
		reason(route(read({ input: { path: "n.ipynb" }, settings: settings({ notebooks: false }) }))),
		"exact",
	);
});

test("read: CSV, RTF and HTML are never converted", () => {
	for (const path of ["t.csv", "a.rtf", "index.html", "page.htm"]) {
		assert.equal(reason(route(read({ input: { path }, text: "\u0000binary" }))), "exact", path);
	}
});

test("read: a refused document read never reaches Boost, except an offset past the raw bytes", () => {
	for (const text of ["ENOENT: no such file or directory, access '/a/q3.pdf'", "EACCES: permission denied"]) {
		assert.equal(reason(route(read({ isError: true, input: { path: "q3.pdf" }, text }))), "error", text);
	}
	const pastEnd = "Offset 1249 is beyond end of file (4 lines total)";
	assert.equal(
		reason(route(read({ isError: true, input: { path: "a.docx", offset: 1249 }, text: pastEnd }))),
		"document",
	);
	assert.equal(
		reason(route(read({ isError: true, input: { path: "a.doc", offset: 9 }, text: pastEnd }))),
		"document",
	);
	// Not without an offset (pi cannot say it then), not for notebooks (only
	// whole reads convert), and not for any other file.
	assert.equal(reason(route(read({ isError: true, input: { path: "a.docx" }, text: pastEnd }))), "error");
	assert.equal(
		reason(route(read({ isError: true, input: { path: "n.ipynb", offset: 9 }, text: pastEnd }))),
		"error",
	);
	assert.equal(
		reason(route(read({ isError: true, input: { path: "a.txt", offset: 9 }, text: pastEnd }))),
		"error",
	);
	assert.equal(
		reason(route(read({ isError: true, input: { path: "a.docx", offset: 9 }, text: `${pastEnd} and more` }))),
		"error",
	);
});

test("read: logs are opt-in", () => {
	assert.equal(reason(route(read())), "exact", "readLogs is off by default");
	assert.equal(reason(route(read({ settings: logsOn }))), "log");
	assert.equal(reason(route(read({ input: { path: "build.OUT" }, settings: logsOn }))), "log");
});

test("read: only whole reads of a log are routed", () => {
	assert.equal(reason(route(read({ input: { path: "a.log", offset: 10 }, settings: logsOn }))), "exact");
	assert.equal(reason(route(read({ input: { path: "a.log", limit: 100 }, settings: logsOn }))), "exact");
	// pi's own continuation notice does not make it partial: the model asked for the whole file.
	const paged = `${big()}\n\n[Showing lines 1-2000 of 9000. Use offset=2001 to continue.]`;
	assert.equal(reason(route(read({ text: paged, settings: logsOn }))), "log");
});

test("read: a log needs the size window, no HTML and the shell gate", () => {
	assert.equal(reason(route(read({ text: "x".repeat(100), settings: logsOn }))), "small");
	assert.equal(reason(route(read({ text: "x".repeat(MAX_ROUTE_BYTES + 1), settings: logsOn }))), "large");
	assert.equal(reason(route(read({ text: HTML, settings: logsOn }))), "html");
	assert.equal(reason(route(read({ text: `\u001b[2m${HTML}`, settings: logsOn }))), "html");
	assert.equal(reason(route(read({ shellOn: false, settings: logsOn }))), "shell-off");
	assert.equal(reason(route(read({ text: `${big()}\u0000`, settings: logsOn }))), "binary");
});

test("read: a path that is not a string is exact", () => {
	assert.equal(reason(route(read({ input: {}, settings: logsOn }))), "exact");
});

// ---------------------------------------------------------------------------
// everything else

test("grep, find, ls, edit, write and other tools are untouched", () => {
	for (const toolName of ["grep", "find", "ls", "edit", "write", "todo", "constructor"]) {
		assert.equal(
			reason(route(input({ toolName, input: { pattern: "x", path: "." } }))),
			"untouched",
			toolName,
		);
	}
});

test("MCP results are untouched until their route lands (WP5)", () => {
	assert.equal(reason(route(input({ toolName: "mcp__slack__slack_get_users", input: {} }))), "untouched");
});

test("shell rows: a coloured HTML document is still an HTML document", () => {
	// Boost is sent the text without escapes, so it would still see — and
	// convert — the page behind `pygmentize`'s or `bat`'s colouring.
	const coloured = `\u001b[38;5;12m${HTML}`;
	for (const command of ["cat index.html", "pygmentize index.html", "bat --color=always index.html"]) {
		assert.equal(reason(route(input({ text: coloured, input: { command } }))), "html", command);
	}
	assert.equal(reason(route(input({ text: coloured, input: { command: "curl https://x" } }))), "shell");
});
