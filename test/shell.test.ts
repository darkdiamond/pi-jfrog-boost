import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoostCall } from "../src/boost-client.ts";
import {
	bypassesBoost,
	compactShellOutput,
	isWebFetch,
	programName,
	programOf,
	splitSegments,
	words,
} from "../src/shell.ts";

// ---------------------------------------------------------------------------
// Parsing

test("commands split into simple commands on every operator, outside quotes", () => {
	assert.deepEqual(splitSegments("a; b && c || d | e & f\ng"), ["a", "b", "c", "d", "e", "f", "g"]);
	assert.deepEqual(splitSegments("(cd x && make)"), ["cd x", "make"]);
	assert.deepEqual(splitSegments(`echo "a; b" 'c | d'`), [`echo "a; b" 'c | d'`]);
	assert.deepEqual(splitSegments(`echo "say \\"hi; there\\""; ls`), [`echo "say \\"hi; there\\""`, "ls"]);
});

test("words drop quotes and keep Windows backslashes", () => {
	assert.deepEqual(words(`"$HOME/.local/bin/boost" retrieve 3`), ["$HOME/.local/bin/boost", "retrieve", "3"]);
	assert.deepEqual(words(`'C:\\Program Files\\boost.exe' read x`), [
		"C:\\Program Files\\boost.exe",
		"read",
		"x",
	]);
	assert.deepEqual(words(`echo ""`), ["echo", ""]);
});

test("program names ignore directories, .exe and case", () => {
	assert.equal(programName("/usr/local/bin/boost"), "boost");
	assert.equal(programName("C:\\Users\\me\\Boost.EXE"), "boost");
	assert.equal(programName(".\\boost.exe"), "boost");
	assert.equal(programName("boosted"), "boosted");
});

test("the program is found behind assignments and wrappers", () => {
	for (const [segment, program] of [
		["FOO=1 BAR=2 make", "make"],
		["env -i PATH=/bin make", "make"],
		["env -u HOME make", "make"],
		["time -p make", "make"],
		["command make", "make"],
		["exec make", "make"],
		["nice -n 10 make", "make"],
		["nice -5 make", "make"],
		["nohup make", "make"],
		["sudo -u root make", "make"],
		["sudo -E make", "make"],
		[". .\\build.ps1", ".\\build.ps1"],
		["env -- make", "make"],
	] as const) {
		assert.equal(programOf(segment), program, segment);
	}
	assert.equal(programOf("export FOO=1"), undefined);
});

// ---------------------------------------------------------------------------
// The bypass matrix (spec §6.1, acceptance)

test("commands that run boost bypass it, however boost is named", () => {
	for (const command of [
		"boost retrieve 147",
		"boost retrieve 147 --lines 1-40",
		"/Users/me/.local/bin/boost retrieve 3",
		"~/.local/bin/boost retrieve 3",
		`"$HOME/.local/bin/boost" retrieve 3`,
		`'/opt/my tools/boost' read a.pdf`,
		"./boost retrieve 2",
		"env BOOST_DB_PATH=x boost retrieve 3",
		"env -i boost retrieve 3",
		"time boost retrieve 3",
		"sudo boost doctor",
		"sudo -u me boost doctor",
		"nice -n 10 boost report -t",
		"nohup boost sync",
		"command boost retrieve 1",
		"exec boost retrieve 1",
		"FOO=1 boost retrieve 1",
		"npm test | boost",
		"npm test 2>&1 | boost",
		"(cd x && boost retrieve 2)",
		"make; boost retrieve 9",
		"& 'C:\\Users\\me\\AppData\\Local\\boost\\bin\\boost.exe' retrieve 1",
		'& "C:\\boost\\boost.exe" retrieve 1',
		".\\boost.exe retrieve 1",
		"BOOST.EXE retrieve 1",
	]) {
		assert.equal(bypassesBoost(command), true, command);
	}
});

test("DISABLE_BOOST and BOOST_DISABLED bypass it, in every form", () => {
	for (const command of [
		"DISABLE_BOOST=1 diff -u a b",
		"DISABLE_BOOST=true make",
		'DISABLE_BOOST="1" make',
		"DISABLE_BOOST='1' make",
		"BOOST_DISABLED=1 npm test",
		"BOOST_DISABLED=true npm test",
		"make && DISABLE_BOOST=1 cat out.txt",
		"export DISABLE_BOOST=1; npm test",
		"export BOOST_DISABLED=1 && npm test",
		"env DISABLE_BOOST=1 npm test",
		"$env:DISABLE_BOOST=1; Get-Content a.txt",
		'$env:DISABLE_BOOST="1"; npm test',
		"$env:BOOST_DISABLED = 'true'; npm test",
		"$ENV:disable_boost=1; npm test",
	]) {
		assert.equal(bypassesBoost(command), true, command);
	}
});

test("commands that merely mention boost are filtered as usual", () => {
	for (const command of [
		"npm test",
		"grep boost src",
		"grep -rn boost src",
		"rg 'boost retrieve' docs",
		"./boosted",
		"boosted --flag",
		"cat boost.toml",
		"cat ~/.boost/config.toml",
		"echo boost",
		"git log --grep=boost",
		"DISABLE_BOOST=0 ls",
		"DISABLE_BOOST= ls",
		"$env:DISABLE_BOOST=0; ls",
		"$env:DISABLE_BOOST=10; ls",
		"",
		undefined,
		42,
	]) {
		assert.equal(bypassesBoost(command), false, String(command));
	}
});

