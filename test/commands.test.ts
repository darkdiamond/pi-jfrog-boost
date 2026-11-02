/**
 * The `/boost` hub (spec §10.2), driven through the pi stub with a scripted
 * UI and without one: completions, every subcommand, the settings loop and
 * its atomic saves, and the alias. Boost itself is a stub client, so what is
 * asserted is what the commands ask of it (`report -t`, never `report`).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BoostCall } from "../src/boost-client.ts";
import { completions, OBSERVE_CONFIRM, SUBCOMMANDS } from "../src/commands.ts";
import { type Breaker, createBreaker, type Readiness, type ReadinessState } from "../src/health.ts";
import { createBoostExtension, createNotices } from "../src/index.ts";
import { INSTALL_OPTIONS } from "../src/install.ts";
import { createSettingsStore, SESSION_TOGGLE_ENTRY, type SettingsFs, settingsPath } from "../src/settings.ts";
import { MISSING_NOTICE, shellOffNotice } from "../src/status.ts";
import { createPiStub, type PiStubOptions } from "./helpers/harness.ts";
import { call, fixedConfig, fixedReadiness, memoryFs, stubClient } from "./helpers/runtime.ts";

const CLI_OFF = `[feature_flags."boost-cli-filtering"]\nuser = false\n`;
const HOME = "/fake/home";
const SETTINGS = settingsPath({}, HOME);

/** A settings fs that records every operation, to prove saves are atomic and stay in their file. */
function recordingFs(initial?: Record<string, unknown>) {
	const mem = memoryFs();
	if (initial) mem.files.set(SETTINGS, JSON.stringify(initial));
	const ops: string[] = [];
	const fs: SettingsFs = {
		readFileSync: (path, enc) => {
			ops.push(`read ${path}`);
			return mem.readFileSync(path, enc);
		},
		writeFileSync: (path, data, options) => {
			ops.push(`write ${path}`);
			mem.writeFileSync(path, data, options);
		},
		renameSync: (from, to) => {
			ops.push(`rename ${from} -> ${to}`);
			mem.renameSync(from, to);
		},
		mkdirSync: (path, options) => {
			ops.push(`mkdir ${path}`);
			return mem.mkdirSync(path, options);
		},
		rmSync: (path, options) => {
			ops.push(`rm ${path}`);
			mem.rmSync(path, options);
		},
	};
	const file = () => JSON.parse(mem.files.get(SETTINGS) ?? "{}") as Record<string, unknown>;
	return { fs, ops, file, files: mem.files };
}

interface Options extends PiStubOptions {
	state?: ReadinessState;
	binary?: string | undefined;
	env?: NodeJS.ProcessEnv;
	file?: Record<string, unknown>;
	/** What `boost <args>` (report, doctor) answers. */
	boostExec?: (args: string[], cwd: string, timeoutMs: number) => Promise<BoostCall>;
	readiness?: Readiness;
	/** Let the extension build its own readiness (the production path) over the stub client. */
	realReadiness?: boolean;
	breaker?: Breaker;
	config?: string;
}

