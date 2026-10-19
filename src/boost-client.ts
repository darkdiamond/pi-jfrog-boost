/**
 * Boost CLI client: the surfaces this extension calls, and the environment
 * each one runs in (spec §3, §8.3, §8.5).
 *
 *   surface            command                         used for
 *   -----------------  ------------------------------  -----------------------------
 *   version            boost version                   the readiness probe
 *   filter             boost  (stdin)                  shell and log output
 *   convert            boost read -- <abs>             PDF / Office / notebooks
 *   mcp                boost hook claude  (stdin)      mcp__* tool results
 *   observeDetached    boost hook observe claude       opt-in lifecycle telemetry
 *   sync               boost sync --max-batches 20     idle-time upload
 *   exec               boost <args>                    /boost report, /boost doctor
 *
 * There is deliberately no retrieve, feature-flags, init or filters method,
 * and `exec` refuses them: each mutates Boost's state for every agent on the
 * machine (a retrieve counts towards Boost switching a filter off globally,
 * `feature-flags` rewrites ~/.boost/config.toml, `init` accepts JFrog's
 * agreement and installs hooks into other agents). Only the model, through
 * its own shell, or the user may run them (invariant 4).
 *
 * Attribution, as measured on Boost v0.15.4 (spec §14, Probe 1):
 *
 *   surface                          span session.agent_type  Boost session list (conversations.tool)
 *   -------------------------------  -----------------------  ---------------------------------------
 *   stdin filter, `boost read`       pi                       claude_code (Boost does not recognise pi)
 *   `boost hook claude` (MCP)        claude_code              claude_code; mcp_tool_calls.agent_type =
 *                                                             claude_code, no conversation id
 *   `boost hook observe claude`      pi (never rewrites       claude_code; creates and closes
 *   (opt-in)                         earlier spans)           agent_tool_calls rows
 *   `boost sync`                     unchanged                unchanged; uploads, then prunes local
 *                                                             rows (≥ 0.13.29)
 *
 * The span's agent type comes only from `BOOST_HOOK_META.agent_type`
 * (`BOOST_AGENT_TYPE` and the stdin `agent_type` have no visible effect), so
 * every surface that honours it records `pi`. `conversations.tool` maps the
 * agents Boost knows and falls back to `claude_code` for anything else, which
 * is why every pi session is listed as claude_code whatever the surface —
 * observe included; it does not cause the label. `hook claude` ignores
 * `BOOST_HOOK_META` for MCP and stamps `claude_code` itself; it is used
 * because it is the only surface that runs Boost's MCP filters. `hook
 * opencode` is never used: it would split one pi session across two agents.
 * AGENT_TYPE and HOOK_DIALECT stay single constants, so adopting a future
 * `pi` agent type in Boost is a one-line change.
 *
 * Everything here fails open: every method resolves, never rejects, and a
 * result the caller cannot use means "keep the original".
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { type ResolveOptions, resolveBoostBinary } from "./boost-binary.ts";
import {
	type BoostConfig,
	CLI_FILTERING_FLAG,
	createConfigReader,
	envList,
	FLAGS_TTL,
	flagsFreshness,
} from "./boost-config.ts";
import {
	createProcessRunner,
	type Launcher,
	type ProcessRunner,
	type ProcessRunnerDeps,
	type RunResult,
} from "./boost-process.ts";
import type { Breaker } from "./health.ts";
import { envKillSwitch, type ShellMode } from "./settings.ts";

export type { Launcher, RunResult } from "./boost-process.ts";

/** Identifies pi in Boost's telemetry. */
export const AGENT_TYPE = "pi";
/** Boost's hook dialect for MCP and observe; it has none for pi. */
export const HOOK_DIALECT = "claude";

/** The largest output sent to Boost on stdin (was 4 MiB in 0.3.0). */
export const MAX_INPUT_BYTES = 1024 * 1024;
/** Replies larger than this are a malfunction: the child is killed and nothing is used. */
export const FILTER_STDOUT_CAP = 2 * 1024 * 1024;
export const CONVERT_STDOUT_CAP = 16 * 1024 * 1024;
const VERSION_STDOUT_CAP = 64 * 1024;
const EXEC_STDOUT_CAP = 2 * 1024 * 1024;
/**
 * `tool_input` larger than this is left out of `BOOST_HOOK_META`. Boost only
 * reads the command from it, and a single environment variable is capped at
 * 128 KiB on Linux: a heredoc-sized command would make the spawn fail with
 * E2BIG, which the breaker would count as Boost failing.
 */
