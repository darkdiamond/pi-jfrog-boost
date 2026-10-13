/**
 * Is Boost usable right now, and has it been behaving? (spec §8.1, §8.2)
 *
 * Two pieces of state, both driven by an injected clock so their timing is
 * testable without waiting:
 *
 * **Readiness** answers "may a tool result be sent to Boost at all?". It is
 * established by `boost version` with flag fetching disabled (~140 ms, no
 * network), started at `session_start` and never awaited by a tool result: a
 * result that arrives while the probe is still running passes through
 * unchanged (invariant 2). 0.3.0 awaited the probe on the first tool call,
 * and a Boost stalled on a flag refresh made that call wait 5 s — and a
 * failed probe disabled Boost for the rest of the session.
 *
 * **The breaker** answers "has Boost been slow or failing lately?". Three bad
 * calls in a row pause every surface for 5 minutes, so a Boost that hangs on
 * every call costs three timeouts, not one per tool result.
 *
 * Plus per-session counters of why results were skipped and how calls
 * failed, which `/boost status` and `/boost stats` report.
 */
import {
	type BinaryStamp,
	type BoostVersion,
	isSupportedVersion,
	parseBoostVersion,
} from "./boost-binary.ts";
import type { RunResult } from "./boost-process.ts";

// ---------------------------------------------------------------------------
// Readiness

export type ReadinessState =
	| { kind: "disabled" }
	| { kind: "missing" }
	| { kind: "probing" }
	| { kind: "ready"; version: BoostVersion }
	| { kind: "too-old"; version: BoostVersion }
	| { kind: "unknown-version" }
	| { kind: "not-responding" };

/** How long after a failed probe the next one may run: 30 s, 2 min, then every 10 min. */
export const PROBE_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000];
/** A missing binary is looked for again at most this often between sessions. */
export const MISSING_RECHECK_MS = 60_000;

export interface ReadinessDeps {
	/** Live kill switches and settings: false means `disabled`, and nothing is probed. */
	enabled(): boolean;
	/** Find the binary (a filesystem search; cheap, but not free). */
	resolve(): string | undefined;
	/** The binary's identity, or undefined when the file is gone. */
	stamp(path: string): BinaryStamp | undefined;
	/** Run `boost version` with flag fetching disabled and an 8 s timeout. */
	probe(path: string): Promise<RunResult>;
	/** Milliseconds; injected so backoff is testable. Defaults to `Date.now`. */
	now?: () => number;
}

export interface Readiness {
	/** The state now. Pure: never starts a probe or touches the filesystem. */
	state(): ReadinessState;
	/**
	 * Session start: re-resolve a missing binary unconditionally, then start a
	 * probe if one is due. Never awaited by the caller.
	 */
	start(): void;
	/**
	 * On demand (a tool result): re-resolve a missing binary if 60 s have
	 * passed, notice a changed binary stamp, retry a failed probe once its
	 * backoff has elapsed. Returns the state now; a probe it starts is not
	 * waited for.
	 */
	check(): ReadinessState;
	/** Wait up to `ms` for a running probe to settle. Resolves at once when none is running. */
	wait(ms: number): Promise<ReadinessState>;
	/** `/boost status → retry`, or after an install: forget everything and re-resolve. */
	retry(): void;
	/** The resolved binary, if any. */
	binary(): string | undefined;
	/** The version the last successful probe reported. */
	version(): BoostVersion | undefined;
}

interface Memo {
	path: string;
	stamp: BinaryStamp;
	outcome: Exclude<ReadinessState, { kind: "disabled" } | { kind: "missing" }>;
	/** For `not-responding`: consecutive failures and when the next probe may run. */
	failures: number;
	retryAt: number;
}

const sameStamp = (a: BinaryStamp, b: BinaryStamp) => a.mtimeMs === b.mtimeMs && a.size === b.size;

/**
 * What a finished `boost version` run means. (Busy and aborted runs never get
 * here: they say nothing about Boost, and runProbe forgets them.)
 *
 * `unknown-version` is only for a Boost that exited 0 with a banner this
 * extension cannot parse: that is deterministic, so it is cached until the
 * binary changes. A run that exited non-zero without a banner is a failure,
 * not an answer — one transient exit 1 must not disable Boost for the whole
 * session — so it is `not-responding`, which backs off and retries.
 */
export function classifyProbe(result: RunResult): Memo["outcome"] {
	if (result.timedOut || result.spawnError || result.killedBy || result.busy || result.code === null) {
		return { kind: "not-responding" };
	}
	const version = parseBoostVersion(result.stdout);
	if (!version) return result.code === 0 ? { kind: "unknown-version" } : { kind: "not-responding" };
	return isSupportedVersion(version) ? { kind: "ready", version } : { kind: "too-old", version };
}

