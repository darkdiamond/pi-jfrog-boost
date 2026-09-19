/**
 * pi-jfrog-boost — JFrog Boost integration for the pi coding agent.
 *
 * Methodology mirrors Boost's official editor integrations (Claude Code,
 * Codex, Cursor, OpenCode):
 *
 *   pi event            Boost hook                    effect
 *   ------------------  ----------------------------  -------------------------
 *   tool_call           PreToolUse (`hook claude`)    Bash auto-rewrite, Read
 *                                                     doc conversion via
 *                                                     updatedInput
 *   tool_result         PostToolUse (`hook claude`)   compressed output +
 *                                                     additional context
 *   session/turn life   `hook observe claude`         telemetry for `boost
 *   cycle events                                      report`
 *
 * Everything is fail-open: if Boost is missing, slow, or silent, tool calls
 * and results pass through untouched. Set DISABLE_BOOST=1 to disable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyUpdatedInput,
	claudeToolName,
	isBoostEnabled,
	observeDetached,
	runHook,
	sessionId,
	textOf,
	toClaudeInput,
	truncateForObserve,
	type HookPayload,
} from "./boost-client.js";
import { ensureBoostInstalled } from "./bootstrap.js";

type TextBlock = { type: "text"; text: string };

export default async function boostExtension(pi: ExtensionAPI) {
	// pi awaits async factories before the session starts: install Boost on
	// first run if it is missing (opt-out via PI_JFROG_BOOST_AUTOINSTALL=0).
	await ensureBoostInstalled();
	// Hint line returned by observe sessionStart (daily tips); injected once.
	let pendingHint: string | undefined;
	// Most recent assistant response text, for the afterAgentResponse observe.
	let lastAssistantText = "";

	pi.on("session_start", async (_event, ctx) => {
		pendingHint = undefined;
		lastAssistantText = "";
		observeDetached(
			{ hook_event_name: "sessionStart", session_id: sessionId(ctx), cwd: ctx.cwd },
			ctx,
		);
	});

	// Inject a sessionStart hint (e.g. daily tip) into the next system prompt,
	// like the OpenCode integration's system transform does.
	pi.on("before_agent_start", async (event) => {
		if (!pendingHint) return;
		const line = pendingHint;
		pendingHint = undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${line}` };
	});

	// PreToolUse: let Boost rewrite Bash commands and convert Read documents.
	pi.on("tool_call", async (event, ctx) => {
		const claudeName = claudeToolName(event.toolName);
		if (!claudeName) return;

		const res = await runHook(
			["hook", "claude"],
			{
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				hook_event_name: "PreToolUse",
				tool_name: claudeName,
				tool_input: toClaudeInput(event.toolName, event.input as HookPayload),
			},
			ctx,
		);

		const out = res?.hookSpecificOutput as HookPayload | undefined;
		if (out?.updatedInput && typeof out.updatedInput === "object") {
			applyUpdatedInput(event.input as HookPayload, out.updatedInput as HookPayload);
		}
	});

	// PostToolUse: Boost may replace the output with a compressed version and
	// append context (e.g. `boost retrieve` hints).
	pi.on("tool_result", async (event, ctx) => {
		const claudeName = claudeToolName(event.toolName);
		if (!claudeName) return;

		const text = textOf(event.content);
		if (!text) return;

		const res = await runHook(
			["hook", "claude"],
			{
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				hook_event_name: "PostToolUse",
				tool_name: claudeName,
				tool_input: toClaudeInput(event.toolName, event.input as HookPayload),
				tool_response: {
					stdout: text,
					stderr: "",
					exitCode: (event.details as { exitCode?: number } | undefined)?.exitCode ?? 0,
				},
			},
			ctx,
		);
		if (!res) return;

		const out = res.hookSpecificOutput as HookPayload | undefined;
		const additionalContext =
			typeof out?.additionalContext === "string" ? out.additionalContext : undefined;
		const updatedOutput =
			typeof res.updatedOutput === "string" ? res.updatedOutput : undefined;
		if (!additionalContext && !updatedOutput) return;

		const content = [...event.content];

		if (updatedOutput) {
			const idx = content.findIndex(
				(b) => (b as { type?: string } | null)?.type === "text",
			);
			const block: TextBlock = { type: "text", text: updatedOutput };
			if (idx >= 0) content[idx] = block;
			else content.push(block);
		}
		if (additionalContext) {
			content.push({ type: "text", text: `[boost] ${additionalContext}` } satisfies TextBlock);
		}
		return { content };
	});

	// Track the most recent assistant response for observe telemetry.
	pi.on("message_end", async (event) => {
		if (event.message?.role !== "assistant") return;
		const text = textOf(event.message.content);
		if (text.trim()) lastAssistantText = truncateForObserve(text);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!isBoostEnabled() || !lastAssistantText) return;
		observeDetached(
			{
				hook_event_name: "afterAgentResponse",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				text: lastAssistantText,
			},
			ctx,
		);
		lastAssistantText = "";
	});

	pi.on("session_before_compact", async (event, ctx) => {
		observeDetached(
			{
				hook_event_name: "preCompact",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				trigger: event.reason === "manual" ? "manual" : "auto",
			},
			ctx,
		);
	});

	pi.on("session_compact", async (_event, ctx) => {
		observeDetached(
			{ hook_event_name: "postCompact", session_id: sessionId(ctx), cwd: ctx.cwd },
			ctx,
		);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// Detached + unref: shutdown must never block on the observe call.
		observeDetached(
			{
				hook_event_name: "SessionEnd",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				reason: event.reason,
			},
			ctx,
		);
	});
}
