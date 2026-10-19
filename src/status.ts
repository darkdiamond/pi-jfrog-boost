/**
 * What the user is told about Boost: the footer (spec §10.1), the one-time
 * notices (§10.4) and the `/boost status` report (§10.2).
 *
 * Everything here is pure text built from plain views gathered by the
 * caller, so every state is reachable in a unit test with its exact string,
 * and nothing in this file can spawn, read a file or throw into pi.
 *
 * The footer is plain text with no ANSI on purpose: pi-powerline-footer's
 * `customItems` match the status text, and a colour code would break the
 * match. It names the state first (`boost: off`, `boost: paused (slow)`)
 * because 0.3.0's footer was silent in exactly the states a user needed to
 * see — Boost missing, too old, or doing nothing because CLI filtering is off.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BoostVersion,
	compareVersions,
	formatVersion,
	MCP_MIN_VERSION,
	MIN_BOOST_VERSION,
	VALIDATED_BOOST_VERSION,
} from "./boost-binary.ts";
import {
	type BoostConfig,
	CLI_FILTERING_FLAG,
	type FlagResolution,
	type FlagsFreshness,
	MCP_FILTERING_FLAG,
	type ShellGate,
} from "./boost-config.ts";
import type { BadReason, BreakerState, ReadinessState } from "./health.ts";
import { tildePath } from "./install.ts";
import type { OffReason, Settings } from "./settings.ts";
import { BUCKETS, percent, type StatsSnapshot, totals } from "./stats.ts";

/**
 * pi's status slot; also what pi-powerline-footer's `customItems` match on:
 * `{"powerline":{"customItems":[{"id":"boost","statusKey":"jfrog-boost"}]}}`
 * (the shape the README documents).
 */
export const STATUS_KEY = "jfrog-boost";
/** The usual rule of thumb for English text and code. */
export const CHARS_PER_TOKEN = 4;

/** `12`, `1.2k`, `3.4M`: a token count short enough for a footer. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

/** Removed characters as an estimated token count, formatted. */
export const tokensOf = (chars: number): string => formatTokens(chars / CHARS_PER_TOKEN);

// ---------------------------------------------------------------------------
// Footer (§10.1)

export interface FooterView {
	/** The `footer` setting. False clears the slot. */
	footer: boolean;
	/** Any off switch is active (env, `--no-boost`, session, settings). */
	off: boolean;
	readiness: ReadinessState;
	/** The breaker is open: every call to Boost is skipped. */
	paused: boolean;
	/** The shell gate (§8.4) resolves on. */
	shellOn: boolean;
	/** Characters Boost removed from what the model saw, summed over every route. */
	removed: number;
	/** Characters of the results that reached Boost, for the percentage. */
	original: number;
}

/**
 * The footer text for a state, or undefined for an empty slot.
 *
 * Probing shows nothing rather than "starting…": the probe takes ~140 ms, and
 * a word that flickers away on every session start is noise. Off outranks
 * everything, because it is the user's own doing and the one thing they can
 * undo from here. The shell-off form keeps the savings but drops the
 * percentage: with shell output excluded, a ratio over documents and MCP
 * alone would read as the whole picture.
 */
export function footerText(view: FooterView): string | undefined {
	if (!view.footer) return undefined;
	if (view.off) return "boost: off";
	const state = view.readiness;
	switch (state.kind) {
		case "disabled":
			return "boost: off";
		case "probing":
			return undefined;
		case "missing":
			return "boost: not installed (/boost install)";
		case "too-old":
			return `boost: v${formatVersion(state.version)} too old`;
		case "unknown-version":
			return "boost: version unknown";
		case "not-responding":
			return "boost: not responding";
		case "ready":
			break;
	}
	if (view.paused) return "boost: paused (slow)";
	const saved = view.removed > 0 ? `~${tokensOf(view.removed)} saved` : "";
	if (!view.shellOn) return saved ? `boost ✓ ${saved} · shell off` : "boost ✓ shell off";
	return saved ? `boost ✓ ${saved} (${percent(view.removed, view.original)}%)` : "boost ✓";
}