export function createReadiness(deps: ReadinessDeps): Readiness {
	const now = deps.now ?? Date.now;
	let path: string | undefined;
	/** When the binary was last looked for and not found. */
	let missingSince: number | undefined;
	let memo: Memo | undefined;
	let inflight: Promise<void> | undefined;
	/** Bumped by retry(), so a probe started before it cannot overwrite what came after. */
	let generation = 0;

	const resolveNow = () => {
		path = deps.resolve();
		missingSince = path ? undefined : now();
	};

	const runProbe = (target: string, stamp: BinaryStamp, failures: number) => {
		const gen = generation;
		memo = { path: target, stamp, outcome: { kind: "probing" }, failures, retryAt: 0 };
		// Wrapped so a probe that throws synchronously still lands in `.catch`.
		inflight = (async () => deps.probe(target))()
			.catch((): RunResult => ({ code: null, stdout: "", ms: 0, timedOut: false, aborted: false }))
			.then((result) => {
				if (gen !== generation) return;
				if (result.busy || result.aborted) {
					// Nothing ran (the process slots were full), or the probe was killed
					// on purpose (killAll() at session shutdown). Neither says anything
					// about Boost (§8.2: abort is neutral), so forget the attempt rather
					// than record a failure and its 30 s backoff, and let the next
					// check probe again.
					memo = undefined;
					return;
				}
				const outcome = classifyProbe(result);
				const failed = outcome.kind === "not-responding";
				const count = failed ? failures + 1 : 0;
				const backoff = PROBE_BACKOFF_MS[Math.min(count, PROBE_BACKOFF_MS.length) - 1] ?? 0;
				memo = { path: target, stamp, outcome, failures: count, retryAt: failed ? now() + backoff : 0 };
			})
			.finally(() => {
				if (gen === generation) inflight = undefined;
			});
	};

	/** The shared body of start() and check(). */
	const advance = (forceResolve: boolean) => {
		if (!deps.enabled()) return;
		if (!path) {
			const due = missingSince === undefined || now() - missingSince >= MISSING_RECHECK_MS;
			if (forceResolve || due) resolveNow();
			if (!path) return;
		}
		const stamp = deps.stamp(path);
		if (!stamp) {
			// Deleted (or replaced by something that is not a file) since it was
			// resolved: look again, it may have moved.
			resolveNow();
			memo = undefined;
			if (!path) return;
			return advance(false);
		}
		if (inflight) return;
		if (!memo || memo.path !== path || !sameStamp(memo.stamp, stamp)) {
			// First probe, or Boost updated itself: whatever was known is stale.
			runProbe(path, stamp, 0);
			return;
		}
		if (memo.outcome.kind === "not-responding" && now() >= memo.retryAt) {
			runProbe(path, stamp, memo.failures);
		}
		// too-old and unknown-version stay cached until the stamp changes or retry().
	};

	const state = (): ReadinessState => {
		if (!deps.enabled()) return { kind: "disabled" };
		if (!path) return memo || missingSince !== undefined ? { kind: "missing" } : { kind: "probing" };
		return memo?.outcome ?? { kind: "probing" };
	};

	return {
		state,
		start() {
			advance(true);
		},
		check() {
			advance(false);
			return state();
		},
		async wait(ms) {
			const pending = inflight;
			if (!pending) return state();
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				pending,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, ms);
					timer.unref?.();
				}),
			]);
			if (timer) clearTimeout(timer);
			return state();
		},
		retry() {
			generation++;
			inflight = undefined;
			memo = undefined;
			path = undefined;
			missingSince = undefined;
			advance(true);
		},
		binary: () => path,
		version() {
			const outcome = memo?.outcome;
			return outcome && "version" in outcome ? outcome.version : undefined;
		},
	};
}

// ---------------------------------------------------------------------------
// Breaker

/** Consecutive bad calls that open the breaker. */
export const BREAKER_THRESHOLD = 3;
/** First open period; doubled by each failed trial, up to {@link BREAKER_MAX_MS}. */
export const BREAKER_OPEN_MS = 5 * 60_000;
export const BREAKER_MAX_MS = 30 * 60_000;
/** Floor for "this call was too slow", whatever its input size. */
export const SLOW_FLOOR_MS = 2_500;

export type CallOutcome = "good" | "bad" | "neutral";
export type BadReason = "timeout" | "error" | "killed" | "slow";

/**
 * How long a call to Boost should take for `bytes` of input: ~300 ms of
 * start-up plus ~4 ms per KiB, as measured on v0.15.4.
 */
export function expectedMs(bytes: number): number {
	return 300 + 4 * (bytes / 1024);
}

/**
 * Whether a finished call counts against Boost.
 *
 * - Bad: a timeout, a spawn failure, a kill by a signal this extension did
 *   not send, or a duration over `max(2.5 s, 3 × expected)`.
 * - Not bad: a non-zero exit. That is a deterministic answer — `boost read`
 *   exits 1 without accepted terms and for legacy Office files — not
 *   slowness, and pausing on it would switch off working surfaces.
 * - Neutral: an abort (the user pressed Escape; it says nothing about Boost),
 *   a busy skip (nothing ran), and a stdout overflow (one malformed reply).
 */
