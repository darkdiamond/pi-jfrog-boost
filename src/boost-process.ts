/**
 * Running the Boost binary: the one place this extension starts processes.
 *
 * Every rule that keeps a broken Boost from hurting a pi session lives here,
 * so the surfaces in `boost-client.ts` cannot forget one:
 *
 *   - a timeout, after which the child is SIGKILLed and abandoned;
 *   - `ctx.signal`: when the user presses Escape the child is SIGKILLed at
 *     once and the caller keeps the original result (spec §8.5);
 *   - a stdout cap in "abandon" mode — a reply larger than the cap is a
 *     malfunction, not a compression win, so the child is killed and nothing
 *     of what it printed is used;
 *   - an EPIPE guard on stdin, because a Boost that exits before reading its
 *     input would otherwise raise an unhandled stream error and take pi down;
 *   - a semaphore of 4 foreground processes. Overflow is answered `busy`
 *     immediately and never queued: a queued filter call would make a tool
 *     result wait on other tool results, and passing the output through
 *     unchanged is always acceptable (invariant 2).
 *
 * Results never throw. Every failure is a {@link RunResult} the caller can
 * classify (the breaker in `health.ts` does) and fall back from.
 */
import { spawn } from "node:child_process";

/**
 * How a resolved binary path is turned into a process. The default runs the
 * binary itself; tests map it to `node fake-boost.mjs`, which is what lets the
 * real-process tests run on Windows, where a `#!/bin/sh` stand-in cannot.
 */
export type Launcher = (exe: string) => { file: string; args: string[] };

/** Foreground Boost processes allowed at once (spec §8.5). */
export const DEFAULT_CONCURRENCY = 4;

export interface RunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Written to stdin, which is then closed. Omitted: stdin is closed empty. */
	input?: string;
	timeoutMs: number;
	/** Bytes of stdout after which the child is killed and its output discarded. */
	maxStdout: number;
	signal?: AbortSignal | undefined;
}

export interface RunResult {
	/** Exit code, or null when the process was killed, never started, or not run. */
	code: number | null;
	/** Everything the child printed, or "" when it was abandoned. */
	stdout: string;
	/** Wall time from spawn to settle, by the injected clock; 0 when nothing ran. */
	ms: number;
	/** Killed because it outlived `timeoutMs`. */
	timedOut: boolean;
	/** Killed (or never started) because the caller's signal aborted. */
	aborted: boolean;
	/** Not started: the semaphore was full. Never queued. */
	busy?: boolean;
	/** Not started, or failed to start: no launcher, ENOENT, EACCES and the like. */
	spawnError?: boolean;
	/** Killed because stdout exceeded `maxStdout`. */
	overflow?: boolean;
	/** The signal that ended the child when it was not one this module sent. */
	killedBy?: string;
}

export interface DetachedOptions {
	cwd?: string;
	env: NodeJS.ProcessEnv;
	/** Written to stdin, which is then closed. Omitted: stdin is ignored. */
	input?: string;
	/** Called once when the child exits, fails to start, or is killed by the watchdog. */
	onExit?: (code: number | null) => void;
	/** Kill the child after this long. The timer is unref'd, so it never keeps pi alive. */
	watchdogMs?: number;
}

