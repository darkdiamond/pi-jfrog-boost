/**
 * A stand-in for pi's extension host, shared by the suites that drive the
 * extension (spec §16.2).
 *
 * It covers the API surface the extension uses on both supported pi lines —
 * `on`, `registerFlag`/`getFlag`, `registerCommand` (with argument
 * completions), `appendEntry`, `exec`, and on 1.x `registerToolRenderer` —
 * and a context with `sessionManager.getBranch/getEntries` and a scriptable
 * `ui` (notify, select, confirm, input, setStatus, theme). Everything the
 * extension does through it is recorded for assertions, and `exec` holds the
 * never-spawn rule like the spawn spy does for real processes.
 *
 * Event factories come in two shapes because the extension must work on both:
 *   - 0.86-shaped: what pi 0.86.1 emits — no `structuredContent`,
 *     `parentToolCallId`, `durationMs`, `aborted` or `messageType`;
 *   - 1.2-shaped: what pi 1.2.0 emits, with all of them.
 * `emitToolResult` replays pi's `ExtensionRunner.emitToolResult` patch
 * semantics for the chosen line; on 1.2 a handler that replaces `content`
 * without returning `structuredContent` deletes it (runner.js), which is how
 * 0.3.0 lost structured output without any test noticing.
 *
 * Only types are imported from pi; this file must typecheck against 0.86.1
 * and 1.2.0 alike, so 1.x-only members are reached structurally.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertAllowedSpawn } from "./spawn-spy.ts";

export type PiLine = "0.86" | "1.2";

/**
 * The version of pi installed next to the tests. `npm run test:e2e:min` and
 * the CI min leg swap 0.86.1 in under the same package.json, so the declared
 * devDependency says nothing; the package's own manifest does. Its `exports`
 * map hides `package.json`, so it is found from the resolved entry point.
 */
export function installedPiVersion(): string | undefined {
	try {
		let at = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		for (let depth = 0; depth < 5; depth++) {
			try {
				const manifest = JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				if (manifest.name === "@earendil-works/pi-coding-agent") return manifest.version;
			} catch {
				/* not here; keep walking up */
			}
			at = dirname(at);
		}
	} catch {
		/* not resolvable */
	}
	return undefined;
}

/** Which event shapes and runner semantics the installed pi has: 0.x is the 0.86 line. */
export function installedPiLine(): PiLine {
	return installedPiVersion()?.startsWith("0.") ? "0.86" : "1.2";
}

/** A handler as `pi.on` receives it. */
export type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}
export type Block = TextBlock | ImageBlock;

/** What a `tool_result` handler may return. Mirrors pi's ToolResultEventResult structurally. */
export interface ToolResultPatch {
	content?: Block[];
	details?: unknown;
	isError?: boolean;
	structuredContent?: unknown;
	usage?: unknown;
}

export interface ToolResultEventShape {
	type: "tool_result";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: Block[];
	details: unknown;
	isError: boolean;
	structuredContent?: unknown;
	parentToolCallId?: string;
	usage?: unknown;
}

export interface ToolResultInit {
	toolName: string;
	input?: Record<string, unknown>;
	/** A string becomes one text block. */
	content?: string | Block[];
	details?: unknown;
	isError?: boolean;
	toolCallId?: string;
	/** 1.2 only; ignored for 0.86-shaped events. */
	structuredContent?: unknown;
	/** 1.2 only; ignored for 0.86-shaped events. */
	parentToolCallId?: string;
}

let ids = 0;

