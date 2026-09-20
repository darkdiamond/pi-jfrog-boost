/**
 * Boost CLI client.
 *
 * Talks to JFrog Boost over its agent-neutral surfaces — the stdin filter,
 * `boost read`, `boost sync` — which take the agent identity from
 * `BOOST_HOOK_META` and so record pi's work as pi's. See `tools.ts` for why the
 * `boost hook <agent>` dialects are deliberately not used.
 *
 * Everything here fails open. A missing, slow, or broken Boost binary resolves
 * to `undefined` and the caller keeps the original value, so a broken Boost can
 * never break a pi session.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
	isSupportedVersion,
	parseBoostVersion,
	type ResolveOptions,
	resolveBoostBinary,
} from "./boost-binary.ts";

/** Identifies pi in Boost's telemetry. */
export const AGENT_TYPE = "pi";
/**
 * Boost's observe hook has no pi dialect; `boost hook observe claude` files
 * whatever it receives under Claude Code. That is only acceptable when the user
 * asks for it, so lifecycle telemetry is opt-in — see `observeEnabled`.
 */
const OBSERVE_DIALECT = "claude";
const HOOK_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 5_000;
const SYNC_TIMEOUT_MS = 60_000;
/** Ceiling Boost's own OpenCode plugin uses before it stops filtering. */
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export type HookPayload = Record<string, unknown>;

/** Session-scoped fields every Boost hook payload carries. */
export interface HookMeta {
	session_id: string;
	cwd: string;
	tool_use_id?: string;
}

export interface RunResult {
	/** Exit code, or null when the process was killed or never started. */
	code: number | null;
	stdout: string;
}

export interface BoostClientDeps {
	spawn?: typeof spawn;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	home?: string;
	/** Injected by tests in place of a real filesystem search. */
	resolveBinary?: (options: ResolveOptions) => string | undefined;
}

export interface BoostClient {
	/** Live kill switch: re-read on every call so `DISABLE_BOOST=1` takes effect at once. */
	enabled(): boolean;
	/** The resolved binary, or undefined when Boost is not installed. */
	binary(): string | undefined;
	/** Re-run binary resolution and drop the cached capability check. */
	refresh(): void;
	/** Enabled, installed, and new enough to speak the hook protocol. Probed once. */
	ready(): Promise<boolean>;
	/** Whether the user opted into lifecycle telemetry (`PI_BOOST_OBSERVE=1`). */
	observeEnabled(): boolean;
	/** Pipe text through Boost's stdin filter. Undefined means "keep the original". */
	filter(meta: HookMeta, toolInput: HookPayload, text: string): Promise<string | undefined>;
	/** `boost read <path>`: extract text Boost can reach and pi's `read` cannot. */
	read(meta: HookMeta, path: string): Promise<string | undefined>;
	/** `boost hook observe claude`, awaited — callers that want the reply. */
	observe(meta: HookMeta, fields: HookPayload): Promise<HookPayload | undefined>;
	/** `boost hook observe claude`, detached. Telemetry must never block a turn. */
	observeDetached(meta: HookMeta, fields: HookPayload): void;
	/** `boost sync`, detached: drains locally captured spans so `boost report` has data. */
	sync(meta: HookMeta): void;
	/** Run Boost with plain arguments and no stdin. */
	exec(args: string[], cwd: string, timeoutMs?: number): Promise<RunResult>;
}

interface RunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	input?: string;
}

const EMPTY: RunResult = { code: null, stdout: "" };

function run(spawnFn: typeof spawn, exe: string, args: string[], options: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn(exe, args, {
				cwd: options.cwd,
				env: options.env,
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve(EMPTY);
			return;
		}

		let stdout = "";
		let bytes = 0;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: RunResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};
		const abandon = () => {
			child.kill("SIGKILL");
			finish(EMPTY);
		};

		timer = setTimeout(abandon, options.timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			bytes += Buffer.byteLength(chunk);
			// A reply this large is a malfunction, not a compression win.
			if (bytes > MAX_PAYLOAD_BYTES) return abandon();
			stdout += chunk;
		});
		child.on("error", () => finish(EMPTY));
		child.on("close", (code) => finish({ code, stdout }));

		// A missing executable or an early exit closes stdin before we finish
		// writing. Without this listener that EPIPE is an unhandled stream
		// error, which takes the whole pi process down.
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.input ?? "");
	});
}

function parseHookReply(result: RunResult): HookPayload | undefined {
	if (result.code !== 0) return undefined;
	const text = result.stdout.trim();
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as HookPayload) : undefined;
	} catch {
		return undefined;
	}
}

/** Text Boost can accept on stdin: present, not binary, and not absurdly large. */
export function isFilterable(text: string): boolean {
	return text.length > 0 && !text.includes("\0") && Buffer.byteLength(text) <= MAX_PAYLOAD_BYTES;
}

