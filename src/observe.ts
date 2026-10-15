/**
 * Opt-in lifecycle telemetry to Boost (spec §14): `boost hook observe claude`,
 * detached, for the events Boost's own integrations report.
 *
 *   pi event                     observe event                  carries
 *   ---------------------------  -----------------------------  -----------------------------
 *   session_start                sessionStart                   —
 *   tool_execution_start         PreToolUse                     tool_name, tool_input
 *   tool_execution_end           PostToolUse /                  tool_output or error_message
 *                                PostToolUseFailure             (≤ 16k chars), duration_ms
 *   agent_settled (not aborted)  afterAgentResponse             the last assistant text
 *   session_before_compact       preCompact                     trigger: manual | auto
 *   session_compact              postCompact                    —
 *
 * Off by default (`observe` setting, `PI_BOOST_OBSERVE`), for privacy and
 * process count: it sends tool output excerpts and the model's replies to
 * Boost's local DB, which `boost sync` uploads, and it is one process per
 * event. It is not off for attribution's sake: measured on v0.15.4 (Probe 1),
 * observe keeps the span's `session.agent_type` as `pi` (it comes from
 * `BOOST_HOOK_META`), never rewrites an earlier span, and opens and closes
 * `agent_tool_calls` rows; the `claude_code` in Boost's session list is
 * there for every pi session whether observe is on or not. So 0.3.0's
 * "this session will be recorded as claude_code" warning is gone.
 *
 * Why these pi events, and not `tool_call` / `tool_result` as in 0.3.0:
 * `tool_call` is the one hook that can block a tool (invariant 3), and the
 * `tool_execution_*` pair brackets the run itself — on pi ≥ 1.1 the end
 * event carries `durationMs`, measured by pi with a monotonic clock, which is
 * preferred; on 0.86 a start timer keyed by tool call id stands in.
 *
 * Not sent: `userPromptSubmit` (the user's prompt text, a privacy step too
 * far for a token tool), subagent events (pi has none), `stop` (records
 * nothing measurable), and nothing for nested calls — a codemode script's
 * inner calls are its business, not a turn the model took.
 *
 * Not sent either: anything about a tool the user listed in `mcpExclude`.
 * That setting is the user's say over which MCP bodies Boost stores and
 * `boost sync` uploads (spec §7.2); an observe event carrying the same
 * arguments and a 16k excerpt of the same output would quietly undo it. Both
 * halves are skipped, so Boost never sees a PreToolUse row it cannot close.
 *
 * Sizes: the output excerpt is capped at 16k characters (OBSERVE_TEXT_LIMIT)
 * and so are the arguments, which are sent twice (Pre and Post) and can be
 * as large as the output — a `write` carries the whole file.
 * {@link capToolInput} keeps small arguments as they are and shortens large
 * ones.
 *
 * Everything is fail-open: no method throws, and an observe that cannot be
 * sent is simply not sent.
 */
import type { HookMeta, HookPayload } from "./boost-client.ts";
import { aborted, durationMs, parentToolCallId } from "./compat.ts";
import { type ContentBlock, OBSERVE_TEXT_LIMIT, textOf, truncateForObserve } from "./content.ts";

/**
 * Start times kept for the fallback timer at most. A start whose end never
 * arrives (pi torn down mid-tool) must not grow the map without bound; past
 * this many, the oldest is dropped and that call is reported without a
 * duration.
 */
export const MAX_PENDING_STARTS = 256;

export interface ObserverDeps {
	/** Whether observe is on right now: the setting, env and every off switch. */
	enabled(): boolean;
	/**
	 * Whether a tool's calls must not be observed at all: an `mcp__*` tool
	 * matched by `mcpExclude`, read live so a settings save applies at once.
	 */
	excluded?: (toolName: string) => boolean;
	/** Send one event, detached (client.observeDetached). */
	send(meta: HookMeta, fields: HookPayload): void;
	/** Monotonic clock in ms for the fallback timer; defaults to `performance.now`. */
	now?: () => number;
}

/** `meta` is taken lazily: building it reads `ctx`, whose getters throw on a stale pi 1.2 context. */
type MetaOf = (toolCallId?: string) => HookMeta;

export interface Observer {
	/** A new session: forget the last reply and any pending starts. */
	reset(): void;
	sessionStart(meta: MetaOf): void;
	/** `tool_execution_start`. */
	toolStart(event: unknown, meta: MetaOf): void;
	/** `tool_execution_end`. */
	toolEnd(event: unknown, meta: MetaOf): void;
	/** `message_end`: remember the latest assistant text. */
	message(event: unknown): void;
	/** `agent_settled`: report the reply, unless the run was aborted. */
	settled(event: unknown, ctx: unknown, meta: MetaOf): void;
	preCompact(event: unknown, meta: MetaOf): void;
	postCompact(meta: MetaOf): void;
}

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag | undefined =>
	typeof value === "object" && value !== null ? (value as Bag) : undefined;

/** How long one string in oversized arguments may stay. */
export const OBSERVE_ARG_STRING_LIMIT = 2_000;

/**
 * A tool's arguments as observe sends them: unchanged when they serialise to
 * at most OBSERVE_TEXT_LIMIT characters, which is nearly every call. Larger
 * ones keep their shape — Boost records `tool_input` as an object, and the
 * small fields (a path, a command) are the useful part — with every long
 * string cut to OBSERVE_ARG_STRING_LIMIT. If that is still too large (very
 * many fields), only a truncated JSON excerpt is sent.
 */
