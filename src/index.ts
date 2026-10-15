/**
 * pi-jfrog-boost — JFrog Boost integration for the pi coding agent.
 *
 * Boost compacts noisy tool output before it reaches the model. This extension
 * pipes pi's tool results through it and tells the model how to get the
 * original back:
 *
 *   pi event            Boost call        effect
 *   ------------------  ----------------  ----------------------------------
 *   tool_result         stdin filter      bash/powershell (and extraTools)
 *                                         output compacted; opt-in whole
 *                                         reads of *.log / *.out
 *                       boost read        PDF/Office/ODF reads and large
 *                                         notebooks converted to text, paged
 *                                         like any read (documents.ts)
 *                       boost hook claude mcp__* results through Boost's MCP
 *                                         filters (mcp.ts)
 *   before_agent_start  (none)            names the active surfaces and how
 *                                         to recover output (awareness.ts)
 *   agent_settled,      boost sync        uploads what Boost measured, 8 s
 *   session_shutdown                      after the agent settles (sync.ts)
 *   tool_execution_*,   boost hook        opt-in lifecycle telemetry
 *   session_start, …    observe claude    (observe.ts)
 *
 * What the user sees (status.ts, stats.ts, render.ts): a plain-text footer
 * naming the state and the running savings, one-time notices, a badge under
 * each changed result (pi ≥ 1.0.1), and numbers-only savings persisted in the
 * session so `/resume` and forks keep them.
 *
 * The user drives it with `/boost` (commands.ts: status, on/off, settings,
 * stats, Boost's own report and doctor) and `/boost install` (install.ts,
 * also registered as `/boost-install`); both only ever act when asked.
 *
 * Which results are sent is decided by router.ts; reads of text files,
 * `edit`, `write`, `grep`, `find` and `ls` reach the model exactly. Every
 * replacement keeps the tool's `structuredContent` and records itself in
 * `details.jfrogBoost`; nested calls are never touched (invariant 5).
 *
 * Everything is fail-open: with Boost missing, too old, slow, or silent, every
 * tool result passes through untouched. Readiness is probed in the background
 * from `session_start` and never awaited by a tool result; a breaker pauses
 * Boost after repeated slow or failed calls (health.ts).
 *
 * Off switches, read live on every call, highest precedence first:
 * `DISABLE_BOOST=1` / `BOOST_DISABLED=1` in pi's environment, `--no-boost`,
 * the session toggle, and the `enabled` setting (settings.ts). A command's
 * own `DISABLE_BOOST=1` prefix bypasses Boost for that command only.
 */

import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AWARENESS_SECTION, awarenessView, buildAwareness, withAwareness } from "./awareness.ts";
import { binaryStamp, onPath } from "./boost-binary.ts";
import { type BoostCall, type BoostClient, createBoostClient, type HookMeta } from "./boost-client.ts";
import {
	type ConfigReader,
	createConfigReader,
	MCP_FILTERING_FLAG,
	resolveFlag,
	shellGate,
} from "./boost-config.ts";
import { type CommandHost, completions, createBoostCommand } from "./commands.ts";
import {
	asResult,
	hasStructured,
	loadout,
	parentToolCallId,
	structuredContentOf,
	type ToolResultPatch,
} from "./compat.ts";
import { type ContentBlock, isPlainObject, mergeDetails, textOf, withText } from "./content.ts";
import { createDocumentCache, type DocumentOutcome, readDocument } from "./documents.ts";
import {
	type Breaker,
	type Counters,
	createBreaker,
	createCounters,
	createReadiness,
	type Readiness,
	type ReadinessState,
} from "./health.ts";
import { createInstaller, type InstallDeps } from "./install.ts";
import { compactMcpResult, isMcpTool } from "./mcp.ts";
import { createObserver } from "./observe.ts";
import { registerBadges } from "./render.ts";
import { htmlAllowed, route } from "./router.ts";
import {
	createSettingsStore,
	excludedBy,
	restoreSessionToggle,
	SESSION_TOGGLE_ENTRY,
	type SettingsStore,
} from "./settings.ts";
import {
	type Compaction,
	compactFullOutput,
	compactShellOutput,
	FULL_OUTPUT_MAX_BYTES,
	fullOutputPathOf,
} from "./shell.ts";
import {
	type BucketName,
	bucketFor,
	createStats,
	formatStats,
	restoreSnapshot,
	STATS_ENTRY,
	type Stats,
	totals,
} from "./stats.ts";
import {
	createFooterPainter,
	createNotices,
	filtersDisabledNotice,
	flagsFreshness,
	footerText,
	MISSING_NOTICE,
	type Notices,
	pausedNotice,
	processNotices,
	SHELL_OFF_NOTICE,
	statusReport,
	TERMS_NOTICE,
	tokensOf,
	tooOldNotice,
} from "./status.ts";
import { createSyncScheduler } from "./sync.ts";
import { equivalentCommand, LEGACY_OFFICE, resolveReadPath } from "./tools.ts";

export { createNotices, TERMS_NOTICE };

/** The CLI flag that starts pi with Boost off (spec §9). */
export const NO_BOOST_FLAG = "no-boost";
/**
 * How long the first turn of a session may wait for the readiness probe.
 * `boost version` takes ~150 ms, so this normally covers it and the first
 * prompt already carries the awareness section; a Boost that takes longer
 * costs the first turn at most this, and later turns nothing.
 */
export const FIRST_TURN_WAIT_MS = 1_000;
/**
 * How long after session_start the UI waits for the readiness probe before
 * painting the state it settled on (and showing a too-old or shell-off
 * notice). A little over the probe's own 8 s timeout, so a hung `boost
 * version` is reported as not responding rather than never.
 */
