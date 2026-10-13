import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	BINARY_DOCS,
	equivalentCommand,
	extensionOf,
	isShell,
	LEGACY_OFFICE,
	normalizeWindowsShellPath,
	readPathCandidates,
	resolveReadPath,
	shellQuote,
} from "../src/tools.ts";

test("only bash and powershell are shells", () => {
	assert.equal(isShell("bash"), true);
	assert.equal(isShell("powershell"), true);
	for (const tool of ["read", "grep", "edit", "constructor", "toString"])
		assert.equal(isShell(tool), false, tool);
});

test("shell tools are described to Boost by their own command", () => {
	assert.equal(equivalentCommand("bash", { command: "npm test" }), "npm test");
	assert.equal(equivalentCommand("powershell", { command: "Get-ChildItem" }), "Get-ChildItem");
	assert.equal(equivalentCommand("fetch", { command: "x" }), "x", "an extraTools tool with a command");
	assert.equal(equivalentCommand("bash", {}), undefined);
	assert.equal(equivalentCommand("fetch", { url: "x" }), undefined);
});

test("a whole log read is described as `cat <abs>`", () => {
	assert.equal(equivalentCommand("read", { path: "a.log" }, "/work/a.log"), "cat /work/a.log");
	assert.equal(equivalentCommand("read", { path: "x" }, "/work/my app.log"), "cat '/work/my app.log'");
	assert.equal(equivalentCommand("read", { path: "a.log" }), undefined, "no absolute path, no command");
});

test("arguments that could change a command's meaning are quoted", () => {
	assert.equal(shellQuote("/tmp/a; rm -rf ~"), "'/tmp/a; rm -rf ~'");
	assert.equal(shellQuote("it's"), `'it'\\''s'`);
	assert.equal(shellQuote("/plain/path-1.log"), "/plain/path-1.log");
});

test("read paths resolve the way pi's read resolves them", () => {
	const cwd = resolve("/work/project");
	const home = resolve("/home/me");
	assert.equal(resolveReadPath("logs/a.log", cwd, home), join(cwd, "logs", "a.log"));
	assert.equal(resolveReadPath("@logs/a.log", cwd, home), join(cwd, "logs", "a.log"));
	assert.equal(resolveReadPath("~/a.log", cwd, home), join(home, "a.log"));
	assert.equal(resolveReadPath("~", cwd, home), home);
	assert.equal(resolveReadPath(resolve("/var/log/a.log"), cwd, home), resolve("/var/log/a.log"));
	// pi normalises Unicode spaces before anything else (`@` included).
	assert.equal(resolveReadPath("@my\u00a0file.pdf", cwd, home), join(cwd, "my file.pdf"));
	assert.equal(resolveReadPath("a\u202Fb.pdf", cwd, home), join(cwd, "a b.pdf"));
	const abs = resolve("/var/docs/q3.pdf");
	assert.equal(resolveReadPath(pathToFileURL(abs).href, cwd, home), abs);
});

test("`~\\` is the home directory on win32 only; elsewhere it is a file name", () => {
	const cwd = resolve("/work/project");
	const home = resolve("/home/me");
	assert.equal(resolveReadPath("~\\a.pdf", cwd, home, "linux"), join(cwd, "~\\a.pdf"));
	assert.equal(resolveReadPath("~\\a.pdf", cwd, home, "darwin"), join(cwd, "~\\a.pdf"));
	assert.equal(resolveReadPath("~\\a.pdf", cwd, home, "win32"), join(home, "a.pdf"));
});

test("MSYS, Cygwin and WSL drive paths become Windows paths, as pi does on win32", () => {
	assert.equal(normalizeWindowsShellPath("/c/Users/x/doc.pdf"), "C:\\Users\\x\\doc.pdf");
	assert.equal(normalizeWindowsShellPath("/mnt/d/a.pdf"), "D:\\a.pdf");
	assert.equal(normalizeWindowsShellPath("/cygdrive/e"), "E:\\");
	for (const unchanged of ["/usr/lib/a.pdf", "//server/share", "rel/a.pdf", "/c\\x"]) {
		assert.equal(normalizeWindowsShellPath(unchanged), unchanged);
	}
	const cwd = resolve("/work/project");
	assert.equal(resolveReadPath("/c/x.pdf", cwd, "/h", "linux"), resolve("/c/x.pdf"), "not off win32");
});

test("the look-alike names pi tries, in pi's order, without duplicates", () => {
	assert.deepEqual(readPathCandidates("/a/plain.pdf"), ["/a/plain.pdf"]);
	assert.deepEqual(readPathCandidates("/a/Shot 1.02 PM.pdf"), [
		"/a/Shot 1.02 PM.pdf",
		"/a/Shot 1.02\u202FPM.pdf",
	]);
	const typed = "/a/d'\u00e9cran.pdf";
	const nfd = typed.normalize("NFD");
	assert.deepEqual(readPathCandidates(typed), [
		typed,
		nfd,
		"/a/d\u2019\u00e9cran.pdf",
		nfd.replace("'", "\u2019"),
	]);
});

test("extensions are lower-cased, and dotfiles have none", () => {
	assert.equal(extensionOf("/a/Report.PDF"), ".pdf");
	assert.equal(extensionOf("C:\\logs\\build.out"), ".out");
	assert.equal(extensionOf(".bashrc"), "");
	assert.equal(extensionOf("Makefile"), "");
	assert.equal(extensionOf("dir.d/file"), "");
	assert.equal(extensionOf(undefined), "");
});

test("the document tables match the spec: no CSV, RTF or HTML", () => {
	assert.deepEqual([...BINARY_DOCS].sort(), [".docx", ".odp", ".ods", ".odt", ".pdf", ".pptx", ".xlsx"]);
	assert.deepEqual([...LEGACY_OFFICE].sort(), [".doc", ".ppt", ".xls"]);
});