function blocks(content: string | Block[] | undefined): Block[] {
	if (content === undefined) return [];
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** A `tool_result` event as pi `line` would emit it. */
export function toolResultEvent(line: PiLine, init: ToolResultInit): ToolResultEventShape {
	const event: ToolResultEventShape = {
		type: "tool_result",
		toolName: init.toolName,
		toolCallId: init.toolCallId ?? `call-${++ids}`,
		input: init.input ?? {},
		content: blocks(init.content),
		details: init.details,
		isError: init.isError ?? false,
	};
	if (line === "1.2") {
		if (init.structuredContent !== undefined) event.structuredContent = init.structuredContent;
		if (init.parentToolCallId !== undefined) event.parentToolCallId = init.parentToolCallId;
	}
	return event;
}

export const toolResult86 = (init: ToolResultInit) => toolResultEvent("0.86", init);
export const toolResult12 = (init: ToolResultInit) => toolResultEvent("1.2", init);

export function toolExecutionStartEvent(
	line: PiLine,
	init: { toolName: string; args?: Record<string, unknown>; toolCallId?: string; parentToolCallId?: string },
) {
	return {
		type: "tool_execution_start" as const,
		toolCallId: init.toolCallId ?? `call-${++ids}`,
		toolName: init.toolName,
		args: init.args ?? {},
		...(line === "1.2" && init.parentToolCallId !== undefined
			? { parentToolCallId: init.parentToolCallId }
			: {}),
	};
}

export function toolExecutionEndEvent(
	line: PiLine,
	init: {
		toolName: string;
		result?: unknown;
		isError?: boolean;
		toolCallId?: string;
		durationMs?: number;
		parentToolCallId?: string;
	},
) {
	return {
		type: "tool_execution_end" as const,
		toolCallId: init.toolCallId ?? `call-${++ids}`,
		toolName: init.toolName,
		result: init.result ?? { content: [] },
		isError: init.isError ?? false,
		...(line === "1.2" && init.durationMs !== undefined ? { durationMs: init.durationMs } : {}),
		...(line === "1.2" && init.parentToolCallId !== undefined
			? { parentToolCallId: init.parentToolCallId }
			: {}),
	};
}

export interface SystemPromptOptionsShape {
	sections?: Record<string, string>;
	[key: string]: unknown;
}

export function beforeAgentStartEvent(
	line: PiLine,
	init: {
		prompt?: string;
		systemPrompt?: string;
		/** `undefined` builds a pi without structured sections. */
		sections?: Record<string, string> | undefined;
		messageType?: "user" | "custom";
	} = {},
) {
	const systemPromptOptions: SystemPromptOptionsShape = init.sections ? { sections: init.sections } : {};
	const base = {
		type: "before_agent_start" as const,
		systemPrompt: init.systemPrompt ?? "You are pi.",
		systemPromptOptions,
	};
	if (line === "0.86") return { ...base, prompt: init.prompt ?? "hello" };
	if (init.messageType === "custom") {
		return {
			...base,
			messageType: "custom" as const,
			message: { role: "custom", customType: "test", content: "hi", display: true, timestamp: 0 },
		};
	}
	return { ...base, messageType: "user" as const, prompt: init.prompt ?? "hello" };
}

export function agentSettledEvent(line: PiLine, init: { aborted?: boolean } = {}) {
	return line === "1.2"
		? { type: "agent_settled" as const, aborted: init.aborted ?? false }
		: { type: "agent_settled" as const };
}

export function sessionStartEvent(reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup") {
	return { type: "session_start" as const, reason };
}

export function messageEndEvent(role: "assistant" | "user", text: string) {
	return {
		type: "message_end" as const,
		message: { role, content: [{ type: "text", text }], timestamp: 0 },
	};
}

/**
 * Apply `tool_result` handler results the way pi's runner does. Handlers see
 * the event as patched by earlier handlers; a throw is recorded and skipped,
 * as pi reports it without failing the tool. Returns `undefined` when no
 * handler changed anything, like pi.
 */
export async function applyToolResultHandlers(
	line: PiLine,
	handlers: readonly Handler[],
	event: ToolResultEventShape,
	ctx: ExtensionContext,
	errors: unknown[] = [],
): Promise<ToolResultPatch | undefined> {
	const current: ToolResultEventShape = { ...event };
	let modified = false;
	for (const handler of handlers) {
		let result: ToolResultPatch | undefined;
		try {
			result = (await handler(current, ctx)) as ToolResultPatch | undefined;
		} catch (error) {
			errors.push(error);
			continue;
		}
		if (!result) continue;
		if (result.content !== undefined) {
			current.content = result.content;
			// pi 1.x: structured content not replaced along with the content may
			// no longer match it, so the runner drops it.
			if (line === "1.2" && result.structuredContent === undefined) delete current.structuredContent;
			modified = true;
		}
		if (result.details !== undefined) {
			current.details = result.details;
			modified = true;
		}
		if (line === "1.2" && result.structuredContent !== undefined) {
			current.structuredContent = result.structuredContent;
			modified = true;
		}
		if (result.isError !== undefined) {
			current.isError = result.isError;
			modified = true;
		}
		if (result.usage !== undefined) {
			current.usage = result.usage;
			modified = true;
		}
	}
	if (!modified) return undefined;
	const patch: ToolResultPatch = {
		content: current.content,
		details: current.details,
		isError: current.isError,
	};
	if (line === "1.2") patch.structuredContent = current.structuredContent;
	if (current.usage !== undefined) patch.usage = current.usage;
	return patch;
}

// ---------------------------------------------------------------------------
// The host stub

export interface RegisteredCommandShape {
	description?: string;
	handler: (args: string, ctx: ExtensionContext) => unknown;
	getArgumentCompletions?: (prefix: string) => unknown;
}

export interface FlagShape {
	type: "boolean" | "string";
	default?: boolean | string;
	description?: string;
}

/** Scripted answers for blocking UI prompts, consumed in order. */
export interface UiScript {
	/** Each answer is the option to pick (by exact text), or undefined for Escape. */
	select?: (string | undefined)[];
	confirm?: boolean[];
	input?: (string | undefined)[];
}

export interface UiRecord {
	notices: { message: string; level: string | undefined }[];
	statuses: { key: string; text: string | undefined }[];
	selects: { title: string; options: string[] }[];
	confirms: { title: string; message: string | undefined }[];
	inputs: { title: string; placeholder: string | undefined }[];
}

export interface PiStubOptions {
	/** Which pi line to imitate. Default `1.2`. */
	line?: PiLine;
	/** Whether `registerToolRenderer` exists. Default: true on 1.2, false on 0.86. */
	renderer?: boolean;
	/** CLI flag values, as `pi.getFlag` would return them. */
	flags?: Record<string, boolean | string | undefined>;
	/** Session entries for `getBranch` (and `getEntries`, unless given). */
	branch?: unknown[];
	entries?: unknown[];
	hasUI?: boolean;
	cwd?: string;
	sessionId?: string;
	ui?: UiScript;
	/** Replaces the default `pi.exec`, which succeeds with no output. */
	exec?: (command: string, args: string[], options?: unknown) => Promise<unknown>;
	/** Abort signal on the context (1.x surfaces `ctx.signal`). */
	signal?: AbortSignal;
}

export interface PiStub {
	pi: ExtensionAPI;
	line: PiLine;
	handlers: Map<string, Handler[]>;
	commands: Map<string, RegisteredCommandShape>;
	flags: Map<string, FlagShape>;
	/** Values `getFlag` returns; tests may change them. */
	flagValues: Map<string, boolean | string | undefined>;
	/** `appendEntry` calls, in order. */
	appended: { customType: string; data: unknown }[];
	renderers: unknown[];
	execCalls: { command: string; args: string[]; options: unknown }[];
	ui: UiRecord;
	/** Errors thrown by handlers, which pi would report rather than propagate. */
	errors: unknown[];
	/** A context like the one pi passes to handlers. */
	ctx(overrides?: Partial<Record<keyof ExtensionContext, unknown>>): ExtensionContext;
	/** Call every handler for `event` and return their results. */
	fire(event: string, payload: unknown, ctx?: ExtensionContext): Promise<unknown[]>;
	/** Run a tool result through the handlers with pi's patch semantics for this line. */
	emitToolResult(event: ToolResultEventShape, ctx?: ExtensionContext): Promise<ToolResultPatch | undefined>;
	/** Invoke a registered command's handler. */
	command(name: string, args?: string, ctx?: ExtensionContext): Promise<unknown>;
}

/** A plain-text theme: `fg`/`bg`/`bold` return the text unchanged, so assertions see no ANSI. */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	dim: (text: string) => text,
};