/**
 * Paints the footer, but only when its text changed: pi re-renders on every
 * `setStatus`, and the footer is recomputed after every tool result. Also
 * only with a UI (print and RPC modes have no footer), and inside a try,
 * because pi 1.2 makes a stale context's `ui` throw and a status line is
 * never worth an error in a pi handler.
 */
export interface FooterPainter {
	paint(ctx: ExtensionContext, text: string | undefined): void;
}

export function createFooterPainter(): FooterPainter {
	let shown: string | undefined;
	return {
		paint(ctx, text) {
			if (text === shown) return;
			try {
				if (!ctx.hasUI) return;
				ctx.ui.setStatus(STATUS_KEY, text);
				shown = text;
			} catch {
				/* fail open: a status line is never worth an error */
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Notices (§10.4)

export type NoticeId = "missing" | "too-old" | "shell-off" | "terms" | "filters-disabled";
export type NoticeLevel = "info" | "warning" | "error";

export const MISSING_NOTICE =
	"JFrog Boost isn't installed, so pi-jfrog-boost is idle. /boost install sets it up (asks first).";
export const tooOldNotice = (version: BoostVersion) =>
	`JFrog Boost v${formatVersion(version)} is older than v${formatVersion(MIN_BOOST_VERSION)}, so pi-jfrog-boost is idle. /boost install shows how to update.`;
/** What still works while shell compaction is off: each only when it is really active. */
export interface StillHandled {
	/** The documents setting is on and Boost's Preview Agreement is accepted. */
	documents: boolean;
	/**
	 * The mcp setting is on, the flag does not forbid it, Boost is ≥
	 * MCP_MIN_VERSION and pi calls some MCP tool top-level, not only from
	 * codemode scripts (compat.ts `mcpReachesRoute`).
	 */
	mcp: boolean;
}

/**
 * Why shell compaction is off when the notice is given: Boost's built-in
 * default (no flag value recorded), or JFrog's remote flag. A user who turned
 * it off (their Boost flag, `BOOST_FEATURE_FLAGS_FORCE_DISABLED`, or
 * `shell: "off"`) gets no notice at all.
 */
export type ShellOffCause = "default" | "remote";

const SHELL_OFF_CAUSES: Readonly<Record<ShellOffCause, string>> = {
	default: "Boost's default since v0.14.6",
	remote: "turned off by JFrog's remote flag",
};

/**
 * The shell-off notice (and the post-install line). It names only the
 * surfaces that are active, and says nothing about them when none is (§10.4).
 */
export function shellOffNotice(still: StillHandled, cause: ShellOffCause = "default"): string {
	const handled =
		still.documents && still.mcp
			? " Documents and MCP results are still handled."
			: still.documents
				? " Documents are still handled."
				: still.mcp
					? " MCP results are still handled."
					: "";
	return `Boost's shell-output compaction is off (${SHELL_OFF_CAUSES[cause]}).${handled} To turn it on for pi: /boost settings → Shell output.`;
}
export const TERMS_NOTICE =
	"Boost converts PDF/Office files once its Preview Agreement is accepted. In a terminal: boost init --dry-run, then boost init (it also offers hooks for other agents).";
export const pausedNotice = (reason: BadReason, minutes: number) =>
	`Boost was slow or failing (${PAUSE_REASONS[reason]}), so it's paused for ${minutes} min; output passes through unchanged. /boost status for details.`;
export const filtersDisabledNotice = (filters: readonly string[]) =>
	`Boost has these filters disabled (by \`boost filters disable\` or after repeated retrieves): ${filters.join(", ")}. Re-enable in a terminal: boost filters enable <name>.`;

/** The breaker's reason, in the words a notice uses. */
const PAUSE_REASONS: Readonly<Record<BadReason, string>> = {
	timeout: "timeouts",
	error: "failed to start",
	killed: "killed",
	slow: "slow calls",
};

/**
 * Notices already given. Each is worth saying once per process (§10.4), not
 * once per session: a user who was told Boost is missing at startup does not
 * need telling again after `/new`. A notice is only consumed when it was
 * actually shown, so a print-mode session without a UI does not use up the
 * one a later interactive session should see.
 */
export interface Notices {
	/** Show `message` unless `id` was already shown. Returns whether it was shown now. */
	show(ctx: ExtensionContext, id: NoticeId, message: string, level: NoticeLevel): boolean;
}

export function createNotices(): Notices {
	const given = new Set<NoticeId>();
	return {
		show(ctx, id, message, level) {
			if (given.has(id)) return false;
			try {
				if (!ctx.hasUI) return false;
				ctx.ui.notify(message, level);
				given.add(id);
				return true;
			} catch {
				/* a notice is never worth an error */
				return false;
			}
		},
	};
}

/**
 * The process-wide registry. pi loads extensions with jiti's module cache
 * off, so `/reload` evaluates this module afresh and a module-level set
 * would forget; a registry hung on `globalThis` under a registered symbol
 * survives that, which is what "once per process" means to the user.
 */
export function processNotices(): Notices {
	const key = Symbol.for("pi-jfrog-boost.notices");
	const store = globalThis as unknown as Record<symbol, Notices | undefined>;
	store[key] ??= createNotices();
	return store[key];
}

// ---------------------------------------------------------------------------
// The /boost status report (§10.2)

export interface StatusView {
	/** As the UI reports it: `disabled` whenever an off switch is active. */
	readiness: ReadinessState;
	/**
	 * What the last real look found, off switches aside (Readiness.lastKnown).
	 * `readiness` hides it behind `disabled` while Boost is off, so this is
	 * the only way the report can tell "found missing, then turned off" from
	 * "never looked".
	 */
	lastKnown?: ReadinessState | undefined;
	off?: OffReason | undefined;
	breaker: BreakerState;
	binary?: string | undefined;
	/** Whether `boost` on PATH is this binary. Undefined when not checked. */
	onPath?: boolean | undefined;
	settings: Settings;
	settingsPath: string;
	/** For shortening paths under it to `~`. */
	home: string;
	gate: ShellGate;
	mcpFlag: FlagResolution;
	config: BoostConfig;
	flags: FlagsFreshness;
	stats: StatsSnapshot;
	/** This session's skip reasons and errors (health.ts counters). */
	skips: Readonly<Record<string, number>>;
	errors: Readonly<Record<string, number>>;
	lastError?: string | undefined;
	now: number;
}

/** The label column: `documents ` is the longest label, plus one space. */
const LABEL_WIDTH = 10;
const line = (label: string, text: string) => `  ${label.padEnd(LABEL_WIDTH)}${text}`;
/** Fields that share a line are spaced like the §10.2 sample. */
const GAP = "    ";
export const onOff = (value: boolean) => (value ? "on" : "off");

/** Skip reasons always listed, even at 0, so their absence is visible too. */
const STANDING_SKIPS = ["small", "exact", "html", "bypass", "shell-off", "busy", "paused"];

/** The one-word state in the report's title. */
export function stateLabel(view: Pick<StatusView, "readiness" | "off" | "breaker">): string {
	const off = view.off;
	if (off) {
		if (off.by === "env") return `off (${off.name}=1)`;
		if (off.by === "flag") return "off (--no-boost)";
		if (off.by === "session") return "off (/boost off)";
		return 'off (settings: "enabled": false)';
	}
	const state = view.readiness;
	switch (state.kind) {
		case "disabled":
			return "off";
		case "probing":
			return "starting";
		case "missing":
			return "not installed";
		case "too-old":
			return `v${formatVersion(state.version)} too old`;
		case "unknown-version":
			return "version unknown";
		case "not-responding":
			return "not responding";
		case "ready":
			return view.breaker.kind === "open" ? "paused (slow)" : "ready";
	}
}

function versionNote(version: BoostVersion): string {
	const validated = `v${formatVersion(VALIDATED_BOOST_VERSION)}`;
	if (compareVersions(version, MIN_BOOST_VERSION) < 0) {
		return `(older than v${formatVersion(MIN_BOOST_VERSION)}: too old)`;
	}
	const cmp = compareVersions(version, VALIDATED_BOOST_VERSION);
	if (cmp === 0) return "(validated)";
	return cmp > 0 ? `(newer than validated ${validated})` : `(supported; validated ${validated})`;
}

function binaryLine(view: StatusView): string {
	// While Boost is off nothing is resolved or probed (health.ts), so a
	// missing path usually means "not looked for", not "not installed". But a
	// session where the probe already found no binary and the user then ran
	// `/boost off` was checked (`lastKnown`, since `readiness` is `disabled`
	// by then): keep the install hint there, because hiding it would make a
	// missing binary look like a deliberate off.
	if (!view.binary) {
		if (view.readiness.kind === "missing" || view.lastKnown?.kind === "missing") {
			return "not installed (/boost install)";
		}
		return view.off || view.readiness.kind === "disabled" || view.readiness.kind === "probing"
			? "not checked while Boost is off"
			: "not installed (/boost install)";
	}
	const state = view.readiness;
	let text = view.binary;
	if ("version" in state) text += `  v${formatVersion(state.version)} ${versionNote(state.version)}`;
	else if (state.kind === "unknown-version") text += "  (version banner not recognised)";
	else if (state.kind === "not-responding") text += "  (not responding to `boost version`)";
	else if (state.kind === "probing") text += "  (checking the version)";
	if (view.onPath === false) text += " — not on PATH; the model is given the full path";
	return text;
}

/** `remote=false`, `user=true`, `BOOST_FEATURE_FLAGS_FORCE_ENABLED`, or `default`. */
function flagSource(flag: FlagResolution): string {
	switch (flag.source) {
		case "force-enabled":
			return "BOOST_FEATURE_FLAGS_FORCE_ENABLED";
		case "force-disabled":
			return "BOOST_FEATURE_FLAGS_FORCE_DISABLED";
		case "user":
		case "remote":
			return `${flag.source}=${flag.value}`;
		case "unknown":
			return "default";
	}
}

function shellLine(view: StatusView): string {
	const gate = view.gate;
	const flag = `Boost flag ${CLI_FILTERING_FLAG}: ${flagSource(gate.flag)}`;
	switch (gate.reason) {
		case "setting-on":
			return "on (forced for pi's own Boost calls; ~/.boost/config.toml is not changed)";
		case "setting-off":
			return "off (setting)";
		case "flag":
			return gate.on ? `auto → on (${flag})` : `auto → off (${flag}). /boost settings → Shell output: on`;
		case "unknown-before-flags":
			return `auto → on (${flag}; on by default before v0.14.6)`;
		case "unknown-newer-than-validated":
			return `auto → on (${flag}; this Boost is newer than validated, so it decides)`;
		case "unknown-default-off":
			return `auto → off (${flag}; off by default since v0.14.6). /boost settings → Shell output: on`;
	}
}

/** The terms date as Boost wrote it, trimmed to the day when it is an ISO timestamp. */
function termsDate(at: string | undefined): string {
	if (!at) return "";
	const day = /^\d{4}-\d{2}-\d{2}/.exec(at);
	return ` ${day ? day[0] : at}`;
}

const TERMS_WAITING =
	"waiting for Boost's Preview Agreement — run `boost init --dry-run`, then `boost init`, in a terminal (init also offers hooks for other agents)";

function documentsLines(view: StatusView): string[] {
	const s = view.settings;
	const rest = `notebooks ${onOff(s.notebooks)}${GAP}readLogs ${onOff(s.readLogs)}`;
	if (s.documents && !view.config.termsAccepted) {
		// The waiting line is long and exact (§10.2); the other two keys go on
		// a continuation line rather than disappear.
		return [line("documents", TERMS_WAITING), line("", rest)];
	}
	const documents = s.documents ? `on (Preview Agreement accepted${termsDate(view.config.termsAt)})` : "off";
	return [line("documents", `${documents}${GAP}${rest}`)];
}

function mcpLine(view: StatusView): string {
	const s = view.settings;
	const exclude = `exclude: ${s.mcpExclude.length ? s.mcpExclude.join(", ") : "none"}`;
	if (!s.mcp) return `off${GAP}${exclude}`;
	const version = "version" in view.readiness ? view.readiness.version : undefined;
	if (version && compareVersions(version, MCP_MIN_VERSION) < 0) {
		return `on (needs Boost v${formatVersion(MCP_MIN_VERSION)} or newer)${GAP}${exclude}`;
	}
	const flag = view.mcpFlag;
	const note = flag.value === false ? "; Boost's MCP filtering is off" : "";
	return `on (${MCP_FILTERING_FLAG}: ${flagSource(flag)}${note})${GAP}${exclude}`;
}

function breakerText(view: StatusView): string {
	const b = view.breaker;
	if (b.kind === "closed") return "closed";
	if (b.kind === "half-open") return "half-open (the next call is a trial)";
	const minutes = Math.max(1, Math.ceil((b.until - view.now) / 60_000));
	return `open for ${minutes} more min (${PAUSE_REASONS[b.reason]})`;
}

function flagsLine(view: StatusView): string | undefined {
	if (!view.flags.stale) return undefined;
	const { ageMs, unreadable } = view.flags;
	const age = unreadable
		? "last update time unreadable"
		: ageMs === undefined
			? "never fetched"
			: `stale (${ageText(ageMs)} old)`;
	const by = view.settings.sync ? "refreshed by sync" : "not refreshed: sync is off";
	return line("flags", `${age}; ${by}`);
}

/** Whole days, or whole hours under a day (a user TTL can be `1h`). */
function ageText(ms: number): string {
	const days = Math.floor(ms / 86_400_000);
	if (days >= 1) return days === 1 ? "1 day" : `${days} days`;
	return `${Math.floor(ms / 3_600_000)} h`;
}

function sessionLine(view: StatusView): string {
	const all = totals(view.stats);
	// The sum of the per-result savings the parts below are made of, so the
	// headline can never read less than its parts (stats.ts `saved`).
	const removed = all.saved;
	if (removed === 0) return "nothing saved yet";
	const parts = BUCKETS.map((name) => [name, view.stats.buckets[name].saved] as const)
		.filter(([, saved]) => saved > 0)
		.map(([name, saved]) => `${name} ${tokensOf(saved)}`);
	return `~${tokensOf(removed)} tokens saved (${percent(removed, all.bytesIn)}%) — ${parts.join(" · ")}`;
}

function skippedLine(skips: Readonly<Record<string, number>>): string {
	const extra = Object.keys(skips)
		.filter((reason) => !STANDING_SKIPS.includes(reason) && (skips[reason] ?? 0) > 0)
		.sort();
	return [...STANDING_SKIPS, ...extra].map((reason) => `${reason} ${skips[reason] ?? 0}`).join(" · ");
}

function errorsLine(view: StatusView): string {
	const others = Object.keys(view.errors)
		.filter((kind) => kind !== "timeout" && (view.errors[kind] ?? 0) > 0)
		.sort()
		.map((kind) => `${kind} ${view.errors[kind]}`);
	return [`timeouts ${view.errors.timeout ?? 0}`, ...others, `last: ${view.lastError ?? "none"}`].join(" · ");
}

/**
 * `/boost status` (§10.2). Spawns nothing: everything comes from the cached
 * readiness, config.toml as last read, and this session's counters, so it
 * answers instantly and works when Boost is hung.
 */
export function statusReport(view: StatusView): string {
	const s = view.settings;
	const filters = view.config.disabledFilters;
	const lines = [
		`JFrog Boost — ${stateLabel(view)}`,
		line("binary", binaryLine(view)),
		line("shell", shellLine(view)),
		...documentsLines(view),
		line("mcp", mcpLine(view)),
		line("breaker", `${breakerText(view)}${GAP}sync ${onOff(s.sync)}${GAP}observe ${onOff(s.observe)}`),
		line(
			"filters",
			filters.length
				? `disabled: ${filters.join(", ")} (by \`boost filters disable\` or after retrieves; re-enable: boost filters enable <name>)`
				: "disabled: none",
		),
	];
	const flags = flagsLine(view);
	if (flags) lines.push(flags);
	if (view.config.boostOffSessions !== undefined) {
		lines.push(
			line(
				"measure",
				`boost_off_sessions = ${view.config.boostOffSessions} (Boost's own setting; shown, not acted on)`,
			),
		);
	}
	lines.push(
		line("session", sessionLine(view)),
		line("skipped", skippedLine(view.skips)),
		line("errors", errorsLine(view)),
		line("settings", tildePath(view.settingsPath, view.home)),
	);
	return lines.join("\n");
}