test("web fetches are recognised behind prefixes and in pipelines", () => {
	for (const command of [
		"curl -s https://example.com",
		"curl.exe -s https://example.com",
		"wget -qO- https://example.com",
		"http GET example.com",
		"https example.com",
		"xh example.com",
		"Invoke-WebRequest https://example.com",
		"iwr https://example.com",
		"Invoke-RestMethod https://api",
		"irm https://api",
		"cd docs && curl -s https://example.com | head -c 9000",
		"time curl https://x",
		"HTTPS_PROXY=x curl https://x",
	]) {
		assert.equal(isWebFetch(command), true, command);
	}
	for (const command of ["cat index.html", "cat curl.txt", "echo curl", "grep wget x", undefined]) {
		assert.equal(isWebFetch(command), false, String(command));
	}
});

// ---------------------------------------------------------------------------
// The filter call (spec §6.2)

const reply = (stdout: string, code: number | null = 0): BoostCall => ({
	code,
	stdout,
	ms: 1,
	timedOut: false,
	aborted: false,
});
const MARKER = "[Boost compressed ~90%. Get the full original output simply with: boost retrieve 147]";
const BODY = Array.from({ length: 200 }, (_, i) => `ok ${i} - case ${i} passes`).join("\n");

test("a meaningful reply replaces the body, pi's notices are put back verbatim", async () => {
	const notices =
		"\n\n[Showing lines 1-200 of 900. Full output: /tmp/pi-bash-1.log]\n\nCommand exited with code 3";
	let sent = "";
	const outcome = await compactShellOutput(`${BODY}${notices}`, async (body) => {
		sent = body;
		return reply(`3 failures\n${MARKER}\n`);
	});
	assert.equal(sent, BODY, "Boost never sees the notices");
	assert.equal(outcome.compaction?.text, `3 failures\n${MARKER}${notices}`);
	assert.equal(outcome.compaction?.retrieveId, 147);
	assert.equal(outcome.compaction?.before, BODY.length + notices.length);
	assert.equal(outcome.compaction?.after, outcome.compaction?.text.length);
});

test("Boost is given the body without terminal escapes", async () => {
	let sent = "";
	await compactShellOutput(`\u001b[32m${BODY}\u001b[0m`, async (body) => {
		sent = body;
		return reply("");
	});
	assert.equal(sent, BODY);
});

test("whitespace-only and sub-threshold changes are not applied", async () => {
	for (const stdout of [`${BODY}\n\n\n`, `${BODY}   `, BODY.slice(0, BODY.length - 200), "", "   \n"]) {
		const outcome = await compactShellOutput(BODY, async () => reply(stdout));
		assert.equal(outcome.compaction, undefined, JSON.stringify(stdout.slice(-20)));
	}
	// Exactly the bar: max(256 B, 5%) of a 5000-byte body is 256 B.
	const body = "x".repeat(5000);
	assert.equal((await compactShellOutput(body, async () => reply("x".repeat(4745)))).compaction, undefined);
	assert.ok((await compactShellOutput(body, async () => reply("x".repeat(4744)))).compaction);
	// 5% of a large body is more than 256 B.
	const large = "y".repeat(100_000);
	assert.equal(
		(await compactShellOutput(large, async () => reply("y".repeat(95_500)))).compaction,
		undefined,
	);
	assert.ok((await compactShellOutput(large, async () => reply("y".repeat(95_000)))).compaction);
});

test("an uncompacted ANSI body is left byte-identical", async () => {
	const coloured = `\u001b[32m${BODY}\u001b[0m\n\nCommand exited with code 1`;
	// Boost echoes the stripped text: nothing saved but the escapes.
	const outcome = await compactShellOutput(coloured, async (body) => reply(body));
	assert.equal(outcome.compaction, undefined, "the original bytes, escapes included, stand");
});

test("a failed or skipped call keeps the original", async () => {
	for (const call of [
		reply("short", 1),
		reply("short", null),
		{ ...reply(""), code: null, skipped: "paused" as const },
		{ ...reply("short"), skipped: "busy" as const },
	]) {
		const outcome = await compactShellOutput(BODY, async () => call);
		assert.equal(outcome.compaction, undefined);
		assert.equal(outcome.call, call, "the call is still reported, for the counters");
	}
});

test("nothing is sent when only notices or escapes remain", async () => {
	let calls = 0;
	const outcome = await compactShellOutput("\u001b[0m\n\nCommand exited with code 1", async () => {
		calls++;
		return reply("x");
	});
	assert.equal(calls, 0);
	assert.deepEqual(outcome, {});
});

test("a reply without a marker has no retrieve id", async () => {
	const outcome = await compactShellOutput(BODY, async () => reply("3 failures\n"));
	assert.equal(outcome.compaction?.text, "3 failures");
	assert.equal(outcome.compaction?.retrieveId, undefined);
	assert.equal("retrieveId" in (outcome.compaction ?? {}), false);
});