const MAX_META_TOOL_INPUT = 16 * 1024;

/** Boost subcommands this extension must never run (invariant 4). */
export const FORBIDDEN_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"retrieve",
	"feature-flags",
	"init",
	"filters",
]);

export interface BoostTimeouts {
	/** Fixed filter/MCP timeout; unset (the default) scales with input size, see {@link filterTimeoutMs}. */
	filter?: number;
	convert: number;
	version: number;
	exec: number;
	/** Detached `boost sync` is killed after this long. */
	syncWatchdog: number;
	/**
	 * Detached `boost hook observe claude` is killed after this long. One runs
	 * per tool start, tool end, settle and compaction, so a hung Boost would
	 * otherwise leave a growing pile of children behind.
	 */
	observeWatchdog: number;
}

export const DEFAULT_TIMEOUTS: Readonly<BoostTimeouts> = {
	convert: 20_000,
	version: 8_000,
	exec: 30_000,
	syncWatchdog: 120_000,
	observeWatchdog: 30_000,
};

/** Filter and MCP: `min(10 s, 3 s + 4 ms per KiB)` (spec §8.5). */
export function filterTimeoutMs(bytes: number): number {
	return Math.min(10_000, 3_000 + 4 * Math.ceil(bytes / 1024));
}

/** Session-scoped fields every call carries in `BOOST_HOOK_META`. */
export interface HookMeta {
	session_id: string;
	cwd: string;
	tool_use_id?: string;
}

export type HookPayload = Record<string, unknown>;

/** The surfaces, which differ in the environment they run with (§8.3). */
export type Surface = "version" | "filter" | "convert" | "mcp" | "observe" | "sync" | "exec";

/** Why a call never reached Boost. */
export type SkipReason = "off" | "missing" | "large" | "paused" | "busy" | "forbidden";

export interface BoostCall extends RunResult {
	/** Set when nothing ran; `code` is then null and `stdout` empty. */
	skipped?: SkipReason;
}

export interface CallOptions {
	/** The tool call's abort signal (`ctx.signal`): abort kills the child. */
	signal?: AbortSignal | undefined;
	/** Recorded in `BOOST_HOOK_META.tool_input`. */
	toolInput?: unknown;
	/** Input size for the breaker's "too slow" budget when it is not the stdin (convert). */
	inputBytes?: number;
	/**
	 * The stdin ceiling for this call, when it is not {@link MAX_INPUT_BYTES}:
	 * the shell route's full-output re-filter sends pi's whole saved output,
	 * up to 2 MiB (spec §8.5), where every other route stops at 1 MiB.
	 */
	maxInputBytes?: number;
}

export interface BoostClientDeps {
	spawn?: ProcessRunnerDeps["spawn"];
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	/** Injected by tests in place of a real filesystem search. */
	resolveBinary?: (options: ResolveOptions) => string | undefined;
	/** Injected by tests to run a Node stand-in; defaults to running the binary directly. */
	launcher?: Launcher;
	/** Injected by tests; unset keys keep their defaults. */
	timeouts?: Partial<BoostTimeouts>;
	/** Clock in milliseconds for {@link RunResult.ms}; defaults to `performance.now`. */
	now?: () => number;
	/** Wall clock, for the age of Boost's flag metadata; defaults to `Date.now`. */
	wallClock?: () => number;
	/** Foreground process limit; default 4. */
	concurrency?: number;
	/** Replaces the process layer outright (tests). */
	runner?: ProcessRunner;
	/** Boost's config, read live; defaults to `~/.boost/config.toml`. */
	config?: () => BoostConfig;
	/** The effective `shell` setting, read live; defaults to "auto". */
	shellMode?: () => ShellMode;
	/** Shared by filter, convert and mcp (§8.2). Absent: never paused. */
	breaker?: Breaker;
}

