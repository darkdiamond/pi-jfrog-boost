/**
 * Structural access to pi event fields that differ between the supported pi
 * lines (spec §2).
 *
 * The extension supports pi 0.86.1 through 1.2.0 with a peer range of `"*"`.
 * Several fields it relies on only exist on 1.x — `structuredContent`,
 * `parentToolCallId`, `durationMs`, `aborted`, `messageType`, the tool
 * loadout — so reading them through the SDK types would fail to typecheck on
 * 0.86.1, and gating on a `VERSION` constant would mean importing a value from
 * pi (every pi import in `src/` must stay type-only, so the package loads
 * under any pi that provides the types at all). Instead every access goes
 * through these accessors, which treat the event as an unknown record and
 * check what is actually there. Feature detection, not version detection:
 * a fork or a pre-release that has the field gets the behaviour.
 */
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { ContentBlock } from "./content.ts";

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | undefined {
	return typeof value === "object" && value !== null ? (value as Bag) : undefined;
}

/**
 * The id of the tool call that made this one (pi ≥ 1.x codemode, subagent
 * tools). A nested call's output goes back to the calling script, not to the
 * model, so it is never touched (invariant 5).
 */
export function parentToolCallId(event: unknown): string | undefined {
	const id = bag(event)?.parentToolCallId;
	return typeof id === "string" && id ? id : undefined;
}

/** The tool's machine-readable result (pi ≥ 1.x), or undefined. */
export function structuredContentOf(event: unknown): unknown {
	return bag(event)?.structuredContent;
}

/**
 * Whether the event carries structured content. pi 1.x drops it when a
 * handler replaces `content` without returning it, so every patch must pass
 * it through when this is true.
 */
export function hasStructured(event: unknown): boolean {
	return structuredContentOf(event) !== undefined;
}

/** How long the tool ran, as pi ≥ 1.x measures it on `tool_execution_end`. */
export function durationMs(event: unknown): number | undefined {
	const ms = bag(event)?.durationMs;
	return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * Whether the run was aborted. `agent_settled` reports it on 1.x; on 0.86
 * the context's abort signal is the only evidence there is.
 */
export function aborted(event: unknown, ctx?: unknown): boolean {
	const flag = bag(event)?.aborted;
	if (typeof flag === "boolean") return flag;
	const signal = bag(ctx)?.signal;
	return bag(signal)?.aborted === true;
}

/**
 * What started a `before_agent_start` run. 1.x distinguishes a user prompt
 * from a custom message with `triggerTurn`; 0.86 only has user prompts.
 */
export function messageType(event: unknown): string {
	const type = bag(event)?.messageType;
	return typeof type === "string" && type ? type : "user";
}

function strings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * The tools the model can see, from `before_agent_start`'s
 * `systemPromptOptions` (`selectedTools`, and on 1.x `hiddenTools`). Either
 * may be absent; the awareness text then assumes `bash` is visible.
 */
export function loadout(event: unknown): { selected?: string[]; hidden?: string[] } {
	const options = bag(bag(event)?.systemPromptOptions);
	const selected = strings(options?.selectedTools);
	const hidden = strings(options?.hiddenTools);
	return { ...(selected ? { selected } : {}), ...(hidden ? { hidden } : {}) };
}

/** Whether this pi can wrap tool rendering (pi ≥ 1.0.1), which badges need. */
export function canRenderTools(pi: ExtensionAPI): boolean {
	return typeof (pi as unknown as Bag).registerToolRenderer === "function";
}

/**
 * What a `tool_result` handler returns, declared here rather than taken from
 * the SDK because 0.86.1's `ToolResultEventResult` has no
 * `structuredContent`: returning it there is an excess-property error, yet it
 * must be returned on 1.x or pi drops the tool's structured output.
 */
export interface ToolResultPatch {
	content?: ContentBlock[];
	details?: unknown;
	isError?: boolean;
	structuredContent?: unknown;
}

/**
 * The one cast from {@link ToolResultPatch} to the SDK's result type. On
 * 0.86.1 the extra `structuredContent` is simply ignored by the runner; on
 * 1.x it is applied.
 */
export function asResult(patch: ToolResultPatch): ToolResultEventResult {
	return patch as unknown as ToolResultEventResult;
}