export function createBoostClient(deps: BoostClientDeps = {}): BoostClient {
	const spawnFn = deps.spawn ?? spawn;
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const home = deps.home ?? homedir();
	const resolve = deps.resolveBinary ?? resolveBoostBinary;

	let binary: string | undefined | null = null;
	let readiness: Promise<boolean> | undefined;

	const enabled = () => env.DISABLE_BOOST !== "1";
	const observeEnabled = () => enabled() && env.PI_BOOST_OBSERVE === "1";
	const resolveBinaryOnce = (): string | undefined => {
		if (binary === null) binary = resolve({ env, platform, home });
		return binary;
	};

	/**
	 * Boost reads `BOOST_HOOK_META` to attribute spans to a session and tool
	 * call; its rewritten shell commands thread the same data through
	 * `BOOST_HOOK_META_FILE`. Without it, telemetry lands unattributed.
	 */
	const childEnv = (meta: HookMeta, fields: HookPayload = {}): NodeJS.ProcessEnv => ({
		...env,
		BOOST_AGENT_TYPE: AGENT_TYPE,
		BOOST_HOOK_META: JSON.stringify({ agent_type: AGENT_TYPE, ...meta, ...fields }),
	});

	const payload = (meta: HookMeta, fields: HookPayload): string =>
		JSON.stringify({ agent_type: AGENT_TYPE, ...meta, ...fields });

	const invoke = async (
		args: string[],
		meta: HookMeta,
		fields: HookPayload,
		input: string,
		timeoutMs = HOOK_TIMEOUT_MS,
	): Promise<RunResult> => {
		const exe = resolveBinaryOnce();
		if (!exe || !enabled()) return EMPTY;
		return run(spawnFn, exe, args, {
			cwd: meta.cwd,
			env: childEnv(meta, fields),
			timeoutMs,
			input,
		});
	};

	/**
	 * Detached and unref'd: an observe or sync call must not hold up a turn, and
	 * must survive pi exiting. Windows has no `detached` equivalent that avoids
	 * allocating a console window, so it stays attached there with the window
	 * hidden — the same trade-off Boost's OpenCode plugin makes.
	 */
	const fireAndForget = (args: string[], meta: HookMeta, fields: HookPayload, input?: string): void => {
		const exe = resolveBinaryOnce();
		if (!exe || !enabled()) return;
		try {
			const child = spawnFn(exe, args, {
				cwd: meta.cwd,
				env: childEnv(meta, fields),
				stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
				detached: platform !== "win32",
				windowsHide: true,
			});
			child.on("error", () => {});
			if (input !== undefined) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(input);
			}
			child.unref();
		} catch {
			/* fail open */
		}
	};

	/**
	 * Installed, new enough, and not switched off. Probed at most once per
	 * client; `DISABLE_BOOST` is checked before the probe as well as after, so a
	 * disabled session never spawns Boost and a re-enabled one still probes.
	 */
	const ready = (): Promise<boolean> => {
		if (!enabled()) return Promise.resolve(false);
		readiness ??= (async () => {
			const exe = resolveBinaryOnce();
			if (!exe) return false;
			const result = await run(spawnFn, exe, ["version"], {
				cwd: home,
				env,
				timeoutMs: VERSION_TIMEOUT_MS,
			});
			return result.code === 0 && isSupportedVersion(parseBoostVersion(result.stdout));
		})();
		return readiness.then((supported) => supported && enabled());
	};

	return {
		enabled,
		observeEnabled,
		ready,
		binary: resolveBinaryOnce,
		refresh() {
			binary = null;
			readiness = undefined;
		},
		async read(meta, path) {
			if (!(await ready())) return undefined;
			const result = await invoke(["read", path], meta, {}, "", READ_TIMEOUT_MS);
			if (result.code !== 0) return undefined;
			return result.stdout.trim() ? result.stdout : undefined;
		},
		async filter(meta, toolInput, text) {
			if (!isFilterable(text) || !(await ready())) return undefined;
			const result = await invoke([], meta, { tool_input: toolInput }, text);
			if (result.code !== 0) return undefined;
			const filtered = result.stdout;
			return filtered.trim() && filtered !== text ? filtered : undefined;
		},
		async observe(meta, fields) {
			if (!observeEnabled() || !(await ready())) return undefined;
			const args = ["hook", "observe", OBSERVE_DIALECT];
			return parseHookReply(await invoke(args, meta, fields, payload(meta, fields)));
		},
		observeDetached(meta, fields) {
			if (!observeEnabled()) return;
			fireAndForget(["hook", "observe", OBSERVE_DIALECT], meta, fields, payload(meta, fields));
		},
		sync(meta) {
			fireAndForget(["sync"], meta, { hook_event_name: "stop" });
		},
		async exec(args, cwd, timeoutMs = SYNC_TIMEOUT_MS) {
			const exe = resolveBinaryOnce();
			if (!exe) return EMPTY;
			return run(spawnFn, exe, args, { cwd, env, timeoutMs });
		},
	};
}
