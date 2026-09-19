/**
 * Boost hook client.
 *
 * Relays pi tool/lifecycle events to the JFrog Boost CLI using the same hook
 * protocol Boost's official integrations (Claude Code, Codex, Cursor,
 * OpenCode) use. Boost decides what to compress or convert; when it answers
 * with nothing, everything passes through unchanged (fail-open).
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const AGENT_TYPE = "pi";
const HOOK_TIMEOUT_MS = 15_000;
const OBSERVE_TEXT_LIMIT = 16_000;

/** Claude hook protocol names for the pi built-in tools Boost understands. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
	bash: "Bash",
	read: "Read",
};

export function isBoostEnabled(): boolean {
	return process.env.DISABLE_BOOST !== "1";
}

export function boostBinaryPath(): string {
	return process.env.BOOST_BIN ?? `${process.env.HOME ?? ""}/.local/bin/boost`;
}

/** Claude hook protocol name for a pi tool, if Boost knows it. */
export function claudeToolName(toolName: string): string | undefined {
	return CLAUDE_TOOL_NAMES[toolName];
}

/** Best-effort session identifier for hook payloads. */
export function sessionId(ctx: ExtensionContext): string {
	try {
		const sm = ctx.sessionManager as unknown as {
			getSessionFile?: () => string | null;
			getSessionId?: () => string | null;
		};
		const file = sm.getSessionFile?.();
		if (file) return basename(file);
		const id = sm.getSessionId?.();
		if (id) return String(id);
	} catch {
		/* best effort */
	}
	return "pi-session";
}

export type HookPayload = Record<string, unknown>;

/**
 * Pipe a JSON payload to a boost hook subcommand and parse the JSON reply.
 * Resolves undefined on any failure — callers must treat that as pass-through.
 */
export function runHook(args: string[], payload: HookPayload, ctx?: ExtensionContext): Promise<HookPayload | undefined> {
	return new Promise((resolve) => {
		if (!isBoostEnabled()) return resolve(undefined);
		let child;
		try {
			child = spawn(boostBinaryPath(), args, {
				stdio: ["pipe", "pipe", "ignore"],
				env: { ...process.env, BOOST_AGENT_TYPE: AGENT_TYPE },
				cwd: ctx?.cwd || process.cwd(),
			});
		} catch {
			return resolve(undefined);
		}
		let out = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), HOOK_TIMEOUT_MS);
		const done = (value: HookPayload | undefined) => {
			clearTimeout(timer);
			resolve(value);
		};
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.on("error", () => done(undefined));
		child.on("close", (code) => {
			if (code !== 0) return done(undefined);
			const text = out.trim();
			if (!text.startsWith("{")) return done(undefined);
			try {
				done(JSON.parse(text) as HookPayload);
			} catch {
				done(undefined);
			}
		});
		try {
			child.stdin.end(JSON.stringify(payload));
		} catch {
			child.kill("SIGKILL");
		}
	});
}

/**
 * Fire-and-forget observe call. Never awaited, never throws — observe
 * telemetry must not slow down or break the session.
 */
export function observeDetached(payload: HookPayload, ctx?: ExtensionContext): void {
	if (!isBoostEnabled()) return;
	try {
		const child = spawn(boostBinaryPath(), ["hook", "observe", "claude"], {
			stdio: ["pipe", "ignore", "ignore"],
			env: { ...process.env, BOOST_AGENT_TYPE: AGENT_TYPE },
			cwd: ctx?.cwd || process.cwd(),
			detached: true,
		});
		child.on("error", () => {});
		child.stdin.end(JSON.stringify({ agent_type: AGENT_TYPE, ...payload }));
		child.unref();
	} catch {
		/* fail open */
	}
}

/** Map pi tool input to the Claude hook protocol input shape. */
export function toClaudeInput(toolName: string, input: HookPayload): HookPayload {
	const mapped: HookPayload = { ...input };
	if (toolName === "read" && typeof mapped.path === "string") {
		mapped.file_path = mapped.path;
		delete mapped.path;
	}
	return mapped;
}

/**
 * Apply Claude-style `updatedInput` keys back onto pi's tool input (in place).
 * pi's read tool uses `path` where the Claude protocol uses `file_path`.
 */
export function applyUpdatedInput(eventInput: HookPayload, updated: HookPayload): void {
	for (const [key, value] of Object.entries(updated)) {
		eventInput[key === "file_path" ? "path" : key] = value;
	}
}

/** Concatenate the text blocks of a pi message/tool content array. */
export function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: string }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

/** Truncate text for observe payloads (Boost stores summaries, not transcripts). */
export function truncateForObserve(text: string): string {
	return text.length > OBSERVE_TEXT_LIMIT ? text.slice(0, OBSERVE_TEXT_LIMIT) : text;
}
