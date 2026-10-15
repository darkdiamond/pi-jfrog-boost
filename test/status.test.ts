/**
 * The footer, the notices and the `/boost status` report (spec §10.1,
 * §10.2, §10.4): every footer state with its exact string, paint-on-change,
 * once-only notices, and the report against the §10.2 layout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBoostConfig, resolveFlag, shellGate } from "../src/boost-config.ts";
import type { ReadinessState } from "../src/health.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/settings.ts";
import { emptySnapshot } from "../src/stats.ts";
import {
	createFooterPainter,
	createNotices,
	type FooterView,
	filtersDisabledNotice,
	flagsFreshness,
	footerText,
	MISSING_NOTICE,
	pausedNotice,
	processNotices,
	STATUS_KEY,
	type StatusView,
	shellOffNotice,
	statusReport,
	TERMS_NOTICE,
	tooOldNotice,
} from "../src/status.ts";

const READY: ReadinessState = { kind: "ready", version: [0, 15, 4] };

const footer = (over: Partial<FooterView> = {}) =>
	footerText({
		footer: true,
		off: false,
		readiness: READY,
		paused: false,
		shellOn: true,
		removed: 0,
		original: 0,
		...over,
	});

test("every footer state has its exact §10.1 text", () => {
	assert.equal(footer({ readiness: { kind: "probing" } }), undefined, "probing: nothing");
	assert.equal(footer({ readiness: { kind: "missing" } }), "boost: not installed (/boost install)");
	assert.equal(footer({ off: true }), "boost: off");
	assert.equal(footer({ readiness: { kind: "disabled" } }), "boost: off");
	assert.equal(footer({ readiness: { kind: "too-old", version: [0, 12, 1] } }), "boost: v0.12.1 too old");
	assert.equal(footer({ readiness: { kind: "unknown-version" } }), "boost: version unknown");
	assert.equal(footer({ readiness: { kind: "not-responding" } }), "boost: not responding");
	assert.equal(footer({ paused: true }), "boost: paused (slow)");
	assert.equal(footer({ shellOn: false }), "boost ✓ shell off");
	assert.equal(
		footer({ shellOn: false, removed: 4_800, original: 9_000 }),
		"boost ✓ ~1.2k saved · shell off",
	);
	assert.equal(footer(), "boost ✓");
	assert.equal(footer({ removed: 49_200, original: 120_000 }), "boost ✓ ~12.3k saved (41%)");
});

test("off outranks every other state, and footer:false clears the slot", () => {
	assert.equal(footer({ off: true, readiness: { kind: "missing" }, paused: true }), "boost: off");
	assert.equal(footer({ footer: false }), undefined);
	assert.equal(footer({ footer: false, off: true }), undefined);
});

test("the footer is plain text: no ANSI, so powerline customItems can match it", () => {
	for (const text of [footer(), footer({ removed: 9_000, original: 10_000 }), footer({ paused: true })]) {
		assert.equal((text ?? "").includes("\u001b"), false);
	}
});

function uiContext(hasUI = true) {
	const statuses: { key: string; text: string | undefined }[] = [];
	const notices: { message: string; level: string }[] = [];
	const ctx = {
		hasUI,
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
	} as unknown as ExtensionContext;
	return { ctx, statuses, notices };
}

test("the footer is painted only when its text changes", () => {
	const painter = createFooterPainter();
	const { ctx, statuses } = uiContext();
	painter.paint(ctx, undefined);
	assert.deepEqual(statuses, [], "nothing shown, nothing to clear");
	painter.paint(ctx, "boost ✓");
	painter.paint(ctx, "boost ✓");
	painter.paint(ctx, "boost ✓ ~1.0k saved (50%)");
	painter.paint(ctx, "boost ✓ ~1.0k saved (50%)");
	painter.paint(ctx, undefined);
	assert.deepEqual(statuses, [
		{ key: STATUS_KEY, text: "boost ✓" },
		{ key: STATUS_KEY, text: "boost ✓ ~1.0k saved (50%)" },
		{ key: STATUS_KEY, text: undefined },
	]);
});

test("the footer is never painted without a UI, and a throwing UI is contained", () => {
	const painter = createFooterPainter();
	const headless = uiContext(false);
	painter.paint(headless.ctx, "boost ✓");
	assert.deepEqual(headless.statuses, []);
	const throwing = {
		hasUI: true,
		ui: {
			setStatus: () => {
				throw new Error("stale ctx");
			},
		},
	} as unknown as ExtensionContext;
	assert.doesNotThrow(() => painter.paint(throwing, "boost ✓"));
	// Neither attempt took, so a working UI still gets the text.
	const ui = uiContext();
	painter.paint(ui.ctx, "boost ✓");
	assert.equal(ui.statuses.length, 1);
});

test("each notice is shown once, and only to a UI", () => {
	const notices = createNotices();
	const headless = uiContext(false);
	assert.equal(notices.show(headless.ctx, "missing", MISSING_NOTICE, "info"), false);
	assert.equal(notices.shown("missing"), false, "a session without a UI does not use it up");
	const ui = uiContext();
	assert.equal(notices.show(ui.ctx, "missing", MISSING_NOTICE, "info"), true);
	assert.equal(notices.show(ui.ctx, "missing", MISSING_NOTICE, "info"), false);
	assert.equal(notices.show(ui.ctx, "terms", TERMS_NOTICE, "info"), true);
	assert.deepEqual(ui.notices, [
		{ message: MISSING_NOTICE, level: "info" },
		{ message: TERMS_NOTICE, level: "info" },
	]);
});

test("the process registry is shared by every load in the process, as across /reload", () => {
	assert.equal(processNotices(), processNotices());
});

test("notice texts are the §10.4 texts", () => {
	assert.equal(
		MISSING_NOTICE,
		"JFrog Boost isn't installed, so pi-jfrog-boost is idle. /boost install sets it up (asks first).",
	);
	assert.equal(
		tooOldNotice([0, 12, 1]),
		"JFrog Boost v0.12.1 is older than v0.13.13, so pi-jfrog-boost is idle. /boost install shows how to update.",
	);
	assert.equal(
		shellOffNotice({ documents: true, mcp: true }),
		"Boost's shell-output compaction is off (Boost's default since v0.14.6). Documents and MCP results are still handled. To turn it on for pi: /boost settings → Shell output.",
	);
	assert.equal(
		shellOffNotice({ documents: true, mcp: false }),
		"Boost's shell-output compaction is off (Boost's default since v0.14.6). Documents are still handled. To turn it on for pi: /boost settings → Shell output.",
	);
	assert.equal(
		shellOffNotice({ documents: false, mcp: true }),
		"Boost's shell-output compaction is off (Boost's default since v0.14.6). MCP results are still handled. To turn it on for pi: /boost settings → Shell output.",
	);
	assert.equal(
		shellOffNotice({ documents: false, mcp: false }),
		"Boost's shell-output compaction is off (Boost's default since v0.14.6). To turn it on for pi: /boost settings → Shell output.",
		"names nothing as handled when nothing is",
	);
	assert.equal(
		TERMS_NOTICE,
		"Boost converts PDF/Office files once its Preview Agreement is accepted. In a terminal: boost init --dry-run, then boost init (it also offers hooks for other agents).",
	);
	assert.equal(
		pausedNotice("timeout", 5),
		"Boost was slow or failing (timeouts), so it's paused for 5 min; output passes through unchanged. /boost status for details.",
	);
	assert.equal(
		filtersDisabledNotice(["npm-test", "pytest"]),
		"Boost switched off these filters after repeated retrieves: npm-test, pytest. Re-enable in a terminal: boost filters enable <name>.",
	);
});

// ---------------------------------------------------------------------------
// /boost status (§10.2)

const NOW = Date.parse("2026-10-13T12:00:00Z");
const CONFIG = parseBoostConfig(`accept_terms = "yes"
accept_terms_at = "2026-10-01T09:30:00Z"

[feature_flags._metadata]
last_updated_at = "2026-10-13T08:00:00Z"

[feature_flags."boost-cli-filtering"]
remote = false
`);

function view(over: Partial<StatusView> = {}, settings: Partial<Settings> = {}): StatusView {
	const effective = { ...DEFAULT_SETTINGS, ...settings };
	const config = over.config ?? CONFIG;
	const stats = emptySnapshot();
	stats.buckets.bash = {
		...stats.buckets.bash,
		seen: 50,
		compacted: 4,
		bytesIn: 102_000,
		bytesOut: 65_600,
		saved: 36_400,
	};
	stats.buckets.documents = {
		...stats.buckets.documents,
		seen: 1,
		converted: 1,
		bytesIn: 10_000,
		bytesOut: 2_000,
		saved: 8_000,
	};
	stats.buckets.mcp = {
		...stats.buckets.mcp,
		seen: 2,
		compacted: 1,
		bytesIn: 8_000,
		bytesOut: 3_200,
		saved: 4_800,
	};
	return {
		readiness: READY,
		breaker: { kind: "closed" },
		binary: "/Users/me/.local/bin/boost",
		onPath: false,
		settings: effective,
		settingsPath: "/Users/me/.pi/agent/jfrog-boost.json",
		home: "/Users/me",
		gate: shellGate(effective.shell, config, {}, [0, 15, 4]),
		mcpFlag: resolveFlag(config, "boost-mcp-filtering", {}),
		config,
		flags: flagsFreshness(config, {}, NOW),
		stats,
		skips: { small: 40, exact: 31, html: 2, bypass: 3 },
		errors: {},
		now: NOW,
		...over,
	};
}

test("the status report matches the §10.2 layout", () => {
	assert.equal(
		statusReport(view()),
		[
			"JFrog Boost — ready",
			"  binary    /Users/me/.local/bin/boost  v0.15.4 (validated) — not on PATH; the model is given the full path",
			"  shell     auto → off (Boost flag boost-cli-filtering: remote=false). /boost settings → Shell output: on",
			"  documents on (Preview Agreement accepted 2026-10-01)    notebooks on    readLogs off",
			"  mcp       on (boost-mcp-filtering: default)    exclude: none",
			"  breaker   closed    sync on    observe off",
			"  filters   disabled by Boost after retrieves: none (re-enable: boost filters enable <name>)",
			"  session   ~12.3k tokens saved (41%) — bash 9.1k · documents 2.0k · mcp 1.2k",
			"  skipped   small 40 · exact 31 · html 2 · bypass 3 · shell-off 0 · busy 0 · paused 0",
			"  errors    timeouts 0 · last: none",
			"  settings  ~/.pi/agent/jfrog-boost.json",
		].join("\n"),
	);
});

test("without the terms, the documents line says how to accept them", () => {
	const report = statusReport(view({ config: parseBoostConfig("") }));
	assert.ok(
		report.includes(
			"\n  documents waiting for Boost's Preview Agreement — run `boost init --dry-run`, then `boost init`, in a terminal (init also offers hooks for other agents)\n",
		),
		report,
	);
	assert.match(report, /\n {12}notebooks on {4}readLogs off\n/);
});

test("filters Boost disabled after retrieves are listed with how to re-enable them", () => {
	const config = parseBoostConfig(`accept_terms = "yes"\n[filters]\ndisabled = ["npm-test", "pytest"]\n`);
	assert.match(
		statusReport(view({ config })),
		/\n {2}filters {3}disabled by Boost after retrieves: npm-test, pytest \(re-enable: boost filters enable <name>\)\n/,
	);
});

test("stale or missing flag metadata is reported, with whether sync refreshes it", () => {
	const old = parseBoostConfig(`[feature_flags._metadata]\nlast_updated_at = "2026-10-10T12:00:00Z"\n`);
	assert.match(
		statusReport(view({ config: old, flags: flagsFreshness(old, {}, NOW) })),
		/\n {2}flags {5}stale \(3 days\); refreshed by sync\n/,
	);
	const never = parseBoostConfig("");
	assert.match(
		statusReport(view({ config: never, flags: flagsFreshness(never, {}, NOW) }, { sync: false })),
		/\n {2}flags {5}never fetched; not refreshed: sync is off\n/,
	);
	assert.doesNotMatch(statusReport(view()), /\n {2}flags/, "fresh flags need no line");
	assert.deepEqual(
		flagsFreshness(old, { BOOST_FEATURE_FLAGS_TTL: "96h" }, NOW).stale,
		false,
		"the user's TTL",
	);
});

test("the title, binary and breaker lines follow the state", () => {
	assert.match(
		statusReport(view({ off: { by: "env", name: "DISABLE_BOOST" } })),
		/^JFrog Boost — off \(DISABLE_BOOST=1\)\n/,
	);
	assert.match(statusReport(view({ off: { by: "flag" } })), /^JFrog Boost — off \(--no-boost\)\n/);
	// Off, nothing is resolved: the binary line must not claim it is missing.
	assert.match(
		statusReport(view({ off: { by: "flag" }, readiness: { kind: "disabled" }, binary: undefined })),
		/\n {2}binary {4}not checked while Boost is off\n/,
	);
	// Checked and found missing, then `/boost off`: the install hint stays.
	// (The extension reports `disabled` while off; `lastKnown` keeps the find.)
	assert.match(
		statusReport(
			view({
				off: { by: "session" },
				readiness: { kind: "disabled" },
				lastKnown: { kind: "missing" },
				binary: undefined,
			}),
		),
		/\n {2}binary {4}not installed \(\/boost install\)\n/,
	);
	assert.match(
		statusReport(view({ readiness: { kind: "missing" }, binary: undefined })),
		/^JFrog Boost — not installed\n {2}binary {4}not installed \(\/boost install\)\n/,
	);
	assert.match(
		statusReport(view({ readiness: { kind: "ready", version: [0, 16, 0] }, onPath: true })),
		/ {2}binary {4}\/Users\/me\/\.local\/bin\/boost {2}v0\.16\.0 \(newer than validated v0\.15\.4\)\n/,
	);
	const open = statusReport(
		view({ breaker: { kind: "open", until: NOW + 4.5 * 60_000, reason: "timeout" } }),
	);
	assert.match(open, /^JFrog Boost — paused \(slow\)\n/);
	assert.match(open, /\n {2}breaker {3}open for 5 more min \(timeouts\) {4}sync on {4}observe off\n/);
});

test("other skip reasons and errors are listed after the standing ones", () => {
	const report = statusReport(
		view({
			skips: { small: 1, unchanged: 2, nested: 3 },
			errors: { timeout: 2, spawn: 1 },
			lastError: "spawn",
		}),
	);
	assert.match(
		report,
		/\n {2}skipped {3}small 1 · exact 0 · html 0 · bypass 0 · shell-off 0 · busy 0 · paused 0 · nested 3 · unchanged 2\n/,
	);
	assert.match(report, /\n {2}errors {4}timeouts 2 · spawn 1 · last: spawn\n/);
});

test("no savings yet is said plainly", () => {
	assert.match(statusReport(view({ stats: emptySnapshot() })), /\n {2}session {3}nothing saved yet\n/);
});

test("the session total is the sum of its parts, never less, whatever a conversion did to the size", () => {
	const stats = emptySnapshot();
	stats.buckets.bash = {
		...stats.buckets.bash,
		seen: 1,
		compacted: 1,
		bytesIn: 40_000,
		bytesOut: 4_000,
		saved: 36_000,
	};
	// A .docx pi read as a 120-char notice, converted to a 30k-char page.
	stats.buckets.documents = {
		...stats.buckets.documents,
		seen: 1,
		converted: 1,
		bytesIn: 120,
		bytesOut: 30_000,
		saved: 0,
	};
	assert.match(statusReport(view({ stats })), /\n {2}session {3}~9\.0k tokens saved \(90%\) — bash 9\.0k\n/);
});