export function createPiStub(options: PiStubOptions = {}): PiStub {
	const line = options.line ?? "1.2";
	const withRenderer = options.renderer ?? line === "1.2";
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, RegisteredCommandShape>();
	const flags = new Map<string, FlagShape>();
	const flagValues = new Map<string, boolean | string | undefined>(Object.entries(options.flags ?? {}));
	const appended: { customType: string; data: unknown }[] = [];
	const renderers: unknown[] = [];
	const execCalls: { command: string; args: string[]; options: unknown }[] = [];
	const errors: unknown[] = [];
	const script = {
		select: [...(options.ui?.select ?? [])],
		confirm: [...(options.ui?.confirm ?? [])],
		input: [...(options.ui?.input ?? [])],
	};
	const ui: UiRecord = { notices: [], statuses: [], selects: [], confirms: [], inputs: [] };
	const branch = options.branch ?? [];
	const entries = options.entries ?? branch;

	const api: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, command: RegisteredCommandShape) => commands.set(name, command),
		registerFlag: (name: string, flag: FlagShape) => {
			flags.set(name, flag);
			if (!flagValues.has(name)) flagValues.set(name, flag.default);
		},
		getFlag: (name: string) => flagValues.get(name),
		appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
		exec: async (command: string, args: string[], execOptions?: unknown) => {
			execCalls.push({ command, args, options: execOptions });
			// The stub never reaches child_process, so the spy's patch cannot see
			// this; apply the never-spawn rule here as well (spec invariant 4).
			// The call stays recorded; the promise rejects like a failed spawn.
			assertAllowedSpawn(command, args);
			if (options.exec) return options.exec(command, args, execOptions);
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	if (withRenderer) api.registerToolRenderer = (resolver: unknown) => renderers.push(resolver);
	const pi = api as unknown as ExtensionAPI;

	const uiContext = {
		notify: (message: string, level?: string) => ui.notices.push({ message, level }),
		setStatus: (key: string, text: string | undefined) => ui.statuses.push({ key, text }),
		select: async (title: string, choices: string[]) => {
			ui.selects.push({ title, options: choices });
			return script.select.shift();
		},
		confirm: async (title: string, message?: string) => {
			ui.confirms.push({ title, message });
			return script.confirm.shift() ?? false;
		},
		input: async (title: string, placeholder?: string) => {
			ui.inputs.push({ title, placeholder });
			return script.input.shift();
		},
		theme: plainTheme,
	};

	const ctx = (overrides: Partial<Record<keyof ExtensionContext, unknown>> = {}): ExtensionContext =>
		({
			cwd: options.cwd ?? "/work",
			hasUI: options.hasUI ?? true,
			sessionManager: {
				getSessionId: () => options.sessionId ?? "sess-1",
				getBranch: () => branch,
				getEntries: () => entries,
			},
			ui: uiContext,
			...(options.signal ? { signal: options.signal } : {}),
			...overrides,
		}) as unknown as ExtensionContext;

	const fire = async (event: string, payload: unknown, context = ctx()) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			try {
				results.push(await handler(payload, context));
			} catch (error) {
				errors.push(error);
			}
		}
		return results;
	};

	return {
		pi,
		line,
		handlers,
		commands,
		flags,
		flagValues,
		appended,
		renderers,
		execCalls,
		ui,
		errors,
		ctx,
		fire,
		emitToolResult: (event, context = ctx()) =>
			applyToolResultHandlers(line, handlers.get("tool_result") ?? [], event, context, errors),
		async command(name, args = "", context = ctx()) {
			const command = commands.get(name);
			if (!command) throw new Error(`no command /${name} registered`);
			return command.handler(args, context);
		},
	};
}

/** The text of a result's content, joined the way the extension reads it. */
export function textOfBlocks(content: readonly Block[] | undefined): string {
	return (content ?? [])
		.filter((block): block is TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
