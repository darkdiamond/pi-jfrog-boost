import assert from "node:assert/strict";
import { test } from "node:test";
import { bypassesBoost, equivalentCommand, isDocument, isFiltered } from "../src/tools.ts";

test("every tool whose output can be noisy is filtered", () => {
	for (const tool of ["bash", "powershell", "read", "grep", "find", "ls"]) {
		assert.equal(isFiltered(tool), true, tool);
	}
});

test("tools pi already summarises are left alone", () => {
	for (const tool of ["edit", "write", "unknown_extension_tool"]) {
		assert.equal(isFiltered(tool), false, tool);
	}
});

test("isFiltered does not inherit from Object.prototype", () => {
	assert.equal(isFiltered("constructor"), false);
	assert.equal(isFiltered("toString"), false);
});

test("shell tools are described to Boost by their own command", () => {
	assert.equal(equivalentCommand("bash", { command: "npm test" }), "npm test");
	assert.equal(equivalentCommand("powershell", { command: "Get-ChildItem" }), "Get-ChildItem");
	assert.equal(equivalentCommand("bash", {}), undefined);
});

test("in-process tools are described as the command they stand in for", () => {
	assert.equal(equivalentCommand("read", { path: "/tmp/a.txt" }), "cat /tmp/a.txt");
	assert.equal(equivalentCommand("ls", { path: "/usr/lib" }), "ls -la /usr/lib");
	assert.equal(equivalentCommand("find", { pattern: "*.ts", path: "src" }), "find src -name '*.ts'");
	assert.equal(equivalentCommand("grep", { pattern: "TODO" }), "grep -rn TODO .");
	assert.equal(equivalentCommand("edit", { path: "/tmp/a" }), undefined);
});

test("arguments that could change a command's meaning are quoted", () => {
	assert.equal(equivalentCommand("ls", { path: "/tmp/a; rm -rf ~" }), "ls -la '/tmp/a; rm -rf ~'");
});

test("a quote in an argument cannot close the quoting", () => {
	assert.equal(equivalentCommand("grep", { pattern: "it's", path: "." }), `grep -rn 'it'\\''s' .`);
});

test("pi's grep options carry over to the equivalent command", () => {
	assert.equal(
		equivalentCommand("grep", {
			pattern: "todo",
			path: "src",
			ignoreCase: true,
			literal: true,
			glob: "*.ts",
		}),
		"grep -rniF --include='*.ts' todo src",
	);
});

test("commands that opt out or already run Boost bypass the filter", () => {
	for (const command of [
		"DISABLE_BOOST=1 diff -u a b",
		"make && DISABLE_BOOST=1 cat out.txt",
		"$env:DISABLE_BOOST=1; Get-Content a.txt",
		"boost retrieve 12 --query timeout",
		"npm test | boost",
	]) {
		assert.equal(bypassesBoost(command), true, command);
	}
});

test("ordinary commands, including ones that mention boost, are filtered", () => {
	for (const command of [
		"npm test",
		"grep -rn boost src",
		"cat boost.toml",
		"DISABLE_BOOST=0 ls",
		undefined,
	]) {
		assert.equal(bypassesBoost(command), false, String(command));
	}
});

test("documents Boost can convert are recognised, case-insensitively", () => {
	for (const path of ["/a/report.pdf", "b.DOCX", "./sheet.xlsx", "page.html"]) {
		assert.equal(isDocument(path), true, path);
	}
});

test("source files and non-strings are not documents", () => {
	for (const path of ["index.ts", "README.md", "noextension", ".pdfrc", "", undefined, 42]) {
		assert.equal(isDocument(path), false, String(path));
	}
});
