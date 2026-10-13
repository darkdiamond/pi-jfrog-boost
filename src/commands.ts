/**
 * The `/boost` hub (spec §10.2): one command for everything a user does with
 * the extension — see its state, turn it off and on, change settings, read the
 * savings, ask Boost itself (`report`, `doctor`), install it.
 *
 * 0.3.0 had only `/boost-install` and a footer that was silent exactly when
 * Boost was missing, too old or doing nothing; a user had no way to ask why.
 * `/boost-install` stays as an alias so muscle memory and old docs still work.
 *
 * Everything here reads state the rest of the extension already keeps
 * (through {@link CommandHost}); the only processes it starts are the ones the
 * user asks for by name — `boost report -t`, `boost doctor`, and an install.
 * It never runs `retrieve`, `feature-flags`, `init` or `filters` (invariant 4;
 * the client refuses them anyway) and never writes `~/.boost/config.toml`: the
 * one file it writes is this extension's own settings file, atomically, from
 * `/boost settings`.
 *
 * Without a UI (print mode) every subcommand prints its text instead of
 * opening a dialog, and nothing that would need a confirmation runs.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BoostCall } from "./boost-client.ts";
import { stripAnsi } from "./content.ts";
import type { ReadinessState } from "./health.ts";
import {
	ENV_KEYS,
	isValidSetting,
	type OffReason,
	SETTINGS_KEYS,
	type Settings,
	type SettingsKey,
	type SettingsStore,
	SHELL_MODES,
	type ShellMode,
} from "./settings.ts";

export const SUBCOMMANDS = [
	"status",
	"on",
	"off",
	"settings",
	"stats",
	"report",
	"doctor",
	"install",
	"help",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

const DESCRIPTIONS: Readonly<Record<Subcommand, string>> = {
	status: "State, binary, surfaces and this session's numbers",
	on: "Turn Boost on for this session",
	off: "Turn Boost off for this session",
	settings: "Change pi-jfrog-boost's settings",
	stats: "Savings by tool this session",
	report: "Boost's own savings report (boost report -t)",
	doctor: "Boost's own health check (boost doctor)",
	install: "Install or update the Boost CLI (asks first)",
	help: "What each subcommand does",
};

export const README_URL = "https://github.com/darkdiamond/pi-jfrog-boost#readme";
/** `boost report` without `-t` opens a browser; the terminal form is the only one run. */
export const REPORT_ARGS = ["report", "-t"] as const;
export const REPORT_LINES = 40;
export const DOCTOR_LINES = 60;
export const REPORT_TIMEOUT_MS = 30_000;

/** pi's argument completions: the subcommands that start with what was typed. */
export function completions(prefix: string): { value: string; label: string; description: string }[] | null {
	const typed = prefix.trimStart();
	// Only the first word completes; after it, there is nothing to offer.
	if (/\s/.test(typed)) return null;
	const items = SUBCOMMANDS.filter((name) => name.startsWith(typed.toLowerCase())).map((name) => ({
		value: name,
		label: name,
		description: DESCRIPTIONS[name],
	}));
	return items.length ? items : null;
}

/** What the commands need from the extension. Implemented in index.ts. */
export interface CommandHost {
	settings: SettingsStore;
	/** The footer text for the state now, whatever the `footer` setting says. */
	headline(): string;
	/** Readiness as the UI reports it (`disabled` while off). */
	state(): ReadinessState;
	binary(): string | undefined;
	/** The `/boost status` report. Spawns nothing. */
	statusReport(): string;
	/**
	 * Wait briefly for a version probe already running, so a status asked for
	 * right at startup (`pi -p "/boost status"`) reports the version rather
	 * than "starting". Starts nothing.
	 */
	settle(): Promise<void>;
	/** The `/boost stats` text. */
	statsReport(): string;
	/** What `shell: "auto"` resolves to now: undefined until Boost is known to be ready. */
	shellAuto(): boolean | undefined;
	/**
	 * `/boost on|off`: the session toggle. Turning on also closes the breaker
	 * and starts a probe if none ran. Returns what still keeps Boost off.
	 */
	setSession(enabled: boolean): OffReason | undefined;
	/** `/boost status → retry`: forget the probe verdict and the breaker, look again. */
	retry(): Promise<void>;
	/** Run Boost with plain arguments (report, doctor). */
	exec(args: string[], cwd: string, timeoutMs: number): Promise<BoostCall>;
	/** `/boost install [--force]`. */
	install(args: string, ctx: ExtensionCommandContext): Promise<void>;
	/** Repaint the footer after a change. */
	refreshUi(ctx: ExtensionCommandContext): void;
	/** Print text where a session without a UI shows it. */
	print(ctx: ExtensionCommandContext, text: string): void;
}

type Level = "info" | "warning" | "error";