export const PROBE_UI_WAIT_MS = 9_000;

export interface BoostExtensionDeps {
	/** Injected by tests; defaults to a client talking to the real Boost binary. */
	client?: BoostClient;
	/** Injected by tests; defaults to the global settings file. */
	settings?: SettingsStore;
	/** Injected by tests; defaults to `~/.boost/config.toml`, read-only. */
	config?: ConfigReader;
	/** Injected by tests; defaults to probing the client's binary. */
	readiness?: Readiness;
	breaker?: Breaker;
	/** Injected by tests, to see what was counted. */
	counters?: Counters;
	/** Injected by tests; per-bucket savings persisted in the session. */
	stats?: Stats;
	/**
	 * Which one-time notices were shown. Defaults to the process-wide
	 * registry (once per process, across `/reload`); tests pass their own.
	 */
	notices?: Notices;
	/** Live environment for kill switches and overrides; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	syncDelayMs?: number;
	firstTurnWaitMs?: number;
	/** Injected by tests: the install flow's fetch, platform, destination, … */
	install?: InstallDeps;
	/**
	 * Where a session without a UI (print mode) shows `/boost` output.
	 * Defaults to stdout, or stderr in JSON mode so the event stream stays valid.
	 */
	print?: (ctx: ExtensionCommandContext, text: string) => void;
}

/** `/boost` output in print mode, where `ui.notify` is a no-op. */
function defaultPrint(ctx: ExtensionCommandContext, text: string): void {
	try {
		const stream = (ctx as { mode?: string }).mode === "json" ? process.stderr : process.stdout;
		stream.write(`${text}\n`);
	} catch {
		/* nowhere to say it */
	}
}

/**
 * What the factory hands back: the views the `/boost` command is built on,
 * and that tests read. pi ignores a factory's return value.
 */
export interface BoostExtension {
	/** The `/boost status` report (spec §10.2). Spawns nothing. */
	statusReport(): string;
	/** The footer text for the current state, as painted. */
	footerText(): string | undefined;
}

