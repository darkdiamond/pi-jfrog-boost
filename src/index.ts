/**
 * pi-jfrog-boost — JFrog Boost integration for the pi coding agent.
 *
 * Boost compacts noisy tool output before it reaches the model. This extension
 * pipes pi's tool results through it and tells the model how to get the
 * original back:
 *
 *   pi event            Boost call        effect
 *   ------------------  ----------------  ----------------------------------
 *   tool_result         stdin filter      bash/powershell/read/grep/find/ls
 *                                         output compacted
 *   tool_result (read)  boost read        text pulled out of PDFs and Office
 *                                         files pi decodes as raw bytes
 *   before_agent_start  (none)            teaches the model `boost retrieve`
 *   agent_end/shutdown  boost sync        uploads what Boost measured
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AWARENESS_BODY, AWARENESS_SECTION, withAwareness } from "./awareness.ts";
import { binaryStamp } from "./boost-binary.ts";
import { type BoostCall, type BoostClient, createBoostClient, type HookMeta } from "./boost-client.ts";
import { type ConfigReader, createConfigReader } from "./boost-config.ts";
import {
	type ContentBlock,
	looksBinary,
	splitNotices,
	textOf,
	truncateForObserve,
	withText,
} from "./content.ts";
import {
	type Breaker,
	type Counters,
	createBreaker,
	createCounters,
	createReadiness,
	type Readiness,
} from "./health.ts";
import { COMMAND_NAME, registerInstallCommand } from "./install.ts";
import { createSettingsStore, type SettingsStore } from "./settings.ts";
import { createSyncScheduler } from "./sync.ts";
import { bypassesBoost, equivalentCommand, isDocument, isFiltered, isShell } from "./tools.ts";

/** Footer slot for the running savings estimate. */
const STATUS_KEY = "jfrog-boost";
/** The usual rule of thumb for English text and code. */
const CHARS_PER_TOKEN = 4;
/** The CLI flag that starts pi with Boost off (spec §9). */
export const NO_BOOST_FLAG = "no-boost";
/**
 * How long the first turn of a session may wait for the readiness probe.
 * `boost version` takes ~150 ms, so this normally covers it and the first
 * prompt already carries the awareness section; a Boost that takes longer
 * costs the first turn at most this, and later turns nothing.
 */
