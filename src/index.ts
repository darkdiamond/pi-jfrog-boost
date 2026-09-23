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
 * tool result passes through untouched. `DISABLE_BOOST=1` turns it off at
 * runtime, for one command or a whole session.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AWARENESS_BODY, AWARENESS_SECTION, withAwareness } from "./awareness.ts";
import { type BoostClient, createBoostClient, type HookMeta } from "./boost-client.ts";
import {
	type ContentBlock,
	looksBinary,
	splitNotices,
	textOf,
	truncateForObserve,
	withText,
} from "./content.ts";
import { COMMAND_NAME, registerInstallCommand } from "./install.ts";
import { createSyncScheduler } from "./sync.ts";
import { bypassesBoost, equivalentCommand, isDocument, isFiltered, isShell } from "./tools.ts";

/** Footer slot for the running savings estimate. */
const STATUS_KEY = "jfrog-boost";
/** The usual rule of thumb for English text and code. */
const CHARS_PER_TOKEN = 4;

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens)}`;
}

export interface BoostExtensionDeps {
	/** Injected by tests; defaults to a client talking to the real Boost binary. */
	client?: BoostClient;
	syncDelayMs?: number;
}

/** Wire Boost into a pi extension host. Exported so tests can drive it directly. */
export function createBoostExtension(pi: ExtensionAPI, deps: BoostExtensionDeps = {}): void {
	const client = deps.client ?? createBoostClient();
	const sync = createSyncScheduler(client, deps.syncDelayMs);
	const startedAt = new Map<string, number>();

	/** Daily tip Boost may return from the sessionStart observe; injected once. */
	let hint: string | undefined;
	/** Latest assistant text, reported to Boost when the agent settles. */
	let lastAssistantText = "";
	/** Each notice is worth saying once per process, not once per session. */
	let missingNoticeShown = false;
	let observeNoticeShown = false;
	/** Characters Boost removed from this session's tool output. */
	let savedChars = 0;

	registerInstallCommand(pi, client);

	const meta = (ctx: ExtensionContext, toolCallId?: string): HookMeta => ({
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		...(toolCallId ? { tool_use_id: toolCallId } : {}),
	});

	pi.on("session_start", (_event, ctx) => {
		hint = undefined;
		lastAssistantText = "";
		savedChars = 0;
		try {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* fail open */
		}

		// Without a binary there is nothing else to say, this session or any later
		// one, so this returns whether or not the notice has already been shown.
		if (!client.binary() && client.enabled()) {
			if (!missingNoticeShown) {
				missingNoticeShown = true;
				ctx.ui.notify(`JFrog Boost is not installed — run /${COMMAND_NAME} to set it up.`, "info");
			}
			return;
		}

		// Opting into telemetry costs this session its identity in `boost report`,
		// because Boost's observe hook has no pi dialect. Say so out loud.
		if (client.observeEnabled() && !observeNoticeShown) {
			observeNoticeShown = true;
			ctx.ui.notify(
				"PI_BOOST_OBSERVE=1: this session will be recorded as claude_code in `boost report`, because Boost has no pi agent type.",
				"warning",
			);
		}

		// Not awaited: a session must never wait on telemetry. The reply carries
		// Boost's daily tip, which the next turn picks up if it arrives in time.
		void client
			.observe(meta(ctx), { hook_event_name: "sessionStart" })
			.then((reply) => {
				const line = reply?.additional_context;
				if (typeof line === "string" && line.trim()) hint = line.trim();
			})
			.catch(() => {
				/* fail open */
			});
	});

	pi.on("before_agent_start", async (event) => {
		if (!(await client.ready())) return;
		const line = hint;
		hint = undefined;
		// A named section is diffed against what the model already has, so an
		// unchanged block keeps the provider's prompt cache. Replacing the whole
		// prompt is the fallback for pi releases without structured sections.
		const sections = event.systemPromptOptions?.sections;
		if (sections) {
			sections[AWARENESS_SECTION] = line ? `${AWARENESS_BODY}\n\n${line}` : AWARENESS_BODY;
			return;
		}
		const systemPrompt = withAwareness(event.systemPrompt);
		return { systemPrompt: line ? `${systemPrompt}\n\n${line}` : systemPrompt };
	});

	// Nothing to do before a tool runs — Boost sees the output afterwards — but
	// the start time is needed to report how long the tool took. A throw here is
	// not caught by pi and would block the call outright, hence the guard.
	pi.on("tool_call", (event) => {
		try {
			if (client.observeEnabled()) startedAt.set(event.toolCallId, Date.now());
		} catch {
			/* fail open: never block a tool call over a Boost problem */
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const hookMeta = meta(ctx, event.toolCallId);
		const text = textOf(event.content);
		try {
			// pi's `read` special-cases only images: a PDF or Office file comes
			// back as its raw bytes decoded as UTF-8, or as an error. Boost can
			// extract the text, which is worth far more to the model than either.
			if (event.toolName === "read" && isDocument(event.input.path) && (event.isError || looksBinary(text))) {
				const extracted = await client.read(hookMeta, event.input.path);
				if (!extracted) return;
				return {
					isError: false,
					content: withText(
						event.content,
						`Boost extracted this document; line numbers are not source lines.\n\n${extracted}`,
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
			if (!body.trim()) return;
			const command = equivalentCommand(event.toolName, event.input);
			const filtered = await client.filter(
				hookMeta,
				command ? { ...event.input, command } : event.input,
				body,
			);
			if (!filtered) return;
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
		if (!client.observeEnabled()) return;
		const started = startedAt.get(event.toolCallId);
		startedAt.delete(event.toolCallId);
		const duration = started === undefined ? undefined : Math.max(0, Date.now() - started);
		const common = { tool_name: event.toolName, tool_input: event.input, duration_ms: duration };
		client.observeDetached(
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
			client.observeDetached(hookMeta, {
				hook_event_name: "afterAgentResponse",
				text: lastAssistantText,
			});
			lastAssistantText = "";
		}
		// Filtering is measured locally; `boost sync` is what gets those numbers
		// into `boost report`.
		sync.schedule(hookMeta);
	});

	pi.on("session_before_compact", (event, ctx) => {
		client.observeDetached(meta(ctx), {
			hook_event_name: "preCompact",
			trigger: event.reason === "manual" ? "manual" : "auto",
		});
	});

	pi.on("session_compact", (_event, ctx) => {
		client.observeDetached(meta(ctx), { hook_event_name: "postCompact" });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const hookMeta = meta(ctx);
		// No `stop` observe: it records nothing measurable and reattributes the
		// session to claude_code. `boost sync` leaves attribution alone.
		sync.flush(hookMeta);
		sync.dispose();
		startedAt.clear();
	});
}

export default function boostExtension(pi: ExtensionAPI): void {
	createBoostExtension(pi);
}