export function classifyCall(
	result: RunResult,
	inputBytes: number,
): { outcome: CallOutcome; reason?: BadReason } {
	if (result.aborted || result.busy || result.overflow) return { outcome: "neutral" };
	if (result.timedOut) return { outcome: "bad", reason: "timeout" };
	if (result.spawnError) return { outcome: "bad", reason: "error" };
	if (result.killedBy) return { outcome: "bad", reason: "killed" };
	if (result.ms > Math.max(SLOW_FLOOR_MS, 3 * expectedMs(inputBytes)))
		return { outcome: "bad", reason: "slow" };
	return { outcome: "good" };
}

export type BreakerState =
	| { kind: "closed" }
	| { kind: "open"; until: number; reason: BadReason }
	| { kind: "half-open" };

export interface Breaker {
	/**
	 * Whether a call may go to Boost now. Closed: yes. Open: no, until the
	 * open period ends; then half-open, where exactly one trial call is let
	 * through and every other call is refused until it reports.
	 */
	allow(): boolean;
	/** Report a finished call that `allow()` admitted. */
	record(result: RunResult, inputBytes: number): void;
	state(): BreakerState;
	/** `/boost on` and `/boost status → retry`: close and forget the history. */
	reset(): void;
}

export interface BreakerDeps {
	now?: () => number;
	/** Called each time the breaker opens (the paused notice and footer). */
	onOpen?: (reason: BadReason, durationMs: number) => void;
}

export function createBreaker(deps: BreakerDeps = {}): Breaker {
	const now = deps.now ?? Date.now;
	let consecutiveBad = 0;
	let openMs = BREAKER_OPEN_MS;
	let openUntil: number | undefined;
	let reason: BadReason = "timeout";
	let trialInFlight = false;

	const open = (why: BadReason) => {
		reason = why;
		openUntil = now() + openMs;
		trialInFlight = false;
		try {
			deps.onOpen?.(why, openMs);
		} catch {
			/* a notice failing must not leave the breaker half-updated */
		}
	};

	const state = (): BreakerState => {
		if (openUntil === undefined) return { kind: "closed" };
		if (now() < openUntil) return { kind: "open", until: openUntil, reason };
		return { kind: "half-open" };
	};

	return {
		state,
		allow() {
			const current = state();
			if (current.kind === "closed") return true;
			if (current.kind === "open") return false;
			if (trialInFlight) return false;
			trialInFlight = true;
			return true;
		},
		record(result, inputBytes) {
			const { outcome, reason: why } = classifyCall(result, inputBytes);
			const halfOpen = state().kind === "half-open";
			if (outcome === "neutral") {
				// The trial proved nothing; let the next call try instead.
				if (halfOpen) trialInFlight = false;
				return;
			}
			if (outcome === "good") {
				consecutiveBad = 0;
				if (openUntil !== undefined && halfOpen) {
					openUntil = undefined;
					openMs = BREAKER_OPEN_MS;
					trialInFlight = false;
				}
				return;
			}
			if (halfOpen) {
				openMs = Math.min(openMs * 2, BREAKER_MAX_MS);
				open(why ?? "timeout");
				return;
			}
			// A call admitted before the breaker opened that finishes after:
			// it is already open, so do not extend it.
			if (openUntil !== undefined) return;
			consecutiveBad++;
			if (consecutiveBad >= BREAKER_THRESHOLD) {
				consecutiveBad = 0;
				open(why ?? "timeout");
			}
		},
		reset() {
			consecutiveBad = 0;
			openMs = BREAKER_OPEN_MS;
			openUntil = undefined;
			trialInFlight = false;
		},
	};
}

// ---------------------------------------------------------------------------
// Counters

/**
 * Per-session counts of why results were not sent to Boost and how calls to
 * it failed. Plain numbers, keyed by reason code (the router's skip reasons,
 * the breaker's bad reasons), so they can be persisted and reported as-is.
 */
export interface Counters {
	skip(reason: string): void;
	error(kind: string, detail?: string): void;
	skips(): Readonly<Record<string, number>>;
	errors(): Readonly<Record<string, number>>;
	/** The most recent error, for `/boost status`. */
	lastError(): string | undefined;
	reset(): void;
}

export function createCounters(): Counters {
	let skips: Record<string, number> = {};
	let errors: Record<string, number> = {};
	let last: string | undefined;
	return {
		skip(reason) {
			skips[reason] = (skips[reason] ?? 0) + 1;
		},
		error(kind, detail) {
			errors[kind] = (errors[kind] ?? 0) + 1;
			last = detail ? `${kind}: ${detail}` : kind;
		},
		skips: () => ({ ...skips }),
		errors: () => ({ ...errors }),
		lastError: () => last,
		reset() {
			skips = {};
			errors = {};
			last = undefined;
		},
	};
}