export interface BoostClient {
	/** The resolved binary, or undefined when Boost is not installed. Cached until refresh(). */
	binary(): string | undefined;
	/** Drop the cached binary so the next call resolves it again. */
	refresh(): void;
	/** The environment a surface's child runs with. Exposed for tests and `/boost status`. */
	childEnv(surface: Surface, meta?: HookMeta, toolInput?: unknown): NodeJS.ProcessEnv;
	/** `boost version` with flag fetching disabled: the readiness probe. Not paused by the breaker. */
	version(): Promise<BoostCall>;
	/** Pipe text through Boost's stdin filter. */
	filter(meta: HookMeta, text: string, options?: CallOptions): Promise<BoostCall>;
	/** `boost read -- <path>`: text from a document pi's `read` returns as bytes. */
	convert(meta: HookMeta, path: string, options?: CallOptions): Promise<BoostCall>;
	/** `boost hook claude` with a PostToolUse payload (JSON text) on stdin. */
	mcp(meta: HookMeta, payload: string, options?: CallOptions): Promise<BoostCall>;
	/** `boost hook observe claude`, detached, with a 30 s watchdog. The caller decides whether observe is on. */
	observeDetached(meta: HookMeta, fields: HookPayload): void;
	/** `boost sync --max-batches 20`, detached, with a 120 s watchdog. */
	sync(meta: HookMeta, onExit?: (code: number | null) => void): void;
	/** Run Boost with plain arguments and no stdin (report, doctor). Refuses forbidden subcommands. */
	exec(args: string[], cwd: string, timeoutMs?: number): Promise<BoostCall>;
	/** Kill every foreground child (session shutdown). */
	killAll(): void;
}

const skippedCall = (skipped: SkipReason): BoostCall => ({
	code: null,
	stdout: "",
	ms: 0,
	timedOut: false,
	aborted: false,
	...(skipped === "busy" ? { busy: true } : {}),
	skipped,
});