function setup(options: Options = {}) {
	const stub = createPiStub(options);
	const env = options.env ?? {};
	const rec = recordingFs(options.file);
	const settings = createSettingsStore({
		env,
		home: () => HOME,
		fs: rec.fs,
		flag: () => stub.flagValues.get("no-boost"),
	});
	const execCalls: { args: string[]; cwd: string; timeoutMs: number }[] = [];
	const binary = "binary" in options ? options.binary : "/fake/boost";
	// Not fixedReadiness(state, binary): its default parameter would turn an
	// explicit `undefined` (Boost missing) back into "/fake/boost".
	const readiness = options.readiness ?? { ...fixedReadiness(options.state), binary: () => binary };
	const printed: string[] = [];
	createBoostExtension(stub.pi, {
		client: stubClient({
			binary: () => binary,
			exec: async (args, cwd, timeoutMs = 30_000) => {
				execCalls.push({ args, cwd, timeoutMs });
				return options.boostExec ? options.boostExec(args, cwd, timeoutMs) : call("ok\n");
			},
		}),
		env,
		settings,
		config: fixedConfig(options.config ?? CLI_OFF),
		...(options.realReadiness ? {} : { readiness }),
		...(options.breaker ? { breaker: options.breaker } : {}),
		notices: createNotices(),
		print: (_ctx, text) => printed.push(text),
		install: { fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch, platform: "darwin" },
	});
	settings.load();
	const run = (args = "", ctx = stub.ctx()) => stub.command("boost", args, ctx);
	return {
		stub,
		run,
		settings,
		rec,
		execCalls,
		printed,
		readiness,
		notices: () => stub.ui.notices.map((n) => n.message),
		noUi: () => stub.ctx({ hasUI: false }) as ExtensionCommandContext,
	};
}

test("completions list the subcommands, filtered by prefix", () => {
	assert.deepEqual(
		completions("")?.map((c) => c.value),
		["status", "on", "off", "settings", "stats", "report", "doctor", "install", "help"],
	);
	assert.deepEqual(SUBCOMMANDS.length, 9);
	assert.deepEqual(
		completions("s")?.map((c) => c.value),
		["status", "settings", "stats"],
	);
	assert.deepEqual(
		completions("st")?.map((c) => c.value),
		["status", "stats"],
	);
	assert.deepEqual(
		completions("o")?.map((c) => c.value),
		["on", "off"],
	);
	assert.deepEqual(
		completions("DOC")?.map((c) => c.value),
		["doctor"],
	);
	assert.equal(completions("x"), null);
	assert.equal(completions("status "), null, "only the first word completes");
	for (const item of completions("") ?? []) {
		assert.equal(item.label, item.value);
		assert.ok(item.description.length > 0);
	}
});

test("/boost and its alias are registered with completions and descriptions", async () => {
	const s = setup();
	const boost = s.stub.commands.get("boost");
	assert.equal(boost?.description, "JFrog Boost: status, on/off, settings, savings, install");
	assert.deepEqual(boost?.getArgumentCompletions?.("re"), completions("re"));
	assert.equal(s.stub.commands.get("boost-install")?.description, "Alias for /boost install");
});

test("/boost without a UI, and /boost status, print the status report and spawn nothing", async () => {
	const s = setup();
	await s.run("", s.noUi());
	await s.run("status", s.noUi());
	assert.equal(s.printed.length, 2);
	assert.match(s.printed[0] ?? "", /^JFrog Boost — ready\n {2}binary {4}\/fake\/boost/);
	assert.equal(s.printed[0], s.printed[1]);
	assert.equal(s.execCalls.length, 0);
	assert.equal(s.stub.execCalls.length, 0);
});

test("/boost status with a UI notifies the report; a stuck state offers a retry", async () => {
	const ready = setup({ ui: { select: ["Retry now"] } });
	await ready.run("status");
	// The first command of a session that never saw session_start wakes it,
	// so the shell-off notice may come first.
	assert.match(ready.notices().at(-1) ?? "", /^JFrog Boost — ready/);
	assert.equal(ready.stub.ui.selects.length, 0, "nothing to retry when ready");

	let retries = 0;
	const stuckReadiness = { ...fixedReadiness({ kind: "not-responding" }), retry: () => retries++ };
	const stuck = setup({ readiness: stuckReadiness, ui: { select: ["Retry now"] } });
	await stuck.run("status");
	assert.equal(stuck.stub.ui.selects[0]?.title, "Check Boost again?");
	assert.equal(retries, 1);
	assert.equal(stuck.notices().length, 2, "the report again after the retry");

	await stuck.run("status retry", stuck.noUi());
	assert.equal(retries, 2, "status retry works without a UI too");
});