export interface ProcessRunner {
	run(exe: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
	/**
	 * Fire and forget: the child runs detached and unref'd on every platform, so
	 * it neither blocks a turn nor keeps pi alive, and outlives pi when pi exits.
	 * Not counted by the semaphore — it is never on a tool's critical path.
	 */
	detached(exe: string, args: readonly string[], options: DetachedOptions): void;
	/** Foreground processes running now. */
	active(): number;
	/** SIGKILL every foreground child (session shutdown). Their callers resolve as aborted. */
	killAll(): void;
}

export interface ProcessRunnerDeps {
	spawn?: typeof spawn;
	launcher?: Launcher;
	/** Monotonic clock in milliseconds; defaults to `performance.now`. */
	now?: () => number;
	concurrency?: number;
}

const NOT_RUN: RunResult = { code: null, stdout: "", ms: 0, timedOut: false, aborted: false };

export function createProcessRunner(deps: ProcessRunnerDeps = {}): ProcessRunner {
	const spawnFn = deps.spawn ?? spawn;
	const launcher: Launcher = deps.launcher ?? ((exe) => ({ file: exe, args: [] }));
	// Monotonic, so a wall-clock adjustment mid-call cannot produce a negative or huge duration.
	const now = deps.now ?? (() => performance.now());
	const limit = deps.concurrency ?? DEFAULT_CONCURRENCY;
	/** Kill functions of the foreground children still running. */
	const running = new Set<() => void>();

	const run = (exe: string, args: readonly string[], options: RunOptions): Promise<RunResult> => {
		if (options.signal?.aborted) return Promise.resolve({ ...NOT_RUN, aborted: true });
		if (running.size >= limit) return Promise.resolve({ ...NOT_RUN, busy: true });

		return new Promise((resolve) => {
			const started = now();
			let child: ReturnType<typeof spawn>;
			try {
				const launch = launcher(exe);
				child = spawnFn(launch.file, [...launch.args, ...args], {
					cwd: options.cwd,
					env: options.env,
					stdio: ["pipe", "pipe", "ignore"],
					windowsHide: true,
				});
			} catch {
				// A launcher that throws, or a spawn the spy forbids: fail open.
				resolve({ ...NOT_RUN, spawnError: true });
				return;
			}

			const chunks: Buffer[] = [];
			let bytes = 0;
			let settled = false;
			/** Why this module killed the child, if it did. */
			let killedFor: "timeout" | "abort" | "overflow" | undefined;
			let timer: NodeJS.Timeout | undefined;

			const finish = (result: Omit<RunResult, "ms">) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				running.delete(kill);
				resolve({ ...result, ms: now() - started });
			};
			// SIGKILL, not SIGTERM: Boost has nothing to flush that matters to a
			// result already being abandoned, and a child that ignored SIGTERM
			// would keep its slot in the semaphore.
			const kill = (reason: "timeout" | "abort" | "overflow" = "abort") => {
				killedFor ??= reason;
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				// Settle now rather than on `close`: a grandchild holding stdout
				// open would otherwise keep the caller waiting after the kill.
				finish({
					code: null,
					stdout: "",
					timedOut: killedFor === "timeout",
					aborted: killedFor === "abort",
					...(killedFor === "overflow" ? { overflow: true } : {}),
				});
			};
			function onAbort() {
				kill("abort");
			}

			running.add(kill);
			timer = setTimeout(() => kill("timeout"), options.timeoutMs);
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.stdout?.on("data", (chunk: Buffer) => {
				if (settled) return;
				bytes += chunk.length;
				if (bytes > options.maxStdout) return kill("overflow");
				chunks.push(chunk);
			});
			child.on("error", () => {
				finish({ code: null, stdout: "", timedOut: false, aborted: false, spawnError: true });
			});
			child.on("close", (code, signal) => {
				finish({
					code,
					// Decoded once at the end, so a multi-byte character split across
					// two chunks is not turned into replacement characters.
					stdout: Buffer.concat(chunks).toString("utf8"),
					timedOut: false,
					aborted: false,
					...(code === null && signal ? { killedBy: signal } : {}),
				});
			});

			// A missing executable or an early exit closes stdin before we finish
			// writing. Without this listener that EPIPE is an unhandled stream
			// error, which takes the whole pi process down.
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.input ?? "");
		});
	};

	/**
	 * `detached: true` on every platform. On POSIX it gives the child its own
	 * process group. On Windows it is what lets the child outlive pi at all:
	 * libuv puts every non-detached child in a job object that kills it when pi
	 * exits, which would cut off the shutdown `boost sync` (and, under `pi -p`,
	 * every sync). A detached Windows child is created with DETACHED_PROCESS, so
	 * it has no console, and `windowsHide` keeps any window hidden besides.
	 */
	const detached = (exe: string, args: readonly string[], options: DetachedOptions): void => {
		let exited = false;
		const exit = (code: number | null) => {
			if (exited) return;
			exited = true;
			try {
				options.onExit?.(code);
			} catch {
				/* a callback's problem is not the caller's */
			}
		};
		try {
			const launch = launcher(exe);
			const child = spawnFn(launch.file, [...launch.args, ...args], {
				...(options.cwd ? { cwd: options.cwd } : {}),
				env: options.env,
				stdio: [options.input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
				detached: true,
				windowsHide: true,
			});
			let watchdog: NodeJS.Timeout | undefined;
			if (options.watchdogMs !== undefined) {
				watchdog = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already gone */
					}
					exit(null);
				}, options.watchdogMs);
				// A stuck upload must never be the reason pi stays alive.
				watchdog.unref?.();
			}
			const done = (code: number | null) => {
				if (watchdog) clearTimeout(watchdog);
				exit(code);
			};
			child.on("error", () => done(null));
			child.on("exit", (code) => done(code));
			if (options.input !== undefined) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(options.input);
			}
			child.unref();
		} catch {
			exit(null);
		}
	};

	return {
		run,
		detached,
		active: () => running.size,
		killAll() {
			for (const kill of [...running]) kill();
		},
	};
}