/** The off switches in words, for "Boost stays off: …". */
export function describeOff(off: OffReason): string {
	switch (off.by) {
		case "env":
			return `${off.name}=1 is set in pi's environment; unset it and restart pi`;
		case "flag":
			return "pi was started with --no-boost; restart pi without it";
		case "session":
			return "it is off for this session (/boost on)";
		case "settings":
			return 'the "enabled" setting is false (/boost settings)';
	}
}

/** The last `n` non-empty lines of a Boost command's output, without colour codes. */
export function tailLines(text: string, n: number): string {
	const lines = stripAnsi(text).replace(/\r\n?/g, "\n").trimEnd().split("\n");
	const tail = lines.slice(-n);
	return (lines.length > n ? [`… (${lines.length - n} earlier lines)`, ...tail] : tail).join("\n");
}

// ---------------------------------------------------------------------------
// Settings rows

const LABELS: Readonly<Record<SettingsKey, string>> = {
	enabled: "Enabled",
	shell: "Shell output",
	fullOutput: "Re-filter truncated shell output",
	minBytes: "Minimum output size",
	documents: "PDF/Office documents",
	notebooks: "Notebooks read whole",
	readLogs: "Whole reads of *.log / *.out",
	mcp: "MCP tool results",
	mcpExclude: "MCP tools never sent",
	extraTools: "More tools routed like bash",
	footer: "Footer",
	badges: "Transcript badges",
	awareness: "System-prompt section",
	sync: "Sync to JFrog (boost sync)",
	observe: "Observe (tool I/O telemetry)",
};

/** The keys edited with `ui.input` rather than cycled. */
const INPUT_KEYS: ReadonlySet<SettingsKey> = new Set(["minBytes", "mcpExclude", "extraTools"]);

const onOff = (value: boolean) => (value ? "on" : "off");

function valueText(key: SettingsKey, settings: Settings, shellAuto: boolean | undefined): string {
	const value = settings[key];
	if (key === "shell") {
		const mode = value as ShellMode;
		if (mode === "auto") {
			const now = shellAuto === undefined ? "unknown until Boost is ready" : onOff(shellAuto);
			return `auto (follows Boost — currently ${now})`;
		}
		return mode === "on" ? "on (forced for pi's own Boost calls)" : "off";
	}
	if (key === "minBytes") return `${value} bytes`;
	if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
	return onOff(value as boolean);
}

export function settingsRow(
	key: SettingsKey,
	settings: Settings,
	source: string,
	shellAuto: boolean | undefined,
): string {
	const env = ENV_KEYS[key];
	const note = source === "env" && env ? ` — set by ${env}` : "";
	return `${LABELS[key]}: ${valueText(key, settings, shellAuto)}${note}`;
}

const RESET_ROW = "Reset all to defaults…";
const DONE_ROW = "Done";

/** What `observe` records, said before it is turned on (spec §10.2, §14). */
export const OBSERVE_CONFIRM =
	"Observe sends lifecycle events to your local Boost: session start, each tool's name and input before it runs, up to 16,000 characters of each tool's output or error, the last assistant reply when a turn settles, and compaction events. Boost stores them in its local database, and `boost sync` uploads them to JFrog. It also starts one more short-lived Boost process per event. Turn it on?";