export const FIRST_TURN_WAIT_MS = 1_000;

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

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
	/** Live environment for kill switches and overrides; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	syncDelayMs?: number;
	firstTurnWaitMs?: number;
}

/** Wire Boost into a pi extension host. Exported so tests can drive it directly. */
export function createBoostExtension(pi: ExtensionAPI, deps: BoostExtensionDeps = {}): void {
	const env = deps.env ?? process.env;
	/** Settings warnings wait here until a session with a UI can show them. */
	const pendingWarnings: string[] = [];

	// `--no-boost`. Registered from the factory so pi's argument parser knows
	// it before it parses; read live, because pi fills flag values in after
	// the factory has run.
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
	const counters: Counters = createCounters();
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
	const observeEnabled = () => !isOff() && settings.effective().observe;
	/** Lifecycle telemetry goes only where the user opted in (`observe`, `PI_BOOST_OBSERVE`). */
	const observe = (hookMeta: HookMeta, fields: Record<string, unknown>) => {
		if (observeEnabled()) client.observeDetached(hookMeta, fields);
	};
	const sync = createSyncScheduler(client, deps.syncDelayMs);
	const firstTurnWaitMs = deps.firstTurnWaitMs ?? FIRST_TURN_WAIT_MS;
	const startedAt = new Map<string, number>();

	/** Latest assistant text, reported to Boost when the agent settles. */
	let lastAssistantText = "";
	/** Each notice is worth saying once per process, not once per session. */
	let missingNoticeShown = false;
	let observeNoticeShown = false;
	/** Characters Boost removed from this session's tool output. */
	let savedChars = 0;
	/** Only a session's first turn may wait for the readiness probe. */
	let firstTurn = true;

	// After an install the command calls refresh(); readiness must forget the
	// "missing" verdict too, or Boost would stay idle until the 60 s re-check.
	// (The client's methods are closures, so spreading them is safe.)
	registerInstallCommand(pi, {
		...client,
		refresh() {
			client.refresh();
			readiness.retry();
		},
	});

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

	pi.on("session_start", (_event, ctx) => {
		lastAssistantText = "";
		savedChars = 0;
		firstTurn = true;
		counters.reset();
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* fail open */
		}
		try {
			pendingWarnings.push(...settings.load());
			if (ctx.hasUI) for (const warning of pendingWarnings.splice(0)) notify(ctx, warning, "warning");
		} catch {
			/* defaults apply */
		}
		if (isOff()) return;

		// Not awaited (spec §8.1): resolving is a cheap stat, and the version
		// probe settles in the background. A tool result that arrives first
		// passes through unchanged rather than waiting for it.
		readiness.start();

		// Without a binary there is nothing else to say, this session or any later
		// one, so this returns whether or not the notice has already been shown.
		if (!readiness.binary()) {
			if (!missingNoticeShown) {
				missingNoticeShown = true;
				notify(ctx, `JFrog Boost is not installed — run /${COMMAND_NAME} to set it up.`, "info");
			}
			return;
		}

		// Opting into telemetry costs this session its identity in `boost report`,
		// because Boost's observe hook has no pi dialect. Say so out loud.
		if (observeEnabled() && !observeNoticeShown) {
			observeNoticeShown = true;
			notify(
				ctx,
				"PI_BOOST_OBSERVE=1: this session will be recorded as claude_code in `boost report`, because Boost has no pi agent type.",
				"warning",
			);
		}
		observe(meta(ctx), { hook_event_name: "sessionStart" });
	});

	pi.on("before_agent_start", async (event) => {
		if (isOff()) return;
		let state = readiness.check();
		// Only the first turn waits, and at most a second: the probe started at
		// session_start has normally settled by the time the user has typed a
		// prompt. Later turns take whatever state there is.
		if (firstTurn) {
			firstTurn = false;
			if (state.kind === "probing") state = await readiness.wait(firstTurnWaitMs);
		}
		if (state.kind !== "ready" || isOff() || !settings.effective().awareness) return;
		// A named section is diffed against what the model already has, so an
		// unchanged block keeps the provider's prompt cache. Replacing the whole
		// prompt is the fallback for pi releases without structured sections.
		const sections = event.systemPromptOptions?.sections;
		if (sections) {
			sections[AWARENESS_SECTION] = AWARENESS_BODY;
			return;
		}
		return { systemPrompt: withAwareness(event.systemPrompt) };
	});

	// Nothing to do before a tool runs — Boost sees the output afterwards — but
	// the start time is needed to report how long the tool took. A throw here is
	// not caught by pi and would block the call outright, hence the guard.
	pi.on("tool_call", (event) => {
		try {
			if (observeEnabled()) startedAt.set(event.toolCallId, Date.now());
		} catch {
			/* fail open: never block a tool call over a Boost problem */
		}
	});

	/** Count why a call to Boost produced nothing usable. */
	const noteCall = (call: BoostCall) => {
		if (call.skipped) counters.skip(call.skipped);
		else if (call.timedOut) counters.error("timeout");
		else if (call.spawnError) counters.error("spawn");
		else if (call.killedBy) counters.error("killed", call.killedBy);
	};

	pi.on("tool_result", async (event, ctx) => {
		const hookMeta = meta(ctx, event.toolCallId);
		const text = textOf(event.content);
		try {
			if (isOff()) {
				counters.skip("off");
				return;
			}
			// Never waits on the probe (invariant 2): until Boost is known to be
			// ready, results pass through exactly as the tool returned them.
			if (readiness.check().kind !== "ready") {
				counters.skip("not-ready");
				return;
			}
			const signal = ctx.signal;

			// pi's `read` special-cases only images: a PDF or Office file comes
			// back as its raw bytes decoded as UTF-8, or as an error. Boost can
			// extract the text, which is worth far more to the model than either.
			if (event.toolName === "read" && isDocument(event.input.path) && (event.isError || looksBinary(text))) {
				const call = await client.convert(hookMeta, event.input.path, { signal });
				noteCall(call);
				if (call.code !== 0 || !call.stdout.trim() || isOff()) return;
				return {
					isError: false,
					content: withText(
						event.content,
						`Boost extracted this document; line numbers are not source lines.\n\n${call.stdout}`,
					),
				};
			}

			// A failing test run or build is the noisiest output there is, so
			// shell failures are compacted too; they stay marked as errors. Other
			// tools fail with a one-line message that is not worth a round trip.
			if (event.isError && !isShell(event.toolName)) return;
			if (!isFiltered(event.toolName) || !text) return;
			if (isShell(event.toolName) && bypassesBoost(event.input.command)) return;

			const { body, notices } = splitNotices(text);
			if (!body.trim() || body.includes("\0")) return;
			const command = equivalentCommand(event.toolName, event.input);
			const call = await client.filter(hookMeta, body, {
				signal,
				toolInput: command ? { ...event.input, command } : event.input,
			});
			noteCall(call);
			const filtered = call.code === 0 ? call.stdout : "";
			// Re-checked: a kill switch flipped while Boost ran wins over its reply.
			if (!filtered.trim() || filtered === body || isOff()) return;
			const replacement = notices ? `${filtered.trimEnd()}${notices}` : filtered;
			recordSavings(ctx, text.length - replacement.length);
			return { content: withText(event.content, replacement) };
		} catch {
			/* fail open: keep the original result */
		} finally {
			reportToolResult(hookMeta, event, text);
		}
		return;
	});

	/**
	 * Keep a running total in pi's footer, so it is visible that Boost is doing
	 * something without leaving the session. An estimate — `boost report -t`
	 * has the measured numbers.
	 */
	function recordSavings(ctx: ExtensionContext, chars: number): void {
		if (chars <= 0) return;
		savedChars += chars;
		try {
			if (ctx.hasUI)
				ctx.ui.setStatus(STATUS_KEY, `boost ~${formatTokens(savedChars / CHARS_PER_TOKEN)} saved`);
		} catch {
			/* fail open: a status line is never worth an error */
		}
	}

	/** Lifecycle telemetry, only when the user opted in. See `observeEnabled`. */
	function reportToolResult(
		hookMeta: HookMeta,
		event: { toolCallId: string; toolName: string; input: Record<string, unknown>; isError: boolean },
		text: string,
	): void {
		if (!observeEnabled()) return;
		const started = startedAt.get(event.toolCallId);
		startedAt.delete(event.toolCallId);
		const duration = started === undefined ? undefined : Math.max(0, Date.now() - started);
		const common = { tool_name: event.toolName, tool_input: event.input, duration_ms: duration };
		observe(
			hookMeta,
			event.isError
				? {
						...common,
						hook_event_name: "PostToolUseFailure",
						error_message: truncateForObserve(text) || "tool error",
					}
				: { ...common, hook_event_name: "PostToolUse", tool_output: truncateForObserve(text) },
		);
	}

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const text = textOf(event.message.content as ContentBlock[]).trim();
		if (text) lastAssistantText = truncateForObserve(text);
	});

	pi.on("agent_end", (_event, ctx) => {
		const hookMeta = meta(ctx);
		if (lastAssistantText) {
			observe(hookMeta, {
				hook_event_name: "afterAgentResponse",
				text: lastAssistantText,
			});
			lastAssistantText = "";
		}
		// Filtering is measured locally; `boost sync` is what gets those numbers
		// into `boost report`. It uploads to JFrog, so it honours the opt-out.
		if (!isOff() && settings.effective().sync) sync.schedule(hookMeta);
	});

	pi.on("session_before_compact", (event, ctx) => {
		observe(meta(ctx), {
			hook_event_name: "preCompact",
			trigger: event.reason === "manual" ? "manual" : "auto",
		});
	});

	pi.on("session_compact", (_event, ctx) => {
		observe(meta(ctx), { hook_event_name: "postCompact" });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const hookMeta = meta(ctx);
		// No `stop` observe: it records nothing measurable and reattributes the
		// session to claude_code. `boost sync` leaves attribution alone.
		if (!isOff() && settings.effective().sync) sync.flush(hookMeta);
		sync.dispose();
		startedAt.clear();
		// A filter still running for an abandoned turn has nobody to answer.
		client.killAll();
	});
}

export default function boostExtension(pi: ExtensionAPI): void {
	createBoostExtension(pi);
}