/** The file's size in bytes, or 0 when it cannot be stat'ed (the call then fails open on its own). */
function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function createBoostClient(deps: BoostClientDeps = {}): BoostClient {
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const home = deps.home ?? homedir();
	const resolve = deps.resolveBinary ?? resolveBoostBinary;
	const timeouts: BoostTimeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
	const runner =
		deps.runner ??
		createProcessRunner({
			...(deps.spawn ? { spawn: deps.spawn } : {}),
			...(deps.launcher ? { launcher: deps.launcher } : {}),
			...(deps.now ? { now: deps.now } : {}),
			...(deps.concurrency !== undefined ? { concurrency: deps.concurrency } : {}),
			platform,
		});
	const readConfig = deps.config ?? createConfigReader().read;
	const shellMode = deps.shellMode ?? (() => "auto" as const);
	const breaker = deps.breaker;
	const wallClock = deps.wallClock ?? Date.now;

	let binary: string | undefined | null = null;
	const resolveOnce = (): string | undefined => {
		if (binary === null) binary = resolve({ env, platform, home });
		return binary;
	};
	const enabled = () => envKillSwitch(env) === undefined;

	/**
	 * The child environment (spec §8.3). The base is pi's own environment plus
	 * the attribution Boost reads (`BOOST_HOOK_META`; `BOOST_AGENT_TYPE` has no
	 * visible effect today and is kept for parity with Boost's plugins). Then:
	 *
	 * - version: flag fetching off, so the probe is ~140 ms and offline-proof.
	 * - filter, convert, mcp, observe, exec: a 24 h flag-cache TTL unless the
	 *   user chose one, because an expired cache makes every call wait ~5 s on
	 *   a refresh (Probe 3). With no `last_updated_at` in config.toml at all —
	 *   a fresh install — even the TTL does not help, and flag fetching is
	 *   turned off for the call (F2: 5.28 s → 0.23 s).
	 *   The same holds for metadata older than the TTL in effect (24 h, or the
	 *   user's own `BOOST_FEATURE_FLAGS_TTL`): offline, a refresh that cannot
	 *   succeed still waits its full 5 s budget on every call and never
	 *   updates the timestamp (no negative cache), so a laptop that was off
	 *   the network for a weekend would pay 5 s per tool result (measured:
	 *   5.18 s, against 0.20 s with fetching off). Fetching is turned off for
	 *   those calls too, and Boost uses the persisted remote and user values.
	 *   This is a deliberate deviation from spec §8.3 as first written: pi's
	 *   own hot-path calls then never refresh stale flags, online or not.
	 *   They are refreshed by the idle-time `boost sync` (below), which runs
	 *   without overrides and does attempt the refresh, or by any other Boost
	 *   integration on the machine. With sync turned off (`sync: false`,
	 *   `PI_BOOST_SYNC=0`) on a machine where pi is the only Boost user, they
	 *   are not refreshed at all until the user runs Boost themselves.
	 * - filter, convert, mcp, observe with `shell: "on"`: `boost-cli-filtering`
	 *   appended to `BOOST_FEATURE_FLAGS_FORCE_ENABLED`. This is how "on"
	 *   works without writing Boost's config: it applies to pi's own children
	 *   only, and works even alongside FLAGS_DISABLE (F1).
	 * - sync: no flag overrides, so the idle-time sync is where Boost may
	 *   refresh stale flags, off every tool's critical path.
	 */

	const childEnv = (surface: Surface, meta?: HookMeta, toolInput?: unknown): NodeJS.ProcessEnv => {
		const out: NodeJS.ProcessEnv = { ...env, BOOST_AGENT_TYPE: AGENT_TYPE };
		if (meta) {
			const hookMeta: Record<string, unknown> = {
				agent_type: AGENT_TYPE,
				session_id: meta.session_id,
				cwd: meta.cwd,
			};
			if (meta.tool_use_id) hookMeta.tool_use_id = meta.tool_use_id;
			if (toolInput !== undefined) {
				const encoded = JSON.stringify(toolInput) ?? "";
				if (encoded.length <= MAX_META_TOOL_INPUT) hookMeta.tool_input = toolInput;
			}
			out.BOOST_HOOK_META = JSON.stringify(hookMeta);
		}
		if (surface === "version") {
			out.BOOST_FEATURE_FLAGS_DISABLE = "1";
			return out;
		}
		if (surface === "sync") return out;
		if (!env.BOOST_FEATURE_FLAGS_TTL) out.BOOST_FEATURE_FLAGS_TTL = FLAGS_TTL;
		if (surface === "exec") return out;
		if (
			env.BOOST_FEATURE_FLAGS_DISABLE === undefined &&
			flagsFreshness(readConfig(), env, wallClock()).stale
		) {
			out.BOOST_FEATURE_FLAGS_DISABLE = "1";
		}
		if (shellMode() === "on") {
			const forced = envList(env.BOOST_FEATURE_FLAGS_FORCE_ENABLED);
			if (!forced.includes(CLI_FILTERING_FLAG)) forced.push(CLI_FILTERING_FLAG);
			out.BOOST_FEATURE_FLAGS_FORCE_ENABLED = forced.join(",");
		}
		return out;
	};

	/**
	 * A foreground call on a surface the breaker guards. Order matters: cheap
	 * refusals (off, missing, too large) come before `allow()`, because in the
	 * half-open state `allow()` hands out the single trial, and every call it
	 * admits must be reported back through `record()`.
	 */
	const guarded = async (
		surface: "filter" | "convert" | "mcp",
		args: string[],
		meta: HookMeta,
		input: string | undefined,
		options: CallOptions,
		limits: { timeoutMs: number; maxStdout: number },
	): Promise<BoostCall> => {
		if (!enabled()) return skippedCall("off");
		const exe = resolveOnce();
		if (!exe) return skippedCall("missing");
		const bytes = options.inputBytes ?? (input === undefined ? 0 : Buffer.byteLength(input));
		const ceiling = options.maxInputBytes ?? MAX_INPUT_BYTES;
		if (input !== undefined && Buffer.byteLength(input) > ceiling) return skippedCall("large");
		if (breaker && !breaker.allow()) return skippedCall("paused");
		let result: RunResult;
		try {
			result = await runner.run(exe, args, {
				cwd: meta.cwd,
				env: childEnv(surface, meta, options.toolInput),
				...(input !== undefined ? { input } : {}),
				timeoutMs: limits.timeoutMs,
				maxStdout: limits.maxStdout,
				signal: options.signal,
			});
		} catch {
			// The runner resolves rather than rejects; this is belt and braces.
			result = { code: null, stdout: "", ms: 0, timedOut: false, aborted: false, spawnError: true };
		}
		breaker?.record(result, bytes);
		return result.busy ? { ...result, skipped: "busy" } : result;
	};

	/** The binary for a detached call, or undefined when it must not run. */
	const detachedBinary = (): string | undefined => (enabled() ? resolveOnce() : undefined);

	return {
		binary: resolveOnce,
		refresh() {
			binary = null;
		},
		childEnv,
		async version() {
			const exe = resolveOnce();
			if (!exe) return skippedCall("missing");
			const result = await runner.run(exe, ["version"], {
				cwd: home,
				env: childEnv("version"),
				timeoutMs: timeouts.version,
				maxStdout: VERSION_STDOUT_CAP,
			});
			return result.busy ? { ...result, skipped: "busy" } : result;
		},
		filter(meta, text, options = {}) {
			const bytes = Buffer.byteLength(text);
			return guarded("filter", [], meta, text, options, {
				timeoutMs: timeouts.filter ?? filterTimeoutMs(bytes),
				maxStdout: FILTER_STDOUT_CAP,
			});
		},
		convert(meta, path, options = {}) {
			// The breaker's "too slow" budget scales with input size (§8.2), and a
			// conversion's input is the file. Without it every conversion would
			// be judged as 0 bytes against the 2.5 s floor, so three ordinary
			// multi-second conversions of a large PDF would pause shell and MCP
			// filtering too, although convert's own timeout is 20 s.
			const sized = options.inputBytes === undefined ? { ...options, inputBytes: fileSize(path) } : options;
			// `--` so a file named like a flag (`-v.pdf`) is read, not parsed.
			return guarded("convert", ["read", "--", path], meta, undefined, sized, {
				timeoutMs: timeouts.convert,
				maxStdout: CONVERT_STDOUT_CAP,
			});
		},
		/**
		 * Why `boost hook claude`, of all the ways into Boost:
		 *
		 * - The stdin filter never runs MCP filters. They are keyed on an MCP
		 *   tool name, and stdin carries no tool name at all, so a Slack or
		 *   Playwright result piped into `boost` comes back as generic text
		 *   (cmax-1, NP5). Only a PostToolUse hook payload reaches them.
		 * - Of the hook dialects, `claude` is the one whose payload shape pi can
		 *   reproduce exactly (`tool_response: {content: [...]}`), and it costs
		 *   nothing in attribution: Boost already lists every pi session as
		 *   `claude_code` (`conversations.tool`, Probe 1), so these calls land
		 *   on the same session label. Their spans and `mcp_tool_calls` rows say
		 *   `claude_code` too; Boost ignores the `pi` in `BOOST_HOOK_META` here.
		 * - `hook opencode` would relabel: its calls are recorded as OpenCode,
		 *   splitting one pi session across two agents in `boost report`.
		 *
		 * Same hot-path environment and size-scaled timeout as `filter`, and the
		 * same breaker: a stalled hook is as slow for the user as a stalled filter.
		 */
		mcp(meta, payload, options = {}) {
			const bytes = Buffer.byteLength(payload);
			return guarded("mcp", ["hook", HOOK_DIALECT], meta, payload, options, {
				timeoutMs: timeouts.filter ?? filterTimeoutMs(bytes),
				maxStdout: FILTER_STDOUT_CAP,
			});
		},
		observeDetached(meta, fields) {
			const exe = detachedBinary();
			if (!exe) return;
			const payload = JSON.stringify({ agent_type: AGENT_TYPE, ...meta, ...fields });
			runner.detached(exe, ["hook", "observe", HOOK_DIALECT], {
				cwd: meta.cwd,
				env: childEnv("observe", meta, fields.tool_input),
				input: payload,
				watchdogMs: timeouts.observeWatchdog,
			});
		},
		sync(meta, onExit) {
			const exe = detachedBinary();
			if (!exe) {
				onExit?.(null);
				return;
			}
			runner.detached(exe, ["sync", "--max-batches", "20"], {
				cwd: meta.cwd,
				env: childEnv("sync", meta),
				watchdogMs: timeouts.syncWatchdog,
				...(onExit ? { onExit } : {}),
			});
		},
		async exec(args, cwd, timeoutMs = timeouts.exec) {
			const sub = args[0];
			if (sub !== undefined && FORBIDDEN_SUBCOMMANDS.has(sub)) return skippedCall("forbidden");
			const exe = resolveOnce();
			if (!exe) return skippedCall("missing");
			const result = await runner.run(exe, args, {
				cwd,
				env: childEnv("exec"),
				timeoutMs,
				maxStdout: EXEC_STDOUT_CAP,
			});
			return result.busy ? { ...result, skipped: "busy" } : result;
		},
		killAll() {
			runner.killAll();
		},
	};
}