/** Wire Boost into a pi extension host. Exported so tests can drive it directly. */
export function createBoostExtension(pi: ExtensionAPI, deps: BoostExtensionDeps = {}): BoostExtension {
	const env = deps.env ?? process.env;
	/** Settings warnings wait here until a session with a UI can show them. */
	const pendingWarnings: string[] = [];

	// `--no-boost`. Registered from the factory so pi's argument parser knows
	// it before it parses; read live, because pi fills flag values in after
	// the factory has run.
	//
	// How pi parses it (observed on 0.86.1 and 1.2.0 with a probe extension,
	// `pi -p`): any `--name` pi does not know takes the next argument as its
	// value unless that starts with `-` or `@` (cli/args.js), and an
	// extension's boolean flag is then set to `true` whatever the value was
	// (agent-session-services.js). So `pi --no-boost "fix it"` turns Boost off
	// but swallows the prompt, `pi --no-boost=true "fix it"` and `pi
	// --no-boost --model x "fix it"` work, and even `--no-boost=false` turns
	// Boost off. The docs give `--no-boost=true` as the safe form.
	if (typeof pi.registerFlag === "function") {
		pi.registerFlag(NO_BOOST_FLAG, {
			type: "boolean",
			default: false,
			description: "Start pi with JFrog Boost off",
		});
	}
	const settings =
		deps.settings ??
		createSettingsStore({
			env,
			flag: () => (typeof pi.getFlag === "function" ? pi.getFlag(NO_BOOST_FLAG) : undefined),
		});
	const config = deps.config ?? createConfigReader();
	const breaker = deps.breaker ?? createBreaker();
	const counters: Counters = deps.counters ?? createCounters();
	const stats: Stats = deps.stats ?? createStats();
	const notices: Notices = deps.notices ?? processNotices();
	const footer = createFooterPainter();
	const client =
		deps.client ??
		createBoostClient({
			env,
			config: config.read,
			shellMode: () => settings.effective().shell,
			breaker,
		});
	/**
	 * Off, for whatever reason: an env kill switch, `--no-boost`, the session
	 * toggle or the `enabled` setting (in that precedence). Evaluated on every
	 * call, never cached, so `DISABLE_BOOST=1` takes effect at once.
	 */
	const isOff = () => settings.off() !== undefined;
	const readiness =
		deps.readiness ??
		createReadiness({
			enabled: () => !isOff(),
			resolve: () => {
				client.refresh();
				return client.binary();
			},
			stamp: binaryStamp,
			probe: () => client.version(),
		});
	/**
	 * Lifecycle telemetry goes only where the user opted in (`observe`,
	 * `PI_BOOST_OBSERVE`), and never while any off switch is active. The
	 * observer takes the hook metadata lazily, inside its own try: building
	 * it reads `ctx.sessionManager` and `ctx.cwd`, which pi 1.2 turns into
	 * getters that throw on a stale context, and such a throw must not reach
	 * pi's handler-error path any more than a client's.
	 *
	 * Nor while Boost is known not to work (not responding, too old, an
	 * unreadable version, missing) or the breaker has paused it: each event is
	 * a detached child, and against a hung Boost those would only pile up.
	 * `probing` still sends, so a first session's `sessionStart` (fired before
	 * the probe settles) is not lost; the client's watchdog bounds those.
	 * Both reads are cached state, never a probe.
	 */
	const boostUsable = (): boolean => {
		const kind = readiness.state().kind;
		return (kind === "ready" || kind === "probing") && breaker.state().kind !== "open";
	};
	const observer = createObserver({
		enabled: () => !isOff() && settings.effective().observe && boostUsable(),
		// `mcpExclude` is the user's say over which MCP bodies Boost keeps and
		// uploads (spec §7.2); observe honours it like the MCP route does.
		excluded: (toolName) =>
			isMcpTool(toolName) && excludedBy(toolName, settings.effective().mcpExclude) !== undefined,
		send: (hookMeta, fields) => client.observeDetached(hookMeta, fields),
	});
	// Filtering is measured locally; `boost sync` is what gets those numbers
	// to JFrog. It uploads, so it honours the opt-out (and every off switch).
	// And only through a Boost known to work: a too-old, unreadable or hung
	// one is reported as leaving the extension idle (§10.4), so nothing —
	// an upload least of all — is sent through it. Cached state, never a probe.
	const sync = createSyncScheduler({
		client,
		enabled: () => !isOff() && settings.effective().sync && readiness.state().kind === "ready",
		...(deps.syncDelayMs !== undefined ? { delayMs: deps.syncDelayMs } : {}),
	});
	const firstTurnWaitMs = deps.firstTurnWaitMs ?? FIRST_TURN_WAIT_MS;
	/** The breaker opening last seen, so each opening is noticed once. */
	let seenOpenUntil: number | undefined;
	/**
	 * Whether this session's readiness probe was started and its notices
	 * scheduled (`wake`). False while off, so turning Boost on mid-session —
	 * `/boost on`, or `enabled` in `/boost settings` — wakes it.
	 */
	let awake = false;
	/**
	 * Converted documents, shared by every session of this process: a file is
	 * keyed by path, mtime and size, so a stale entry can never be served.
	 */
	const documentCache = createDocumentCache();
	/** Only a session's first turn may wait for the readiness probe. */
	let firstTurn = true;

	// Badges (spec §10.3): registered from the factory, because pi collects
	// renderers at load; on 0.86.1, which has no registerToolRenderer, nothing
	// is. The `badges` setting is read on every render, so it needs no restart.
	registerBadges(pi, () => settings.effective().badges);

	const meta = (ctx: ExtensionContext, toolCallId?: string): HookMeta => ({
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		...(toolCallId ? { tool_use_id: toolCallId } : {}),
	});

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		try {
			if (ctx.hasUI) ctx.ui.notify(message, level);
		} catch {
			/* a notice is never worth an error */
		}
	};

	/**
	 * Whether Boost's stdin filter will filter shell output at all (spec §8.4),
	 * decided from settings, config.toml and the environment without spawning.
	 */
	const shellOn = () => shellGate(settings.effective().shell, config.read(), env, readiness.version()).on;

	/** Readiness as the UI reports it: `disabled` whenever an off switch is active. */
	const uiState = (): ReadinessState => (isOff() ? { kind: "disabled" } : readiness.state());

	/**
	 * The footer for the current state (spec §10.1). Pure reads: the cached
	 * readiness (never a probe), the breaker, the config as mtime-cached, and
	 * this session's savings.
	 */
	const currentFooter = (ignoreSetting = false): string | undefined => {
		const state = uiState();
		const ready = state.kind === "ready";
		const sum = totals(stats.snapshot());
		return footerText({
			footer: ignoreSetting || settings.effective().footer,
			off: isOff(),
			readiness: state,
			paused: ready && breaker.state().kind === "open",
			shellOn: ready && shellOn(),
			// Per-result savings, never offset by a conversion that grew the
			// text (stats.ts `saved`), over everything that reached Boost.
			removed: sum.saved,
			original: sum.bytesIn,
		});
	};

	/**
	 * Repaint the footer and say what changed that the user must hear about:
	 * a breaker that has just opened (§8.2). Called after every tool result,
	 * turn and settle, and once the session's probe has settled. Never throws.
	 */
	function refreshUi(ctx: ExtensionContext): void {
		try {
			footer.paint(ctx, currentFooter());
			const b = breaker.state();
			if (b.kind === "open" && b.until !== seenOpenUntil) {
				seenOpenUntil = b.until;
				// Rounded as `/boost status`'s breaker line rounds it, so the two agree.
				const minutes = Math.max(1, Math.ceil((b.until - Date.now()) / 60_000));
				// Once per opening (§8.2), not once per process: a failed trial
				// re-opens for longer, and the user should hear for how long.
				notify(ctx, pausedNotice(b.reason, minutes), "warning");
			}
		} catch {
			/* fail open: the footer is never worth an error */
		}
	}

	/**
	 * Notices that depend on what the probe found (§10.4): a Boost too old to
	 * use, shell compaction off on a working Boost, filters Boost switched off
	 * after retrieves. Each once per process.
	 */
	function stateNotices(ctx: ExtensionContext): void {
		if (isOff()) return;
		const state = readiness.state();
		if (state.kind === "too-old") {
			notices.show(ctx, "too-old", tooOldNotice(state.version), "warning");
			return;
		}
		if (state.kind !== "ready") return;
		// Only when the gate is off by Boost's flag or default: a user who set
		// `shell: "off"` themselves needs no telling how to turn it on.
		const gate = shellGate(settings.effective().shell, config.read(), env, state.version);
		if (!gate.on && gate.reason !== "setting-off") notices.show(ctx, "shell-off", SHELL_OFF_NOTICE, "info");
		const disabled = config.read().disabledFilters;
		if (disabled.length > 0) {
			notices.show(ctx, "filters-disabled", filtersDisabledNotice(disabled), "info");
		}
	}

	/** Persist this session's savings (§10.5), numbers only, when they changed. */
	function saveStats(): void {
		try {
			if (!stats.changed() || typeof pi.appendEntry !== "function") return;
			pi.appendEntry(STATS_ENTRY, stats.snapshot());
			stats.saved();
		} catch {
			/* fail open: the next settle tries again */
		}
	}

	pi.on("session_start", (_event, ctx) => {
		observer.reset();
		firstTurn = true;
		// Whether `boost` is on PATH is looked at again once per session.
		awarenessEpoch++;
		counters.reset();
		// Any reason — startup, resume, fork, new, reload: the branch says what
		// this session has saved so far, and a new one has nothing on it.
		try {
			stats.restore(restoreSnapshot(ctx.sessionManager));
		} catch {
			stats.restore();
		}
		// `/boost off` is for the session, and pi rebuilds this extension for
		// `/reload`, `/resume` and `/fork`: the branch says whether it was used.
		// A new session has none, so a toggle from the one before is cleared.
		try {
			settings.setSession(restoreSessionToggle(ctx.sessionManager));
		} catch {
			settings.setSession(undefined);
		}
		try {
			pendingWarnings.push(...settings.load());
			if (ctx.hasUI) for (const warning of pendingWarnings.splice(0)) notify(ctx, warning, "warning");
		} catch {
			/* defaults apply */
		}
		try {
			startSession(ctx);
		} catch {
			/* fail open: the session runs without Boost until the next check */
		}
		refreshUi(ctx);
	});

	function startSession(ctx: ExtensionContext): void {
		awake = false;
		if (isOff()) return;
		// Without a binary there is nothing else to do this session.
		if (!wake(ctx)) return;
		// Detached, opt-in. No warning about attribution any more: observe
		// keeps the span's `pi` (Probe 1, observe.ts).
		observer.sessionStart(() => meta(ctx));
	}

	/**
	 * Start the readiness probe and schedule what depends on it: the footer
	 * it settles on and the notices of §10.4. Run at session start, and when
	 * Boost is turned on in a session that started off. Returns whether a
	 * binary was found.
	 */
	function wake(ctx: ExtensionContext): boolean {
		awake = true;
		// Not awaited (spec §8.1): resolving is a cheap stat, and the version
		// probe settles in the background. A tool result that arrives first
		// passes through unchanged rather than waiting for it.
		readiness.start();

		// Without a binary there is nothing else to say, this session or any later
		// one, so this returns whether or not the notice has already been shown.
		if (!readiness.binary()) {
			notices.show(ctx, "missing", MISSING_NOTICE, "info");
			return false;
		}

		// Paint what the probe settles on, and give the notices that depend on
		// it. Not awaited; a state already known (the memo) is painted at once.
		// The context may be stale by then (a new session replaced it): every
		// use is inside a try.
		stateNotices(ctx);
		void readiness
			.wait(PROBE_UI_WAIT_MS)
			.then(() => {
				stateNotices(ctx);
				refreshUi(ctx);
			})
			.catch(() => {
				/* fail open */
			});
		return true;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			return await awarenessFor(event);
		} catch {
			/* fail open: this turn goes without the awareness section */
			return;
		} finally {
			// The first turn may have waited for the probe; show what it found.
			refreshUi(ctx);
		}
	});

	/**
	 * Bumped when whether `boost` is on PATH may have changed: a new session,
	 * an install, `/boost status → retry`. The PATH lookup is the one input
	 * to the awareness text not read from state the extension already holds,
	 * so it is cached until one of those.
	 */
	let awarenessEpoch = 0;
	let onPathMemo: { key: string; value: boolean } | undefined;
	const binaryOnPath = (binary: string): boolean => {
		const key = `${awarenessEpoch}\0${binary}`;
		if (onPathMemo?.key !== key) {
			let value = false;
			try {
				value = onPath(binary, env);
			} catch {
				/* the full path is always correct */
			}
			onPathMemo = { key, value };
		}
		return onPathMemo.value;
	};
	/** The last text built, keyed by the view it was built from. */
	let awarenessMemo: { key: string; text: string | undefined } | undefined;

	/**
	 * The awareness text for this turn (spec §12), or undefined for none.
	 *
	 * Its inputs are exactly §12's triggers: readiness (to or from ready, and
	 * the version), the off switches (`/boost on|off` included), the
	 * settings, Boost's config (mtime-cached, so it changes when the file
	 * does), the binary and whether it is on PATH (an install), and the
	 * loadout. The breaker, a busy semaphore and the savings are not among
	 * them, so a breaker that opens mid-session leaves the section — and the
	 * provider's prompt cache — byte-identical.
	 */
	function currentAwareness(event: unknown): string | undefined {
		const state = uiState();
		const ready = state.kind === "ready";
		const effective = settings.effective();
		const binary = ready ? (readiness.binary() ?? client.binary()) : undefined;
		const cfg = ready ? config.read() : undefined;
		const view = awarenessView({
			ready,
			awareness: effective.awareness,
			shellOn: ready && shellOn(),
			settings: effective,
			boostVersion: readiness.version(),
			mcpFlag: cfg ? resolveFlag(cfg, MCP_FILTERING_FLAG, env).value : "unknown",
			termsAccepted: cfg?.termsAccepted ?? false,
			loadout: loadout(event),
			binary,
			onPath: binary ? binaryOnPath(binary) : true,
			platform: process.platform,
		});
		const key = JSON.stringify(view ?? null);
		if (awarenessMemo?.key !== key) awarenessMemo = { key, text: buildAwareness(view) };
		return awarenessMemo.text;
	}

	/**
	 * Both `messageType`s (pi 1.2: a user prompt, or a custom message that
	 * triggers a turn) are handled alike: the system prompt is the same
	 * whatever started the turn, and a section that came and went with the
	 * message type would only churn the prompt cache.
	 */
	async function awarenessFor(event: {
		systemPrompt: string;
		systemPromptOptions?: { sections?: Record<string, string> };
	}): Promise<{ systemPrompt: string } | undefined> {
		// Only the first turn waits, and at most a second: the probe started at
		// session_start has normally settled by the time the user has typed a
		// prompt. Later turns take whatever state there is.
		if (!isOff()) {
			const state = readiness.check();
			if (firstTurn) {
				firstTurn = false;
				if (state.kind === "probing") await readiness.wait(firstTurnWaitMs);
			}
		}
		const text = currentAwareness(event);
		// A named section is diffed against what the model already has, so an
		// unchanged block keeps the provider's prompt cache. An empty string is
		// how the section is withdrawn: pi renders nothing for it (pi 1.2.0
		// `buildSystemPromptSections` skips empty sections). Nothing else is
		// returned (spec §4).
		const sections = event.systemPromptOptions?.sections;
		if (sections) {
			sections[AWARENESS_SECTION] = text ?? "";
			return;
		}
		// The fallback for a pi without structured sections.
		if (text === undefined) return;
		return { systemPrompt: withAwareness(event.systemPrompt, text) };
	}

	/**
	 * Where one tool result's outcome is counted: the session counters behind
	 * `/boost status`, and — for a result one of Boost's surfaces could
	 * change — its stats bucket behind `/boost stats` and the footer.
	 */
	interface Tally {
		skip(reason: string): void;
		error(kind: string, detail?: string): void;
		/** Boost processed `before` characters and the model got `after` (§10.1 percentage). */
		processed(before: number, after: number, applied?: "compacted" | "converted"): void;
	}

	const tallyFor = (bucket: BucketName | undefined): Tally => ({
		skip(reason) {
			counters.skip(reason);
			if (bucket) stats.skip(bucket, reason);
		},
		error(kind, detail) {
			counters.error(kind, detail);
			if (bucket) stats.failed(bucket);
		},
		processed(before, after, applied) {
			if (bucket) stats.processed(bucket, before, after, applied);
		},
	});

	/**
	 * Count why a call to Boost produced nothing usable. Returns whether it
	 * counted anything, so a caller with its own reason for the same outcome
	 * (the document route's `busy` or `failed`) does not count it twice.
	 */
	const noteCall = (tally: Tally, call: BoostCall): boolean => {
		if (call.skipped) tally.skip(call.skipped);
		else if (call.timedOut) tally.error("timeout");
		else if (call.spawnError) tally.error("spawn");
		else if (call.killedBy) tally.error("killed", call.killedBy);
		else return false;
		return true;
	};

	/**
	 * Counts a filter or MCP call that ran to completion without its reply
	 * being used. A non-zero exit is a skip of its own (`exit`, as on the
	 * document route), not an error: it is Boost declining deterministically,
	 * and the breaker does not count it either (§8.2). Uncounted, it would be
	 * the one outcome `/boost stats` could not show. Boost did see the text,
	 * so it counts toward the footer's percentage as kept whole.
	 */
	const noteUnused = (tally: Tally, call: BoostCall | undefined, chars: number): void => {
		if (!call || call.skipped || call.timedOut || call.spawnError || call.killedBy || call.aborted) return;
		tally.skip(call.code === 0 ? "unchanged" : "exit");
		tally.processed(chars, chars);
	};

	// There is no `tool_call` handler (invariant 3): a throw there blocks the
	// call outright, and nothing before a tool runs is Boost's business.

	pi.on("tool_result", async (event, ctx) => {
		// Until the route says the extension is working on this result, it is
		// counted in the session counters only: a nested call, an off switch or
		// a Boost that is missing or not ready leaves the persisted stats
		// untouched, so an idle extension never appends an entry (§10.5).
		let tally = tallyFor(undefined);
		let bucket: BucketName | undefined;
		try {
			bucket = bucketFor(event.toolName, event.input ?? {}, settings.effective().extraTools);
		} catch {
			/* counted in the session counters only */
		}
		// A nested call's output goes back to the calling script, not to the
		// model: it is never sent to Boost, observed or counted as a saving.
		if (parentToolCallId(event)) {
			tally.skip("nested");
			return;
		}
		// Already changed by another copy of this extension loaded into the same
		// runner (a global npm install plus a local path, or `pi -e` while
		// developing): pi chains tool_result handlers, so this one would see the
		// compacted text, send it through Boost again, possibly drop the first
		// copy's retrieve marker (invariant 1) and overwrite its badge. Done is
		// done.
		try {
			if (isPlainObject(event.details) && "jfrogBoost" in event.details) {
				tally.skip("already");
				return;
			}
		} catch {
			/* fail open: a details object that throws on reads is not ours */
		}
		// Built inside the try: `ctx.sessionManager` and `ctx.cwd` throw on a
		// stale pi 1.2 context, and `content` is the tool's to shape.
		let text = "";
		try {
			const hookMeta = meta(ctx, event.toolCallId);
			text = textOf(event.content);
			// Gathered lazily, in the router's order: when off, readiness is not
			// even checked; until ready, config.toml is not read.
			const off = isOff();
			// Never waits on the probe (invariant 2): until Boost is known to be
			// ready, results pass through exactly as the tool returned them.
			const ready = !off && readiness.check().kind === "ready";
			const fullOutputPath = fullOutputPathOf(structuredContentOf(event), event.details);
			const decision = route({
				toolName: event.toolName,
				input: event.input,
				text,
				isError: event.isError,
				// Handled above, before observe could see the call either.
				nested: false,
				off,
				ready,
				paused: ready && breaker.state().kind === "open",
				shellOn: ready && shellOn(),
				fullOutputPath,
				boostVersion: readiness.version(),
				// Read from config.toml only for an MCP result that may be sent.
				mcpFlag:
					ready && isMcpTool(event.toolName)
						? resolveFlag(config.read(), MCP_FILTERING_FLAG, env).value
						: "unknown",
				settings: settings.effective(),
			});
			const idle = decision.kind === "skip" && (decision.reason === "off" || decision.reason === "not-ready");
			if (bucket && !idle) {
				stats.seen(bucket);
				tally = tallyFor(bucket);
			}
			if (decision.kind === "skip") {
				tally.skip(decision.reason);
				return;
			}
			if (decision.kind === "document") {
				const outcome = await readDocument(
					{
						path: event.input.path,
						offset: event.input.offset,
						limit: event.input.limit,
						cwd: ctx.cwd,
						termsAccepted: config.read().termsAccepted,
					},
					{
						cache: documentCache,
						convert: (abs, size) =>
							client.convert(hookMeta, abs, {
								signal: ctx.signal,
								toolInput: { path: event.input.path, file_path: abs },
								inputBytes: size,
							}),
					},
				);
				// A refusal by the client (busy, paused, …) or a timeout is counted
				// once, by the call; the outcome's reason only when the call said
				// nothing (an exit, an invalid answer, an abort, no call at all).
				const counted = outcome.call ? noteCall(tally, outcome.call) : false;
				if (outcome.kind === "skip") {
					if (!counted) tally.skip(outcome.reason);
					// Boost ran and exited non-zero, or answered with something
					// unusable: it saw the file, and the model keeps pi's result.
					if (!counted && outcome.call && outcome.call.code !== null) {
						tally.processed(text.length, text.length);
					}
					if (outcome.reason === "terms") termsNotice(ctx);
					// Boost exited non-zero and the terms are gone since the config
					// was read just above (the user revoked them mid-read): the user
					// is the one who can fix it, once told.
					else if (outcome.reason === "exit" && !config.read().termsAccepted) termsNotice(ctx);
					return;
				}
				if (isOff()) return;
				// Only a page is a conversion. The other replacement is an error
				// result — the advisory a legacy Office file becomes, or an offset
				// past the end of the converted text — which says why there is no
				// page: counted by why, and never as sizes, since a short advisory
				// in place of ~50 KB of decoded binary saved the user nothing they
				// could have used.
				if (outcome.kind === "page") tally.processed(text.length, outcome.text.length, "converted");
				else tally.skip(LEGACY_OFFICE.has(outcome.ext) ? "advisory" : "offset");
				return asResult(documentPatch(event, outcome));
			}
			const signal = ctx.signal;
			if (decision.kind === "mcp") {
				const outcome = await compactMcpResult(
					{
						toolName: event.toolName,
						toolInput: event.input,
						toolUseId: event.toolCallId,
						sessionId: hookMeta.session_id,
						cwd: hookMeta.cwd,
						content: event.content,
						details: event.details,
					},
					(payload) => client.mcp(hookMeta, payload, { signal, toolInput: event.input }),
				);
				// Counted once: the client's refusal or error if it had one, else the
				// route's own reason (pi's truncated text stands, payload too large),
				// else the call's result.
				const counted = outcome.call ? noteCall(tally, outcome.call) : false;
				const compaction = outcome.compaction;
				if (!compaction) {
					if (counted) return;
					if (outcome.skipped) tally.skip(outcome.skipped);
					else noteUnused(tally, outcome.call, text.length);
					return;
				}
				if (isOff()) return;
				tally.processed(compaction.before, compaction.after, "compacted");
				return asResult(compactedPatch(event, compaction, "mcp"));
			}
			let outcome: Awaited<ReturnType<typeof compactShellOutput>>;
			if (decision.kind === "shell-full" && fullOutputPath !== undefined) {
				const full = await compactFullOutput(
					{ text, path: fullOutputPath, htmlAllowed: htmlAllowed(event.toolName, event.input.command) },
					(body) =>
						client.filter(hookMeta, body, {
							signal,
							toolInput: event.input,
							maxInputBytes: FULL_OUTPUT_MAX_BYTES,
						}),
				);
				// Why the whole run was not used, when the tail route ran instead;
				// the tail's own call is counted below like any shell call.
				if (full.fullSkipped) tally.skip(`full-${full.fullSkipped}`);
				outcome = full;
			} else if (decision.kind === "shell") {
				outcome = await compactShellOutput(text, (body) =>
					client.filter(hookMeta, body, { signal, toolInput: event.input }),
				);
			} else if (decision.kind === "log") {
				const path = String(event.input.path);
				const abs = resolveReadPath(path, ctx.cwd);
				// Described to Boost the way its own integrations describe a file
				// read: `cat <abs>`, with the absolute path as `file_path`.
				const toolInput = { path, file_path: abs, command: equivalentCommand("read", event.input, abs) };
				outcome = await compactShellOutput(text, (body) =>
					client.filter(hookMeta, body, { signal, toolInput }),
				);
			} else {
				return;
			}
			const counted = outcome.call ? noteCall(tally, outcome.call) : false;
			const compaction = outcome.compaction;
			if (!compaction) {
				if (!counted) noteUnused(tally, outcome.call, text.length);
				return;
			}
			// Re-checked: a kill switch flipped while Boost ran wins over its reply.
			if (isOff()) return;
			tally.processed(compaction.before, compaction.after, "compacted");
			return asResult(compactedPatch(event, compaction));
		} catch {
			/* fail open: keep the original result */
		} finally {
			refreshUi(ctx);
		}
		return;
	});

	/**
	 * The patch for a compacted result, shell or MCP. `isError` is left out,
	 * so a failing command stays a failure. `structuredContent` is passed
	 * through as it was: pi 1.x drops it when a handler replaces `content`
	 * without returning it, and it is the tool's own record of what ran (exit
	 * code, full output path; an MCP server's typed result), which compaction
	 * does not change. The text blocks collapse into one at the first one's
	 * position; images and other blocks keep their places (`withText`).
	 */
	function compactedPatch(
		event: { content: ContentBlock[]; details?: unknown },
		compaction: Compaction & { full?: true },
		kind: "compacted" | "mcp" = "compacted",
	): ToolResultPatch {
		const patch: ToolResultPatch = { content: withText(event.content, compaction.text) };
		if (hasStructured(event)) patch.structuredContent = structuredContentOf(event);
		const details = mergeDetails(event.details, {
			kind,
			before: compaction.before,
			after: compaction.after,
			...(compaction.retrieveId !== undefined ? { retrieveId: compaction.retrieveId } : {}),
			...(compaction.full ? { full: true } : {}),
		});
		if (details) patch.details = details;
		return patch;
	}

	/**
	 * The patch for a converted document, or for the error a legacy Office file
	 * or an offset past the converted text becomes (spec §7.1).
	 *
	 * `isError` is always set: a page clears the error pi raised for an offset
	 * past the raw bytes, and an error is one. `structuredContent` is pi's
	 * `read` output schema, a string, so it becomes what pi's `read` would
	 * return for the converted text — the page and its notice, without the
	 * header, which is this extension's note to the model — or the error
	 * message. Only when the tool had one: on 0.86 there is none to replace.
	 */
	function documentPatch(
		event: { content: ContentBlock[]; details?: unknown },
		outcome: Exclude<DocumentOutcome, { kind: "skip" }>,
	): ToolResultPatch {
		const isPage = outcome.kind === "page";
		const patch: ToolResultPatch = {
			content: withText(event.content, outcome.text),
			isError: !isPage,
		};
		if (hasStructured(event)) patch.structuredContent = isPage ? outcome.page : outcome.text;
		// pi's `details.truncation` describes the raw bytes it read — typically
		// "first line exceeds 50KB" for a stored zip — and pi's renderer prints
		// it under the result. It is replaced by the converted page's own, as
		// pi's read would have set it for this text, or dropped (invariant 6).
		let base = event.details;
		if (isPlainObject(base) && "truncation" in base) {
			const { truncation: _raw, ...rest } = base;
			base = rest;
		}
		if (isPage && outcome.truncation && (base === undefined || isPlainObject(base))) {
			base = { ...(base ?? {}), truncation: outcome.truncation };
		}
		const details = mergeDetails(base, {
			kind: "converted",
			ext: outcome.ext,
			...(isPage ? { lines: outcome.lines } : { error: true }),
		});
		if (details) patch.details = details;
		return patch;
	}

	/** Spec §10.4 `terms`, once per process. */
	function termsNotice(ctx: ExtensionContext): void {
		notices.show(ctx, "terms", TERMS_NOTICE, "info");
	}

	// Observe only (opt-in): the run itself, bracketed. Nested calls are
	// skipped inside the observer. Neither handler returns anything.
	pi.on("tool_execution_start", (event, ctx) => {
		observer.toolStart(event, (id) => meta(ctx, id));
	});

	pi.on("tool_execution_end", (event, ctx) => {
		observer.toolEnd(event, (id) => meta(ctx, id));
	});

	pi.on("message_end", (event) => {
		observer.message(event);
	});

	// The agent is done with this prompt, follow-ups included (unlike
	// `agent_end`, which fires once per agent loop): the moment to report the
	// reply, persist what was saved (§10.5) and schedule the upload.
	pi.on("agent_settled", (event, ctx) => {
		observer.settled(event, ctx, () => meta(ctx));
		saveStats();
		try {
			sync.schedule(meta(ctx));
		} catch {
			/* fail open: the next settle schedules it again */
		}
		refreshUi(ctx);
	});

	// `/tree` moves to another point of the session without a session_start.
	// What was saved so far belongs to the branch being left, so it is written
	// there first; the branch arrived at then says what it has saved (§10.5).
	// Neither handler returns anything: session_before_tree may cancel.
	pi.on("session_before_tree", () => {
		saveStats();
	});

	pi.on("session_tree", (_event, ctx) => {
		try {
			stats.restore(restoreSnapshot(ctx.sessionManager));
		} catch {
			stats.restore();
		}
		refreshUi(ctx);
	});

	pi.on("session_before_compact", (event, ctx) => {
		observer.preCompact(event, () => meta(ctx));
	});

	pi.on("session_compact", (_event, ctx) => {
		observer.postCompact(() => meta(ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// No `stop` observe: it records nothing measurable. The sync opt-out
		// and the off switches are checked inside the scheduler.
		try {
			sync.flush(meta(ctx));
		} catch {
			/* fail open: what was not uploaded goes with the next session's sync */
		}
		sync.dispose();
		saveStats();
		// A filter still running for an abandoned turn has nobody to answer.
		try {
			client.killAll();
		} catch {
			/* fail open */
		}
	});

	const print = deps.print ?? defaultPrint;

	/**
	 * Forget the probe's verdict and the breaker, re-resolve the binary and
	 * re-probe it; resolves once the probe settled (or its wait ran out).
	 * Used by `/boost status → retry` and after an install, so neither needs
	 * a restart — readiness would otherwise keep "missing" until its 60 s
	 * re-check, and too-old until the binary's stamp changed.
	 */
	const recheck = async (): Promise<ReadinessState> => {
		client.refresh();
		// A new or moved binary may be on PATH now, or no longer.
		awarenessEpoch++;
		breaker.reset();
		readiness.retry();
		await readiness.wait(PROBE_UI_WAIT_MS);
		return uiState();
	};

	/** Shell compaction is off because of Boost's flag or default, not the user's setting. */
	const shellOffByBoost = (): boolean => {
		const state = readiness.state();
		if (state.kind !== "ready") return false;
		const gate = shellGate(settings.effective().shell, config.read(), env, state.version);
		return !gate.on && gate.reason !== "setting-off";
	};

	const install = createInstaller(
		pi,
		{
			binary: () => {
				client.refresh();
				return client.binary();
			},
			// Raw readiness, not uiState: `/boost off` must not make a too-old
			// Boost look current to the install flow (it asks the binary itself
			// when this has no verdict).
			async current() {
				readiness.check();
				return readiness.wait(PROBE_UI_WAIT_MS);
			},
			// After an install the footer is repainted at once (§11): otherwise
			// it would keep "not installed" until the next tool result or turn.
			async refresh(ctx) {
				await recheck();
				refreshUi(ctx);
				return readiness.state();
			},
			onPath: (binary) => onPath(binary, env),
			shellOffByBoost,
			termsAccepted: () => config.read().termsAccepted,
		},
		{ print, ...deps.install },
	);

	const host: CommandHost = {
		settings,
		headline: () => currentFooter(true) ?? "boost: checking…",
		state: uiState,
		binary: () => readiness.binary() ?? client.binary(),
		statusReport: () => extension.statusReport(),
		async settle() {
			await readiness.wait(FIRST_TURN_WAIT_MS);
		},
		statsReport: () => formatStats(stats.snapshot(), tokensOf),
		shellAuto: () => {
			const state = readiness.state();
			return state.kind === "ready" ? shellGate("auto", config.read(), env, state.version).on : undefined;
		},
		setSession(enabled) {
			settings.setSession(enabled);
			// Persisted so a rebuilt runtime (`/reload`, `/resume`, `/fork`)
			// keeps it; the in-memory toggle above holds either way.
			try {
				if (typeof pi.appendEntry === "function") pi.appendEntry(SESSION_TOGGLE_ENTRY, { enabled });
			} catch {
				/* fail open: this runtime still has the toggle */
			}
			if (enabled) {
				// `/boost on` is also how a user un-pauses Boost (§8.2), and a
				// session that started off never probed: start one, not awaited.
				breaker.reset();
				try {
					readiness.start();
				} catch {
					/* fail open */
				}
			}
			return settings.off();
		},
		async retry() {
			await recheck();
		},
		exec: (args, cwd, timeoutMs) => client.exec(args, cwd, timeoutMs),
		install,
		refreshUi(ctx) {
			// Every command that can turn Boost on (`/boost on`, `enabled` in
			// `/boost settings`) repaints through here: a session that was off
			// until now never probed, so wake it, or the footer would stay blank
			// until the next tool result and the startup notices never come.
			try {
				if (isOff()) awake = false;
				else if (!awake) wake(ctx);
			} catch {
				/* fail open */
			}
			refreshUi(ctx);
		},
		print,
	};
	const boostCommand = createBoostCommand(host);
	pi.registerCommand("boost", {
		description: "JFrog Boost: status, on/off, settings, savings, install",
		getArgumentCompletions: completions,
		handler: async (args, ctx) => {
			try {
				await boostCommand(args, ctx);
			} catch (error) {
				// A dialog torn down mid-command (a stale context) or a bug: say
				// so once, never as an unhandled rejection in pi.
				try {
					const text = `pi-jfrog-boost: /boost failed: ${(error as Error).message}`;
					// Print mode (`pi -p "/boost install"`) has no UI, and silence
					// there would look like success.
					if (ctx.hasUI) ctx.ui.notify(text, "error");
					else print(ctx, text);
				} catch {
					/* nothing more to do */
				}
			}
		},
	});
	pi.registerCommand("boost-install", {
		description: "Alias for /boost install",
		handler: async (args, ctx) => {
			try {
				await install(args, ctx);
			} catch (error) {
				try {
					const text = `pi-jfrog-boost: install failed: ${(error as Error).message}`;
					if (ctx.hasUI) ctx.ui.notify(text, "error");
					else print(ctx, text);
				} catch {
					/* nothing more to do */
				}
			}
		},
	});

	const extension: BoostExtension = {
		footerText: () => currentFooter(),
		statusReport() {
			const effective = settings.effective();
			const cfg = config.read();
			const binary = readiness.binary();
			let onPathNow: boolean | undefined;
			try {
				onPathNow = binary ? onPath(binary, env) : undefined;
			} catch {
				onPathNow = undefined;
			}
			return statusReport({
				readiness: uiState(),
				lastKnown: readiness.lastKnown(),
				off: settings.off(),
				breaker: breaker.state(),
				binary,
				onPath: onPathNow,
				settings: effective,
				settingsPath: settings.path(),
				home: homedir(),
				gate: shellGate(effective.shell, cfg, env, readiness.version()),
				mcpFlag: resolveFlag(cfg, MCP_FILTERING_FLAG, env),
				config: cfg,
				flags: flagsFreshness(cfg, env, Date.now()),
				stats: stats.snapshot(),
				skips: counters.skips(),
				errors: counters.errors(),
				lastError: counters.lastError(),
				now: Date.now(),
			});
		},
	};
	return extension;
}

export default function boostExtension(pi: ExtensionAPI): void {
	createBoostExtension(pi);
}