test("/boost off and on toggle the session, repaint the footer and reset the breaker", async () => {
	const breaker = createBreaker();
	let resets = 0;
	const counted: Breaker = {
		...breaker,
		reset: () => {
			resets++;
			breaker.reset();
		},
	};
	const s = setup({ breaker: counted });
	await s.run("off");
	assert.deepEqual(s.settings.off(), { by: "session" });
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost: off");
	assert.match(s.notices().at(-1) ?? "", /off for this session/);
	await s.run("on");
	assert.equal(s.settings.off(), undefined);
	assert.equal(resets, 1);
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost ✓ shell off");
	assert.equal(s.notices().at(-1), "JFrog Boost is on for this session.");
});

test("/boost on in a session that started off wakes it: footer after the probe, notices, honest reply", async () => {
	// The probe settles only when waited for, as a real one ~150 ms later.
	const ready: ReadinessState = { kind: "ready", version: [0, 16, 11] };
	let state: ReadinessState = { kind: "probing" };
	let starts = 0;
	const readiness: Readiness = {
		...fixedReadiness(),
		state: () => state,
		check: () => state,
		start: () => {
			starts++;
		},
		wait: async () => {
			state = ready;
			return state;
		},
	};
	// No flag value recorded: off by Boost's default, which the notice explains.
	const s = setup({ readiness, config: "", file: { enabled: false } });
	await s.stub.fire("session_start", { type: "session_start", reason: "startup" });
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost: off");
	assert.equal(starts, 0, "an off session never probes");
	await s.run("on");
	assert.ok(starts >= 1, "turning on starts the probe");
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost ✓ shell off", "painted once the probe settled");
	assert.ok(
		s.notices().includes(shellOffNotice({ documents: false, mcp: true })),
		"the startup notice it missed",
	);
	assert.equal(s.notices().at(-1), "JFrog Boost is on for this session.");

	// Not installed: said so, not "on".
	const missing = setup({ binary: undefined, state: { kind: "missing" }, file: { enabled: false } });
	await missing.stub.fire("session_start", { type: "session_start", reason: "startup" });
	await missing.run("on");
	assert.ok(missing.notices().includes(MISSING_NOTICE));
	assert.match(
		missing.notices().at(-1) ?? "",
		/^JFrog Boost is on for this session, but not working \(boost: not installed/,
	);
	assert.equal(missing.stub.ui.notices.at(-1)?.level, "warning");
});

test("turning Enabled on in /boost settings wakes a session that started off", async () => {
	const s = setup({ config: "", file: { enabled: false }, ui: { select: ["Enabled: off", "Done"] } });
	await s.stub.fire("session_start", { type: "session_start", reason: "startup" });
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost: off");
	await s.run("settings");
	assert.equal(s.settings.off(), undefined);
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost ✓ shell off");
	assert.ok(s.notices().includes(shellOffNotice({ documents: false, mcp: true })));
});

test("/boost off after the probe found Boost missing keeps the install hint in /boost status", async () => {
	// The production readiness, not a fixed one: while Boost is off the
	// extension reports `disabled`, and only what the last real look found can
	// tell "missing, then turned off" from "never looked".
	const s = setup({ realReadiness: true, binary: undefined });
	await s.stub.fire("session_start", { type: "session_start", reason: "startup" });
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost: not installed (/boost install)");
	await s.run("off");
	await s.run("status", s.noUi());
	assert.match(
		s.printed.at(-1) ?? "",
		/^JFrog Boost — off \(\/boost off\)\n {2}binary {4}not installed \(\/boost install\)\n/,
	);

	// Off from the start: nothing was looked for, so nothing is claimed.
	const never = setup({ realReadiness: true, binary: undefined, env: { DISABLE_BOOST: "1" } });
	await never.stub.fire("session_start", { type: "session_start", reason: "startup" });
	await never.run("status", never.noUi());
	assert.match(never.printed.at(-1) ?? "", /\n {2}binary {4}not checked while Boost is off\n/);
});

test("/boost on names the kill switch that keeps Boost off", async () => {
	const env = setup({ env: { DISABLE_BOOST: "1" } });
	await env.run("on");
	assert.match(env.notices().at(-1) ?? "", /stays off: DISABLE_BOOST=1 is set in pi's environment/);
	assert.equal(env.stub.ui.notices.at(-1)?.level, "warning");

	const flag = setup({ flags: { "no-boost": true } });
	await flag.run("on");
	assert.match(flag.notices().at(-1) ?? "", /stays off: pi was started with --no-boost/);
});

test("/boost on overrides the enabled setting for the session", async () => {
	const s = setup({ file: { enabled: false } });
	assert.deepEqual(s.settings.off(), { by: "settings" });
	await s.run("on");
	assert.equal(s.settings.off(), undefined);
});

test("/boost on while nothing keeps Boost off records no toggle; it only un-pauses", async () => {
	const s = setup();
	await s.run("on");
	assert.equal(s.settings.session(), undefined);
	assert.deepEqual(
		s.stub.appended.filter((a) => a.customType === SESSION_TOGGLE_ENTRY),
		[],
	);
	// So the Enabled setting still decides.
	s.settings.save({ enabled: false });
	assert.deepEqual(s.settings.off(), { by: "settings" });
});

test("changing Enabled in /boost settings ends /boost on|off for the session, and says so", async () => {
	const s = setup({ ui: { select: ["Enabled: on", "Done"] } });
	await s.stub.fire("session_start", { type: "session_start", reason: "startup" });
	await s.run("off");
	await s.run("on");
	assert.equal(s.settings.session(), true);
	await s.run("settings");
	assert.equal(s.rec.file().enabled, false);
	assert.deepEqual(
		s.settings.off(),
		{ by: "settings" },
		"the saved setting applies, not the earlier /boost on",
	);
	assert.equal(s.settings.session(), undefined);
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost: off");
	assert.ok(s.notices().some((n) => /ends \/boost on\|off for this session/.test(n)));
	assert.deepEqual(
		s.stub.appended.filter((a) => a.customType === SESSION_TOGGLE_ENTRY).map((a) => a.data),
		[{ enabled: false }, { enabled: true }, { enabled: null }],
		"persisted, so a resumed session follows the file too",
	);

	// Another key leaves the toggle alone.
	const other = setup({ ui: { select: ["Footer: on", "Done"] } });
	await other.run("off");
	await other.run("settings");
	assert.deepEqual(other.settings.off(), { by: "session" });
	assert.ok(!other.notices().some((n) => /ends \/boost on\|off/.test(n)));
});

test("settings reset ends /boost on|off for the session", async () => {
	const s = setup({ ui: { confirm: [true] } });
	await s.run("off");
	await s.run("settings reset");
	assert.equal(s.settings.off(), undefined);
	assert.equal(s.stub.ui.statuses.at(-1)?.text, "boost ✓ shell off");

	// Declined: nothing changes.
	const declined = setup({ ui: { confirm: [false] } });
	await declined.run("off");
	await declined.run("settings reset");
	assert.deepEqual(declined.settings.off(), { by: "session" });
});

test("report always passes -t, waits 30 s, and shows the last 40 lines", async () => {
	const output = Array.from({ length: 100 }, (_, i) => `\u001b[1mline ${i}\u001b[0m`).join("\n");
	const s = setup({ boostExec: async () => call(output) });
	await s.run("report");
	assert.deepEqual(s.execCalls, [{ args: ["report", "-t"], cwd: "/work", timeoutMs: 30_000 }]);
	const shown = s.notices().at(-1) ?? "";
	assert.match(shown, /^… \(60 earlier lines\)\nline 60\n/);
	assert.match(shown, /line 99$/);
	assert.ok(!shown.includes("\u001b"), "colour codes are stripped");
	assert.equal(shown.split("\n").length, 41);
});

test("doctor runs boost doctor and shows the last 60 lines, also without a UI", async () => {
	const output = Array.from({ length: 70 }, (_, i) => `check ${i}`).join("\n");
	const s = setup({ boostExec: async () => call(output, 1) });
	await s.run("doctor", s.noUi());
	assert.deepEqual(s.execCalls[0]?.args, ["doctor"]);
	assert.equal(s.execCalls[0]?.timeoutMs, 30_000);
	assert.match(s.printed[0] ?? "", /^`boost doctor` exited 1:\n… \(10 earlier lines\)\ncheck 10\n/);
});

test("report and doctor say so when Boost is missing, busy or slow", async () => {
	const missing = setup({ binary: undefined, state: { kind: "missing" } });
	await missing.run("report");
	assert.equal(missing.execCalls.length, 0);
	assert.match(missing.notices().at(-1) ?? "", /isn't installed/);

	const busy = setup({ boostExec: async () => ({ ...call(""), code: null, skipped: "busy" }) });
	await busy.run("report");
	assert.match(busy.notices().at(-1) ?? "", /busy/);

	const slow = setup({ boostExec: async () => ({ ...call(""), code: null, timedOut: true }) });
	await slow.run("doctor");
	assert.match(slow.notices().at(-1) ?? "", /did not finish within 30 s/);
});

test("stats and help print without a UI", async () => {
	const s = setup();
	await s.run("stats", s.noUi());
	await s.run("help", s.noUi());
	await s.run("bogus", s.noUi());
	assert.match(s.printed[0] ?? "", /^JFrog Boost — savings this session\nnothing seen yet\ntotal/);
	assert.match(s.printed[1] ?? "", /pi --no-boost=true/);
	assert.ok((s.printed[1] ?? "").includes("https://github.com/darkdiamond/pi-jfrog-boost"));
	assert.match(s.printed[2] ?? "", /^Unknown \/boost subcommand "bogus"/);
});

test("/boost with a UI opens a menu chosen by state", async () => {
	const ready = setup({ ui: { select: ["Savings by tool"] } });
	await ready.run();
	const menu = ready.stub.ui.selects[0];
	assert.equal(menu?.title, "JFrog Boost — boost ✓ shell off");
	assert.deepEqual(menu?.options, [
		"Status",
		"Turn off for this session",
		"Settings…",
		"Savings by tool",
		"Boost report",
		"Boost doctor",
		"Help",
	]);
	assert.match(ready.notices().at(-1) ?? "", /savings this session/);

	const missing = setup({ binary: undefined, state: { kind: "missing" }, ui: { select: [undefined] } });
	await missing.run();
	assert.equal(missing.stub.ui.selects[0]?.title, "JFrog Boost — boost: not installed (/boost install)");
	assert.deepEqual(missing.stub.ui.selects[0]?.options, [
		"Status",
		"Turn off for this session",
		"Settings…",
		"Savings by tool",
		"Install Boost",
		"Help",
	]);

	const off = setup({ env: { BOOST_DISABLED: "true" }, ui: { select: [undefined] } });
	await off.run();
	assert.equal(off.stub.ui.selects[0]?.options[1], "Turn on for this session");
	assert.equal(off.stub.ui.selects[0]?.title, "JFrog Boost — boost: off");
});

test("the menu's footer title ignores footer:false", async () => {
	const s = setup({ file: { footer: false }, ui: { select: [undefined] } });
	await s.run();
	assert.equal(s.stub.ui.selects[0]?.title, "JFrog Boost — boost ✓ shell off");
});

test("settings: one row per key, a pick cycles and saves atomically, then reports the path", async () => {
	const s = setup({ ui: { select: ["Shell output: auto (follows Boost — currently off)", "Done"] } });
	await s.run("settings");
	const rows = s.stub.ui.selects[0]?.options ?? [];
	assert.equal(rows.length, 17, "15 keys, reset and done");
	assert.equal(rows[0], "Enabled: on");
	assert.equal(rows[1], "Shell output: auto (follows Boost — currently off)");
	assert.equal(rows[3], "Minimum output size: 2048 bytes");
	assert.equal(rows[8], "MCP tools never sent: none");
	assert.deepEqual(rows.slice(-2), ["Reset all to defaults…", "Done"]);
	assert.equal(s.rec.file().shell, "on");
	assert.equal(s.settings.effective().shell, "on");
	// The second round shows the new value.
	assert.equal(s.stub.ui.selects[1]?.options[1], "Shell output: on (forced for pi's own Boost calls)");
	const writes = s.rec.ops.filter((op) => op.startsWith("write") || op.startsWith("rename"));
	assert.deepEqual(writes, [
		`write ${SETTINGS}.tmp-${process.pid}`,
		`rename ${SETTINGS}.tmp-${process.pid} -> ${SETTINGS}`,
	]);
	assert.equal(s.notices().at(-1), `Settings saved to ${SETTINGS}`);
});

test("settings never touch ~/.boost", async () => {
	const s = setup({
		ui: {
			select: ["Enabled: on", "MCP tools never sent: none", "Reset all to defaults…", "Done"],
			input: ["mcp__secrets__*, mcp__bank__*"],
			confirm: [true],
		},
	});
	await s.run("settings");
	await s.run("settings", s.noUi());
	assert.ok(s.rec.ops.length > 0);
	for (const op of s.rec.ops) {
		assert.doesNotMatch(op, /[\\/]\.boost([\\/]|$)/, op);
		assert.ok(
			op.includes(SETTINGS) || op === `mkdir ${dirname(SETTINGS)}`,
			`only the settings file (and its directory) is touched: ${op}`,
		);
	}
});

test("settings: lists and numbers use input; bad numbers are refused; none clears", async () => {
	const s = setup({
		ui: {
			select: [
				"MCP tools never sent: none",
				"Minimum output size: 2048 bytes",
				"Minimum output size: 2048 bytes",
				"More tools routed like bash: none",
				"More tools routed like bash: fetch, web_fetch",
				"Done",
			],
			input: ["mcp__secrets__*,  mcp__bank__* ", "lots", "4096", "fetch, web_fetch", "none"],
		},
	});
	await s.run("settings");
	assert.deepEqual(s.rec.file().mcpExclude, ["mcp__secrets__*", "mcp__bank__*"]);
	assert.equal(s.rec.file().minBytes, 4096);
	assert.ok(s.notices().some((n) => /"lots" is not a whole number/.test(n)));
	assert.deepEqual(s.rec.file().extraTools, [], "none clears the list");
	assert.match(s.stub.ui.inputs[0]?.title ?? "", /mcp__secrets__\*/);
	assert.equal(s.stub.ui.inputs[4]?.placeholder, "fetch, web_fetch", "the current value is offered");
});

test("settings: an emptied input changes nothing", async () => {
	const s = setup({
		ui: { select: ["More tools routed like bash: fetch", "Done"], input: [""] },
		file: { extraTools: ["fetch"] },
	});
	await s.run("settings");
	assert.deepEqual(s.rec.file().extraTools, ["fetch"]);
	assert.equal(s.rec.ops.filter((op) => op.startsWith("write")).length, 0);
	assert.ok(!s.notices().some((n) => n.startsWith("Settings saved")));
});

test("settings: turning observe on asks first and says what it records", async () => {
	const declined = setup({ ui: { select: ["Observe (tool I/O telemetry): off", "Done"], confirm: [false] } });
	await declined.run("settings");
	assert.equal(declined.stub.ui.confirms[0]?.message, OBSERVE_CONFIRM);
	assert.match(OBSERVE_CONFIRM, /16,000 characters of each tool's output/);
	assert.match(OBSERVE_CONFIRM, /uploads them to JFrog/);
	assert.equal(declined.rec.file().observe, undefined);

	const accepted = setup({ ui: { select: ["Observe (tool I/O telemetry): off", "Done"], confirm: [true] } });
	await accepted.run("settings");
	assert.equal(accepted.rec.file().observe, true);

	// Turning it off needs no confirm.
	const off = setup({
		file: { observe: true },
		ui: { select: ["Observe (tool I/O telemetry): on", "Done"] },
	});
	await off.run("settings");
	assert.equal(off.stub.ui.confirms.length, 0);
	assert.equal(off.rec.file().observe, false);
});

test("settings: a key set by env says so, and a save warns it is overridden", async () => {
	const s = setup({
		env: { PI_BOOST_SYNC: "0" },
		ui: { select: ["Sync to JFrog (boost sync): off — set by PI_BOOST_SYNC", "Done"] },
	});
	await s.run("settings");
	assert.equal(s.rec.file().sync, true);
	assert.ok(s.notices().some((n) => /PI_BOOST_SYNC overrides "sync"/.test(n)));
});

test("settings reset asks first, keeps unknown keys, and drops the rest", async () => {
	const declined = setup({ file: { shell: "on", custom: 1 }, ui: { confirm: [false] } });
	await declined.run("settings reset");
	assert.equal(declined.rec.file().shell, "on");

	const s = setup({ file: { shell: "on", minBytes: 10, custom: 1 }, ui: { confirm: [true] } });
	await s.run("settings reset");
	assert.match(s.stub.ui.confirms[0]?.title ?? "", /Reset pi-jfrog-boost settings/);
	const file = s.rec.file();
	assert.equal(file.shell, undefined);
	assert.equal(file.minBytes, undefined);
	assert.equal(file.custom, 1);
	assert.equal(s.settings.effective().shell, "auto");
	assert.equal(s.notices().at(-1), `Settings saved to ${SETTINGS}`);
});

test("settings without a UI print the effective values and their sources", async () => {
	const s = setup({ env: { PI_BOOST_SHELL: "on" }, file: { minBytes: 4096, typo: true } });
	await s.run("settings", s.noUi());
	const text = s.printed[0] ?? "";
	assert.match(text, new RegExp(`^pi-jfrog-boost settings \\(${SETTINGS.replace(/[\\.]/g, "\\$&")}\\)`));
	assert.match(text, /shell\s+"on"\s+\(env PI_BOOST_SHELL\)/);
	assert.match(text, /minBytes\s+4096\s+\(file\)/);
	assert.match(text, /documents\s+true\s+\(default\)/);
	assert.match(text, /ignored unknown keys: typo/);
	assert.equal(s.rec.ops.filter((op) => op.startsWith("write")).length, 0, "printing saves nothing");
});

test("settings reset without a UI says it was not done and leaves the file alone", async () => {
	const s = setup({ file: { shell: "off" } });
	await s.run("settings reset", s.noUi());
	assert.equal(
		s.printed[0],
		`Not reset: /boost settings reset asks for confirmation and needs pi's interactive UI. Delete or edit ${SETTINGS} to reset.`,
	);
	assert.match(s.printed[1] ?? "", /shell\s+"off"\s+\(file\)/);
	assert.equal(s.rec.file().shell, "off");
	assert.equal(s.rec.ops.filter((op) => op.startsWith("write")).length, 0, "nothing saved");
});

test("an unknown settings argument is named, with or without a UI", async () => {
	const s = setup();
	await s.run("settings rest", s.noUi());
	assert.equal(s.printed[0], 'Unknown /boost settings argument "rest"; the only one is reset.');
	assert.match(s.printed[1] ?? "", /^pi-jfrog-boost settings/);

	const ui = setup({ ui: { select: [undefined] } });
	await ui.run("settings rest");
	assert.ok(ui.notices().includes('Unknown /boost settings argument "rest"; the only one is reset.'));
	assert.equal(ui.stub.ui.selects.length, 1, "the settings list still opens");
});

test("a settings file that cannot be parsed is not overwritten by a save", async () => {
	const s = setup({ ui: { select: ["Enabled: on", "Done"] } });
	s.rec.files.set(SETTINGS, "{ not json");
	await s.run("settings");
	assert.equal(s.rec.files.get(SETTINGS), "{ not json");
	assert.ok(s.notices().some((n) => /settings not saved: cannot save/.test(n)));
});

test("/boost install and the alias run the same flow", async () => {
	const s = setup({ binary: undefined, state: { kind: "missing" }, ui: { select: [undefined, undefined] } });
	await s.run("install");
	await s.stub.command("boost-install");
	assert.deepEqual(
		s.stub.ui.selects.map((x) => x.title),
		["Install JFrog Boost", "Install JFrog Boost"],
	);
	await s.run("install", s.noUi());
	assert.match(s.printed.at(-1) ?? "", /To install JFrog Boost yourself/);
	assert.equal(s.stub.execCalls.length, 0);
});

test("after /boost install the footer is repainted at once, not at the next tool result", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-footer-install-"));
	try {
		const home = join(dir, "home");
		const dest = join(home, ".local", "bin", "boost");
		const archive = Buffer.from("fake archive");
		const asset = "boost-darwin-arm64.tar.gz";
		const url = `https://github.com/jfrog/boost/releases/download/v0.16.11/${asset}`;
		const stub = createPiStub({
			ui: { select: [INSTALL_OPTIONS[0]], confirm: [true] },
			exec: async (_command, args) => {
				writeFileSync(join(args[args.indexOf("-C") + 1] as string, "boost"), "#!/bin/sh\n");
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		});
		// Missing until the install's re-check finds the new file.
		let state: ReadinessState = { kind: "missing" };
		const binary = () => (existsSync(dest) ? dest : undefined);
		const readiness: Readiness = {
			...fixedReadiness(),
			state: () => state,
			check: () => state,
			wait: async () => state,
			lastKnown: () => state,
			retry() {
				state = binary() ? { kind: "ready", version: [0, 16, 11] } : { kind: "missing" };
			},
			binary,
			version: () => ("version" in state ? state.version : undefined),
		};
		const settings = createSettingsStore({ env: {}, home: () => HOME, fs: memoryFs() });
		createBoostExtension(stub.pi, {
			client: stubClient({ binary }),
			env: {},
			settings,
			config: fixedConfig(CLI_OFF),
			readiness,
			notices: createNotices(),
			install: {
				platform: "darwin",
				arch: "arm64",
				home,
				dest,
				tmpdir: dir,
				verify: async () => call("boost v0.16.11\n"),
				fetch: (async (target: string | URL) =>
					new URL(String(target)).host === "api.github.com"
						? Response.json({
								tag_name: "v0.16.11",
								assets: [
									{
										name: asset,
										browser_download_url: url,
										size: archive.length,
										digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
									},
								],
							})
						: new Response(new Uint8Array(archive))) as typeof fetch,
			},
		});
		settings.load();
		await stub.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(stub.ui.statuses.at(-1)?.text, "boost: not installed (/boost install)");
		await stub.command("boost", "install");
		assert.match(stub.ui.notices.at(-1)?.message ?? "", /^Installed JFrog Boost v0\.16\.11 at /);
		assert.equal(stub.ui.statuses.at(-1)?.text, "boost ✓ shell off", "repainted by the install itself");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("without a UI a /boost that throws says so in print mode instead of nothing", async () => {
	const s = setup({
		readiness: {
			...fixedReadiness(),
			wait: async () => {
				throw new Error("probe exploded");
			},
		},
	});
	await s.run("install", s.noUi());
	assert.equal(s.printed.at(-1), "pi-jfrog-boost: /boost failed: probe exploded");
	await s.stub.command("boost-install", "", s.noUi());
	assert.equal(s.printed.at(-1), "pi-jfrog-boost: install failed: probe exploded");
});