export function capToolInput(args: Bag): Bag {
	let json: string;
	try {
		json = JSON.stringify(args) ?? "{}";
	} catch {
		return {};
	}
	if (json.length <= OBSERVE_TEXT_LIMIT) return args;
	const shorten = (value: unknown, depth: number): unknown => {
		if (typeof value === "string") {
			return value.length > OBSERVE_ARG_STRING_LIMIT
				? `${value.slice(0, OBSERVE_ARG_STRING_LIMIT)}\n…[truncated]`
				: value;
		}
		if (typeof value !== "object" || value === null || depth >= 8) return value;
		if (Array.isArray(value)) return value.map((item) => shorten(item, depth + 1));
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, depth + 1)]));
	};
	const shortened = shorten(args, 0) as Bag;
	if ((JSON.stringify(shortened) ?? "").length <= OBSERVE_TEXT_LIMIT) return shortened;
	return { truncated_input: truncateForObserve(json) };
}

/** The text of a content array, tolerating anything a tool might put there. */
function textOfAny(content: unknown): string {
	return Array.isArray(content) ? textOf(content as ContentBlock[]) : "";
}

export function createObserver(deps: ObserverDeps): Observer {
	const now = deps.now ?? (() => performance.now());
	/**
	 * toolCallId → start time (the fallback timer, for a pi without
	 * `durationMs`) and the call's arguments, which `tool_execution_end` does
	 * not carry. Insertion-ordered, so the oldest is first.
	 */
	const starts = new Map<string, { at: number; args: Bag }>();
	let lastAssistantText = "";

	const isExcluded = (toolName: string): boolean => {
		try {
			return deps.excluded?.(toolName) ?? false;
		} catch {
			// Unsure means private: a dropped event costs nothing.
			return true;
		}
	};

	const send = (meta: MetaOf, toolCallId: string | undefined, fields: HookPayload) => {
		try {
			if (!deps.enabled()) return;
			deps.send(meta(toolCallId), fields);
		} catch {
			/* fail open: telemetry is never worth an error in a pi handler */
		}
	};

	return {
		reset() {
			starts.clear();
			lastAssistantText = "";
		},
		sessionStart(meta) {
			send(meta, undefined, { hook_event_name: "sessionStart" });
		},
		toolStart(event, meta) {
			try {
				if (!deps.enabled() || parentToolCallId(event)) return;
				const e = bag(event);
				const toolName = String(e?.toolName ?? "");
				if (isExcluded(toolName)) return;
				const id = typeof e?.toolCallId === "string" ? e.toolCallId : undefined;
				const args = capToolInput(bag(e?.args) ?? {});
				if (id) {
					starts.delete(id);
					starts.set(id, { at: now(), args });
					if (starts.size > MAX_PENDING_STARTS) {
						const oldest = starts.keys().next().value;
						if (oldest !== undefined) starts.delete(oldest);
					}
				}
				send(meta, id, {
					hook_event_name: "PreToolUse",
					tool_name: toolName,
					tool_input: args,
				});
			} catch {
				/* fail open */
			}
		},
		toolEnd(event, meta) {
			try {
				if (parentToolCallId(event)) return;
				const e = bag(event);
				const id = typeof e?.toolCallId === "string" ? e.toolCallId : undefined;
				const started = id === undefined ? undefined : starts.get(id);
				if (id !== undefined) starts.delete(id);
				if (!deps.enabled()) return;
				const toolName = String(e?.toolName ?? "");
				if (isExcluded(toolName)) return;
				// pi's own measure when it has one (≥ 1.1); else our timer, if
				// the start was seen.
				const measured = durationMs(event);
				const duration =
					measured ?? (started === undefined ? undefined : Math.max(0, Math.round(now() - started.at)));
				const text = truncateForObserve(textOfAny(bag(e?.result)?.content));
				const common = {
					tool_name: toolName,
					// tool_execution_end carries no args: the start's are sent again,
					// as Boost's own integrations do. Boost closes the PreToolUse row
					// by tool_use_id, which the meta supplies.
					tool_input: started?.args ?? {},
					...(duration !== undefined ? { duration_ms: duration } : {}),
				};
				send(
					meta,
					id,
					e?.isError === true
						? { hook_event_name: "PostToolUseFailure", ...common, error_message: text || "tool error" }
						: { hook_event_name: "PostToolUse", ...common, tool_output: text },
				);
			} catch {
				/* fail open */
			}
		},
		message(event) {
			try {
				if (!deps.enabled()) return;
				const message = bag(bag(event)?.message);
				if (message?.role !== "assistant") return;
				const text = textOfAny(message.content).trim();
				if (text) lastAssistantText = truncateForObserve(text);
			} catch {
				/* fail open: only telemetry reads this */
			}
		},
		settled(event, ctx, meta) {
			const text = lastAssistantText;
			lastAssistantText = "";
			// An aborted run's last text is a fragment the user cut off, not a reply.
			let wasAborted = false;
			try {
				wasAborted = aborted(event, ctx);
			} catch {
				wasAborted = true;
			}
			if (!text || wasAborted) return;
			send(meta, undefined, { hook_event_name: "afterAgentResponse", text });
		},
		preCompact(event, meta) {
			const reason = bag(event)?.reason;
			send(meta, undefined, {
				hook_event_name: "preCompact",
				trigger: reason === "manual" ? "manual" : "auto",
			});
		},
		postCompact(meta) {
			send(meta, undefined, { hook_event_name: "postCompact" });
		},
	};
}
