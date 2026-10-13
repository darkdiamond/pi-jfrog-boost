import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	BINARY_DOCS,
	equivalentCommand,
	extensionOf,
	isShell,
	LEGACY_OFFICE,
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
