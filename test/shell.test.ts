import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { BoostCall } from "../src/boost-client.ts";
import {
	bypassesBoost,
	compactFullOutput,
	compactShellOutput,
	FULL_OUTPUT_MAX_BYTES,
	fullOutputNoticeIndex,
	fullOutputPathOf,
	isWebFetch,
	programName,
	programOf,
	readFullOutputFile,
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
		["timeout 30 make", "make"],
		["timeout -s KILL -k 5 30s make", "make"],
		["timeout --signal=TERM 1m make", "make"],
		["timeout -- 30 make", "make"],
		["xargs make", "make"],
		["xargs -n 1 -P 4 make", "make"],
		["xargs -I{} make {}", "make"],
		["stdbuf -oL make", "make"],
		["stdbuf -o L make", "make"],
		["ionice -c 3 make", "make"],
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
		"timeout 30 boost retrieve 3",
		"timeout -k 5 30s boost retrieve 3",
		"echo 3 | xargs boost retrieve",
		"xargs -n 1 boost retrieve < ids",
		"stdbuf -oL boost retrieve 3",
		"ionice -c 3 boost sync",
		"bash -c 'boost retrieve 3'",
		'sh -c "cd x && boost retrieve 3"',
		"bash -lc 'boost retrieve 3'",
		"zsh -ec 'make; boost retrieve 3'",
		"bash -c \"sh -c 'boost retrieve 3'\"",
		"pwsh -Command boost retrieve 3",
		"powershell -c \"& 'C:\\boost\\boost.exe' retrieve 1\"",
		"cmd /c boost.exe retrieve 1",
		'echo "$(boost retrieve 3)"',
		"echo $(boost retrieve 3)",
		'echo "$(cd x && boost retrieve 3)"',
		"x=$(boost retrieve 3); echo $x",
		"`boost retrieve 3`",
		'echo "`boost retrieve 3`"',
		"echo $(cat $(boost retrieve 3))",
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
		"timeout 30 make",
		"timeout 30 ./boosted",
		"xargs grep boost",
		"bash -c 'grep -rn boost src'",
		"bash script.sh boost",
		"sh -x run.sh",
		'echo "$(git log --grep=boost)"',
		"echo `cat boost.toml`",
		"pwsh -File boost.ps1",
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

// ---------------------------------------------------------------------------
// The full-output re-filter (spec §6.3)

/** A directory under the temp directory pi writes to, as pi's own files are. */
const TMP = mkdtempSync(join(tmpdir(), "jfrog-boost-full-"));
/**
 * For the containment tests, pi's temp directory is narrowed to one
 * subdirectory, so a sibling is "outside" it without writing anywhere but
 * the real temp directory.
 */
const PI_TMP = mkdtempSync(join(TMP, "pi-"));
const OUTSIDE = mkdtempSync(join(TMP, "outside-"));
const narrowed = { tmpdir: () => PI_TMP };
after(() => rmSync(TMP, { recursive: true, force: true }));

let fileId = 0;
function saved(text: string, dir = TMP): string {
	const path = join(dir, `pi-bash-${(++fileId).toString(16).padStart(16, "0")}.log`);
	writeFileSync(path, text);
	return path;
}

/** A 9000-line TAP run whose failures come first, as pi's tail would hide them. */
const FAILURES = ["not ok 1 - case 0 fails", "not ok 2 - case 1 fails"];
const FULL_RUN = [
	"TAP version 13",
	...FAILURES,
	...Array.from({ length: 8996 }, (_, i) => `ok ${i + 3} - case ${i + 2} passes`),
	"1..8998",
].join("\n");
const TAIL = FULL_RUN.split("\n").slice(-2000).join("\n");

/** pi's truncated bash result for a run saved at `path`, with its exit status. */
const truncated = (path: string, exit = "\n\nCommand exited with code 1") =>
	`${TAIL}\n\n[Showing lines 7001-9000 of 9000. Full output: ${path}]${exit}`;

/** A filter that records what it was sent and answers by the input. */
function recorder(answer: (body: string) => BoostCall) {
	const sent: string[] = [];
	return {
		sent,
		filter: async (body: string) => {
			sent.push(body);
			return answer(body);
		},
	};
}
const SUMMARY = `${FAILURES.join("\n")}\n# pass 8996\n# fail 2\n${MARKER}`;

test("the full-output path is found in structuredContent or details", () => {
	assert.equal(fullOutputPathOf({ full_output_path: "/tmp/a.log" }, undefined), "/tmp/a.log");
	assert.equal(fullOutputPathOf(undefined, { fullOutputPath: "/tmp/b.log" }), "/tmp/b.log");
	// pi 1.x sets both to the same file; structuredContent is the schema'd one.
	assert.equal(
		fullOutputPathOf({ full_output_path: "/tmp/a.log" }, { fullOutputPath: "/tmp/b.log" }),
		"/tmp/a.log",
	);
	for (const [structured, details] of [
		[undefined, undefined],
		[{ exitCode: 0 }, { truncation: {} }],
		[{ full_output_path: "" }, { fullOutputPath: 7 }],
		["text", ["/tmp/a.log"]],
	]) {
		assert.equal(fullOutputPathOf(structured, details), undefined, JSON.stringify([structured, details]));
	}
});

test("only pi's notice naming exactly that file counts as a truncation", () => {
	const notices =
		"\n\n[Showing lines 7001-9000 of 9000. Full output: /tmp/pi-bash-1.log]\n\nCommand exited with code 1";
	assert.equal(fullOutputNoticeIndex(notices, "/tmp/pi-bash-1.log"), 1);
	assert.equal(
		fullOutputNoticeIndex(
			"\n\n[Showing last 50.0KB of line 1 (line is 1.2MB). Full output: /t/x.log]",
			"/t/x.log",
		),
		1,
	);
	assert.equal(fullOutputNoticeIndex(notices, "/tmp/pi-bash-1"), -1, "a prefix of the path is not the path");
	assert.equal(fullOutputNoticeIndex(notices, "/tmp/other.log"), -1);
	assert.equal(fullOutputNoticeIndex("\n\nCommand exited with code 1", "/tmp/pi-bash-1.log"), -1);
});

test("the whole run is filtered and pi's notice is rewritten; the exit status stays", async () => {
	const path = saved(FULL_RUN);
	const text = truncated(path);
	const boost = recorder(() => reply(`${SUMMARY}\n`));
	const outcome = await compactFullOutput({ text, path, htmlAllowed: false }, boost.filter);
	assert.deepEqual(boost.sent, [FULL_RUN], "Boost was sent the whole run, once");
	assert.equal(
		outcome.compaction?.text,
		`${SUMMARY}\n\n[Boost compacted the full 9000-line output. Full output: ${path}]\n\nCommand exited with code 1`,
	);
	assert.match(
		outcome.compaction?.text ?? "",
		/^not ok 1 - case 0 fails$/m,
		"the failures pi's tail dropped",
	);
	assert.equal(outcome.compaction?.full, true);
	assert.equal(outcome.compaction?.retrieveId, 147);
	assert.equal(outcome.compaction?.before, text.length);
	assert.equal(outcome.fullSkipped, undefined);
});

test("terminal escapes are stripped from the file before Boost sees it", async () => {
	const path = saved(`\u001b[31m${FULL_RUN}\u001b[0m\n`);
	const boost = recorder(() => reply(SUMMARY));
	const outcome = await compactFullOutput({ text: truncated(path), path, htmlAllowed: false }, boost.filter);
	assert.deepEqual(boost.sent, [`${FULL_RUN}\n`]);
	assert.match(outcome.compaction?.text ?? "", /full 9000-line output/, "a final newline is no extra line");
});

test("a reply over pi's page falls back to the tail route in the same call", async () => {
	const path = saved(FULL_RUN);
	const text = truncated(path);
	for (const long of [
		Array.from({ length: 2001 }, (_, i) => `k${i}`).join("\n"), // over 2000 lines
		"z".repeat(50 * 1024 + 1), // over 50 KiB
	]) {
		const boost = recorder((body) => (body === FULL_RUN ? reply(long) : reply("tail summary\n")));
		const outcome = await compactFullOutput({ text, path, htmlAllowed: false }, boost.filter);
		assert.equal(boost.sent.length, 2);
		assert.equal(boost.sent[1], TAIL, "the tail route sends pi's tail without its notices");
		assert.equal(outcome.fullSkipped, "unfit");
		assert.equal(outcome.fullCall?.stdout, long);
		assert.equal(
			outcome.compaction?.text,
			`tail summary\n\n[Showing lines 7001-9000 of 9000. Full output: ${path}]\n\nCommand exited with code 1`,
			"pi's own notice is kept on the tail",
		);
		assert.equal(outcome.compaction?.full, undefined);
	}
});

test("a reply that is no meaningful reduction of the whole run falls back to the tail", async () => {
	const path = saved(FULL_RUN);
	const boost = recorder((body) => reply(body === FULL_RUN ? FULL_RUN.slice(0, -100) : body));
	const outcome = await compactFullOutput({ text: truncated(path), path, htmlAllowed: false }, boost.filter);
	assert.equal(boost.sent.length, 2);
	assert.equal(outcome.fullSkipped, "unfit");
	assert.equal(outcome.compaction, undefined, "the tail echo is not applied either");
});

test("a missing or unusable file falls back to the tail, which Boost sees as usual", async () => {
	const missing = join(TMP, "pi-bash-gone.log");
	const dir = mkdtempSync(join(TMP, "dir-"));
	const empty = saved("\u001b[0m\n");
	const binary = saved(`${FULL_RUN}\0`);
	for (const path of [missing, dir, empty, binary, "relative/pi-bash-1.log"]) {
		const boost = recorder(() => reply("tail summary"));
		const outcome = await compactFullOutput(
			{ text: truncated(path), path, htmlAllowed: false },
			boost.filter,
		);
		assert.deepEqual(boost.sent, [TAIL], path);
		assert.equal(outcome.fullSkipped, "unreadable", path);
		assert.match(outcome.compaction?.text ?? "", /^tail summary\n\n\[Showing lines/, path);
	}
});

test("a path outside the temp directory is never read, even through a link", async () => {
	const outside = saved(FULL_RUN, OUTSIDE);
	const link = join(PI_TMP, "pi-bash-link.log");
	symlinkSync(outside, link);
	// `<pi tmp>/../outside-…/x.log` is spelled under the temp directory but is not in it.
	const dotted = `${PI_TMP}/../${outside.slice(TMP.length + 1)}`;
	for (const path of [outside, link, dotted]) {
		assert.equal(await readFullOutputFile(path, narrowed), undefined, path);
		const boost = recorder(() => reply("tail summary"));
		const outcome = await compactFullOutput(
			{ text: truncated(path), path, htmlAllowed: false },
			boost.filter,
			narrowed,
		);
		assert.deepEqual(boost.sent, [TAIL], "only the tail reached Boost");
		assert.equal(outcome.fullSkipped, "unreadable");
	}
	// A file that is in the temp directory is read.
	assert.equal(await readFullOutputFile(saved(FULL_RUN, PI_TMP), narrowed), FULL_RUN);
});

test("a file over 2 MiB is not read", async () => {
	const line = "ok 1 - case passes\n";
	const fits = saved(line.repeat(Math.floor(FULL_OUTPUT_MAX_BYTES / line.length)));
	assert.ok(await readFullOutputFile(fits));
	const over = saved("x".repeat(FULL_OUTPUT_MAX_BYTES + 1));
	assert.equal(await readFullOutputFile(over), undefined);
	const boost = recorder(() => reply("tail summary"));
	const outcome = await compactFullOutput(
		{ text: truncated(over), path: over, htmlAllowed: false },
		boost.filter,
	);
	assert.deepEqual(boost.sent, [TAIL]);
	assert.equal(outcome.fullSkipped, "unreadable");
});

test("a file owned by another user is not read", async () => {
	const path = saved(FULL_RUN);
	const stat = () => ({ isFile: () => true, size: 10, uid: 4242 });
	assert.equal(await readFullOutputFile(path, { stat, uid: () => 501 }), undefined);
	assert.equal(
		await readFullOutputFile(path, { stat, uid: () => undefined }),
		FULL_RUN,
		"no user ids (Windows)",
	);
});

test("a whole HTML page in the full run keeps the tail route unless it was fetched", async () => {
	const page = `<!doctype html>\n<html><body>\n${"<p>text</p>\n".repeat(9000)}</body></html>`;
	const path = saved(page);
	const text = truncated(path, "");
	const kept = recorder(() => reply("tail summary"));
	const outcome = await compactFullOutput({ text, path, htmlAllowed: false }, kept.filter);
	assert.equal(kept.sent.length, 1);
	assert.notEqual(kept.sent[0], page, "the page itself never went to Boost");
	assert.equal(outcome.fullSkipped, "html");
	const fetched = recorder(() => reply("Article text"));
	const article = await compactFullOutput({ text, path, htmlAllowed: true }, fetched.filter);
	assert.deepEqual(fetched.sent, [page]);
	assert.match(
		article.compaction?.text ?? "",
		/^Article text\n\n\[Boost compacted the full 9003-line output/,
	);
});

test("a failed full call keeps the original instead of calling Boost again", async () => {
	const path = saved(FULL_RUN);
	for (const call of [
		reply("x", 1),
		{ ...reply(""), code: null, timedOut: true },
		{ ...reply(""), code: null, aborted: true },
		{ ...reply(""), code: null, skipped: "paused" as const },
		{ ...reply("x"), skipped: "busy" as const },
	]) {
		const boost = recorder(() => call);
		const outcome = await compactFullOutput(
			{ text: truncated(path), path, htmlAllowed: false },
			boost.filter,
		);
		assert.equal(boost.sent.length, 1, JSON.stringify(call));
		assert.equal(outcome.compaction, undefined);
		assert.equal(outcome.call, call);
		assert.equal(outcome.fullSkipped, undefined);
	}
});

test("a result that does not name the file in pi's notice keeps the tail route", async () => {
	const path = saved(FULL_RUN);
	const boost = recorder(() => reply("tail summary"));
	const outcome = await compactFullOutput(
		{ text: `${TAIL}\n\nCommand exited with code 1`, path, htmlAllowed: false },
		boost.filter,
	);
	assert.deepEqual(boost.sent, [TAIL]);
	assert.equal(outcome.fullSkipped, "unreadable");
});