/** `a, b ,c` → `["a","b","c"]`; `none` → `[]`. */
function parseList(text: string): string[] {
	if (text.trim().toLowerCase() === "none") return [];
	return text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** The effective settings with their sources, for a session without a UI. */
export function settingsListing(store: SettingsStore): string {
	const settings = store.effective();
	const sources = store.sources();
	const width = Math.max(...SETTINGS_KEYS.map((k) => k.length)) + 2;
	const lines = [`pi-jfrog-boost settings (${store.path()})`];
	for (const key of SETTINGS_KEYS) {
		const source = sources[key] === "env" ? `env ${ENV_KEYS[key] ?? ""}`.trim() : sources[key];
		lines.push(`  ${key.padEnd(width)}${JSON.stringify(settings[key])}  (${source})`);
	}
	const unknown = store.unknownKeys();
	if (unknown.length) lines.push(`  ignored unknown keys: ${unknown.join(", ")}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The command

export function helpText(): string {
	const width = Math.max(...SUBCOMMANDS.map((s) => s.length)) + 2;
	return [
		"/boost [subcommand] — JFrog Boost for pi",
		...SUBCOMMANDS.map((name) => `  ${name.padEnd(width)}${DESCRIPTIONS[name]}`),
		"  (none)     with a UI: a menu of the above; without: status",
		"Start pi with Boost off: pi --no-boost=true. One command's exact output: DISABLE_BOOST=1 <command>.",
		`More: ${README_URL}`,
	].join("\n");
}

export function createBoostCommand(host: CommandHost) {
	const say = (ctx: ExtensionCommandContext, text: string, level: Level = "info") => {
		try {
			if (ctx.hasUI) ctx.ui.notify(text, level);
			else host.print(ctx, text);
		} catch {
			/* a message is never worth an error */
		}
	};

	async function status(ctx: ExtensionCommandContext, args: string[]): Promise<void> {
		if (args[0] === "retry") await host.retry();
		else await host.settle();
		host.refreshUi(ctx);
		say(ctx, host.statusReport());
		if (!ctx.hasUI || args[0] === "retry") return;
		// A verdict that is cached until something changes (§8.1, §8.2) can be
		// re-checked from here, so the user is never told to restart pi.
		const state = host.state();
		const stuck =
			state.kind === "not-responding" ||
			state.kind === "unknown-version" ||
			state.kind === "too-old" ||
			state.kind === "missing" ||
			host.headline() === "boost: paused (slow)";
		if (!stuck) return;
		const choice = await ctx.ui.select("Check Boost again?", ["Retry now", "Close"]);
		if (choice !== "Retry now") return;
		await host.retry();
		host.refreshUi(ctx);
		say(ctx, host.statusReport());
	}

	function toggle(ctx: ExtensionCommandContext, enabled: boolean): void {
		const blocking = host.setSession(enabled);
		host.refreshUi(ctx);
		if (enabled) {
			if (blocking) say(ctx, `JFrog Boost stays off: ${describeOff(blocking)}.`, "warning");
			else say(ctx, "JFrog Boost is on for this session.");
			return;
		}
		say(
			ctx,
			"JFrog Boost is off for this session; tool output passes through unchanged. /boost on turns it back on.",
		);
	}

	async function boostCommand(ctx: ExtensionCommandContext, which: "report" | "doctor"): Promise<void> {
		const args = which === "report" ? [...REPORT_ARGS] : ["doctor"];
		const lines = which === "report" ? REPORT_LINES : DOCTOR_LINES;
		if (!host.binary()) {
			say(ctx, "JFrog Boost isn't installed. /boost install sets it up (asks first).", "warning");
			return;
		}
		let result: BoostCall;
		try {
			result = await host.exec(args, ctx.cwd, REPORT_TIMEOUT_MS);
		} catch (error) {
			say(ctx, `\`boost ${args.join(" ")}\` failed: ${(error as Error).message}`, "error");
			return;
		}
		const command = `boost ${args.join(" ")}`;
		if (result.skipped === "busy") {
			say(
				ctx,
				`\`${command}\` did not run: Boost is busy with tool output. Try again in a moment.`,
				"warning",
			);
			return;
		}
		if (result.skipped) {
			say(ctx, `\`${command}\` did not run (${result.skipped}).`, "warning");
			return;
		}
		if (result.timedOut) {
			say(ctx, `\`${command}\` did not finish within ${REPORT_TIMEOUT_MS / 1000} s.`, "error");
			return;
		}
		const out = result.stdout.trim() ? tailLines(result.stdout, lines) : "(no output)";
		const failed = result.code !== 0;
		say(
			ctx,
			`${failed ? `\`${command}\` exited ${result.code ?? "abnormally"}:\n` : ""}${out}`,
			failed ? "warning" : "info",
		);
	}

	async function editSetting(
		ctx: ExtensionCommandContext,
		key: SettingsKey,
	): Promise<Partial<Settings> | undefined> {
		const current = host.settings.effective();
		if (INPUT_KEYS.has(key)) {
			if (key === "minBytes") {
				const text = await ctx.ui.input("Minimum output size in bytes (0–1048576)", String(current.minBytes));
				if (text === undefined || text.trim() === "") return undefined;
				const value = Number(text.trim());
				if (!isValidSetting("minBytes", value)) {
					say(ctx, `"${text}" is not a whole number of bytes from 0 to 1048576.`, "warning");
					return undefined;
				}
				return { minBytes: value };
			}
			const title =
				key === "mcpExclude"
					? "MCP tools never sent to Boost: comma-separated patterns, * matches anything (e.g. mcp__secrets__*); none clears"
					: "More tools routed like bash: comma-separated names (e.g. fetch); none clears";
			const text = await ctx.ui.input(title, (current[key] as string[]).join(", ") || "none");
			if (text === undefined || text.trim() === "") return undefined;
			return { [key]: parseList(text) } as Partial<Settings>;
		}
		if (key === "shell") {
			const index = SHELL_MODES.indexOf(current.shell);
			return { shell: SHELL_MODES[(index + 1) % SHELL_MODES.length] as ShellMode };
		}
		const next = !(current[key] as boolean);
		if (key === "observe" && next) {
			if (!(await ctx.ui.confirm("Turn on Boost observe?", OBSERVE_CONFIRM))) return undefined;
		}
		return { [key]: next } as Partial<Settings>;
	}

	function save(ctx: ExtensionCommandContext, apply: () => void): boolean {
		try {
			apply();
		} catch (error) {
			say(ctx, `pi-jfrog-boost: settings not saved: ${(error as Error).message}`, "error");
			return false;
		}
		host.refreshUi(ctx);
		return true;
	}

	async function reset(ctx: ExtensionCommandContext): Promise<boolean> {
		const ok = await ctx.ui.confirm(
			"Reset pi-jfrog-boost settings?",
			`Every setting in ${host.settings.path()} goes back to its default. Environment overrides still apply.`,
		);
		if (!ok) return false;
		return save(ctx, () => host.settings.reset());
	}

	async function settingsLoop(ctx: ExtensionCommandContext, args: string[]): Promise<void> {
		if (!ctx.hasUI) {
			say(ctx, settingsListing(host.settings));
			return;
		}
		let saved = false;
		if (args[0] === "reset") {
			if (await reset(ctx)) say(ctx, `Settings saved to ${host.settings.path()}`);
			return;
		}
		// One row per key; picking a row cycles or edits it and saves at once, so
		// the footer and the next tool result follow immediately. Escape or
		// Done leaves. Bounded, in case a UI keeps answering the same way.
		for (let round = 0; round < 200; round++) {
			const settings = host.settings.effective();
			const sources = host.settings.sources();
			const shellAuto = host.shellAuto();
			const rows = SETTINGS_KEYS.map((key) => settingsRow(key, settings, sources[key], shellAuto));
			const unknown = host.settings.unknownKeys();
			const title = `pi-jfrog-boost settings${unknown.length ? ` (ignored unknown keys: ${unknown.join(", ")})` : ""}`;
			const choice = await ctx.ui.select(title, [...rows, RESET_ROW, DONE_ROW]);
			if (choice === undefined || choice === DONE_ROW) break;
			if (choice === RESET_ROW) {
				saved = (await reset(ctx)) || saved;
				continue;
			}
			const key = SETTINGS_KEYS[rows.indexOf(choice)];
			if (key === undefined) break;
			const change = await editSetting(ctx, key);
			if (!change) continue;
			if (save(ctx, () => host.settings.save(change))) {
				saved = true;
				const env = ENV_KEYS[key];
				if (sources[key] === "env" && env) {
					say(ctx, `Saved, but ${env} overrides "${key}" while it is set in pi's environment.`, "warning");
				}
			}
		}
		if (saved) say(ctx, `Settings saved to ${host.settings.path()}`);
	}

	/** `/boost` with a UI: a menu chosen by state. */
	async function menu(ctx: ExtensionCommandContext): Promise<void> {
		const state = host.state();
		const off = host.settings.off();
		const entries: [string, () => Promise<void> | void][] = [
			["Status", () => status(ctx, [])],
			off
				? ["Turn on for this session", () => toggle(ctx, true)]
				: ["Turn off for this session", () => toggle(ctx, false)],
			["Settings…", () => settingsLoop(ctx, [])],
			["Savings by tool", () => say(ctx, host.statsReport())],
		];
		if (host.binary()) {
			entries.push(["Boost report", () => boostCommand(ctx, "report")]);
			entries.push(["Boost doctor", () => boostCommand(ctx, "doctor")]);
		}
		if (!host.binary() || state.kind === "missing" || state.kind === "too-old") {
			entries.push(["Install Boost", () => host.install("", ctx)]);
		}
		entries.push(["Help", () => say(ctx, helpText())]);
		const choice = await ctx.ui.select(
			`JFrog Boost — ${host.headline()}`,
			entries.map(([label]) => label),
		);
		const entry = entries.find(([label]) => label === choice);
		if (entry) await entry[1]();
	}

	return async function handler(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
		const args = rawArgs.trim().split(/\s+/).filter(Boolean);
		const sub = args[0]?.toLowerCase();
		const rest = args.slice(1);
		switch (sub) {
			case undefined:
				if (ctx.hasUI) await menu(ctx);
				else await status(ctx, []);
				return;
			case "status":
				await status(ctx, rest);
				return;
			case "on":
			case "off":
				toggle(ctx, sub === "on");
				return;
			case "settings":
				await settingsLoop(ctx, rest);
				return;
			case "stats":
				say(ctx, host.statsReport());
				return;
			case "report":
			case "doctor":
				await boostCommand(ctx, sub);
				return;
			case "install":
				await host.install(rest.join(" "), ctx);
				return;
			case "help":
				say(ctx, helpText());
				return;
			default:
				say(ctx, `Unknown /boost subcommand "${args[0]}".\n${helpText()}`, "warning");
		}
	};
}
