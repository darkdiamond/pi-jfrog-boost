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
 *   before_agent_start  (none)            teaches the model `boost retrieve`
 *   agent_end/shutdown  boost sync        uploads what Boost measured
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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AWARENESS_BODY, AWARENESS_SECTION, withAwareness } from "./awareness.ts";
import { binaryStamp } from "./boost-binary.ts";
import { type BoostCall, type BoostClient, createBoostClient, type HookMeta } from "./boost-client.ts";
import { type ConfigReader, createConfigReader, shellGate } from "./boost-config.ts";
import {
	asResult,
	hasStructured,
	parentToolCallId,
	structuredContentOf,
	type ToolResultPatch,
} from "./compat.ts";
import { type ContentBlock, mergeDetails, textOf, truncateForObserve, withText } from "./content.ts";
import { createDocumentCache, type DocumentOutcome, readDocument } from "./documents.ts";
import {
	type Breaker,
	type Counters,
	createBreaker,
	createCounters,
	createReadiness,
	type Readiness,
} from "./health.ts";
import { COMMAND_NAME, registerInstallCommand } from "./install.ts";
import { route } from "./router.ts";
import { createSettingsStore, type SettingsStore } from "./settings.ts";
import { type Compaction, compactShellOutput } from "./shell.ts";
import { createSyncScheduler } from "./sync.ts";
import { equivalentCommand, resolveReadPath } from "./tools.ts";

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
/** Spec §10.4 `terms`: why documents are left alone, and how the user can change that. */
export const TERMS_NOTICE =
	"Boost converts PDF/Office files once its Preview Agreement is accepted. In a terminal: boost init --dry-run, then boost init (it also offers hooks for other agents).";

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
	/**
	 * Lifecycle telemetry goes only where the user opted in (`observe`,
	 * `PI_BOOST_OBSERVE`). The hook metadata is taken lazily, inside the try:
	 * building it reads `ctx.sessionManager` and `ctx.cwd`, which pi 1.2 turns
	 * into getters that throw on a stale context, and such a throw must not
	 * reach pi's handler-error path any more than a client's.
	 */
	const observe = (hookMeta: () => HookMeta, fields: Record<string, unknown>) => {
		try {
			if (observeEnabled()) client.observeDetached(hookMeta(), fields);
		} catch {
			/* fail open: telemetry is never worth an error in a pi handler */
		}
	};
	const sync = createSyncScheduler(client, deps.syncDelayMs);
	const firstTurnWaitMs = deps.firstTurnWaitMs ?? FIRST_TURN_WAIT_MS;

	/** Latest assistant text, reported to Boost when the agent settles. */
	let lastAssistantText = "";
	/** Each notice is worth saying once per process, not once per session. */
	let missingNoticeShown = false;
	let observeNoticeShown = false;
	let termsNoticeShown = false;
	/**
	 * Converted documents, shared by every session of this process: a file is
	 * keyed by path, mtime and size, so a stale entry can never be served.
	 */
	const documentCache = createDocumentCache();
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
		try {
			startSession(ctx);
		} catch {
			/* fail open: the session runs without Boost until the next check */
		}
	});

	function startSession(ctx: ExtensionContext): void {
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
		observe(() => meta(ctx), { hook_event_name: "sessionStart" });
	}

	pi.on("before_agent_start", async (event) => {
		try {
			return await awarenessFor(event);
		} catch {
			/* fail open: this turn goes without the awareness section */
			return;
		}
	});

	async function awarenessFor(event: {
		systemPrompt: string;
		systemPromptOptions?: { sections?: Record<string, string> };
	}): Promise<{ systemPrompt: string } | undefined> {
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
	}

	/** Count why a call to Boost produced nothing usable. */
	const noteCall = (call: BoostCall) => {
		if (call.skipped) counters.skip(call.skipped);
		else if (call.timedOut) counters.error("timeout");
		else if (call.spawnError) counters.error("spawn");
		else if (call.killedBy) counters.error("killed", call.killedBy);
	};

	/**
	 * Whether Boost's stdin filter will filter shell output at all (spec §8.4),
	 * decided from settings, config.toml and the environment without spawning.
	 */
	const shellOn = () => shellGate(settings.effective().shell, config.read(), env, readiness.version()).on;

	// There is no `tool_call` handler (invariant 3): a throw there blocks the
	// call outright, and nothing before a tool runs is Boost's business.

	pi.on("tool_result", async (event, ctx) => {
		// A nested call's output goes back to the calling script, not to the
		// model: it is never sent to Boost, observed or counted as a saving.
		if (parentToolCallId(event)) {
			counters.skip("nested");
			return;
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
				termsAccepted: ready && config.read().termsAccepted,
				settings: settings.effective(),
			});
			if (decision.kind === "skip") {
				counters.skip(decision.reason);
				if (decision.reason === "terms") termsNotice(ctx);
				return;
			}
			if (decision.kind === "document") {
				const outcome = await readDocument(
					{ path: event.input.path, offset: event.input.offset, limit: event.input.limit, cwd: ctx.cwd },
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
				if (outcome.call) noteCall(outcome.call);
				if (outcome.kind === "skip") {
					counters.skip(outcome.reason);
					// Accepted since the config was read, or Boost disagrees: either
					// way the user is the one who can fix it, once told.
					if (outcome.reason === "exit" && !config.read().termsAccepted) termsNotice(ctx);
					return;
				}
				if (isOff()) return;
				if (outcome.kind === "page") recordSavings(ctx, text.length - outcome.text.length);
				return asResult(documentPatch(event, outcome));
			}
			const signal = ctx.signal;
			let outcome: Awaited<ReturnType<typeof compactShellOutput>>;
			if (decision.kind === "shell") {
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
				// mcp (WP5), shell-full (WP6): not routed yet.
				return;
			}
			if (outcome.call) noteCall(outcome.call);
			const compaction = outcome.compaction;
			if (!compaction) {
				if (outcome.call && !outcome.call.skipped && outcome.call.code === 0) counters.skip("unchanged");
				return;
			}
			// Re-checked: a kill switch flipped while Boost ran wins over its reply.
			if (isOff()) return;
			recordSavings(ctx, compaction.before - compaction.after);
			return asResult(compactedPatch(event, compaction));
		} catch {
			/* fail open: keep the original result */
		} finally {
			reportToolResult(() => meta(ctx, event.toolCallId), event, text);
		}
		return;
	});

	/**
	 * The patch for a compacted result. `isError` is left out, so a failing
	 * command stays a failure. `structuredContent` is passed through as it
	 * was: pi 1.x drops it when a handler replaces `content` without
	 * returning it, and it is the tool's own record of what ran (exit code,
	 * full output path), which compaction does not change.
	 */
	function compactedPatch(
		event: { content: ContentBlock[]; details?: unknown },
		compaction: Compaction,
	): ToolResultPatch {
		const patch: ToolResultPatch = { content: withText(event.content, compaction.text) };
		if (hasStructured(event)) patch.structuredContent = structuredContentOf(event);
		const details = mergeDetails(event.details, {
			kind: "compacted",
			before: compaction.before,
			after: compaction.after,
			...(compaction.retrieveId !== undefined ? { retrieveId: compaction.retrieveId } : {}),
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
		const details = mergeDetails(event.details, {
			kind: "converted",
			ext: outcome.ext,
			...(isPage ? { lines: outcome.lines } : { error: true }),
		});
		if (details) patch.details = details;
		return patch;
	}

	/** Spec §10.4 `terms`, once per process. */
	function termsNotice(ctx: ExtensionContext): void {
		if (termsNoticeShown || !ctx.hasUI) return;
		termsNoticeShown = true;
		notify(ctx, TERMS_NOTICE, "info");
	}

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

	/**
	 * Lifecycle telemetry, only when the user opted in. See `observeEnabled`.
	 * Runs from tool_result's `finally`, outside its catch, so it guards itself:
	 * nothing here may turn a kept result into a handler error.
	 */
	function reportToolResult(
		hookMeta: () => HookMeta,
		event: { toolCallId: string; toolName: string; input: Record<string, unknown>; isError: boolean },
		text: string,
	): void {
		try {
			if (!observeEnabled()) return;
			// No duration: the `tool_call` start map is gone with the handler.
			// WP9 moves this to `tool_execution_end`, which carries `durationMs`.
			const common = { tool_name: event.toolName, tool_input: event.input };
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
		} catch {
			/* fail open: telemetry is never worth an error in a pi handler */
		}
	}

	pi.on("message_end", (event) => {
		try {
			if (event.message.role !== "assistant") return;
			const text = textOf(event.message.content as ContentBlock[]).trim();
			if (text) lastAssistantText = truncateForObserve(text);
		} catch {
			/* fail open: only telemetry reads this */
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (lastAssistantText) {
			const text = lastAssistantText;
			lastAssistantText = "";
			observe(() => meta(ctx), { hook_event_name: "afterAgentResponse", text });
		}
		// Filtering is measured locally; `boost sync` is what gets those numbers
		// into `boost report`. It uploads to JFrog, so it honours the opt-out.
		try {
			if (!isOff() && settings.effective().sync) sync.schedule(meta(ctx));
		} catch {
			/* fail open: the next settle schedules it again */
		}
	});

	pi.on("session_before_compact", (event, ctx) => {
		observe(() => meta(ctx), {
			hook_event_name: "preCompact",
			trigger: event.reason === "manual" ? "manual" : "auto",
		});
	});

	pi.on("session_compact", (_event, ctx) => {
		observe(() => meta(ctx), { hook_event_name: "postCompact" });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// No `stop` observe: it records nothing measurable and reattributes the
		// session to claude_code. `boost sync` leaves attribution alone.
		try {
			if (!isOff() && settings.effective().sync) sync.flush(meta(ctx));
		} catch {
			/* fail open: what was not uploaded goes with the next session's sync */
		}
		sync.dispose();
		// A filter still running for an abandoned turn has nobody to answer.
		try {
			client.killAll();
		} catch {
			/* fail open */
		}
	});
}

export default function boostExtension(pi: ExtensionAPI): void {
	createBoostExtension(pi);
}
