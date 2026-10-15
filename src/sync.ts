/**
 * Idle-time `boost sync` (spec §14).
 *
 * Boost measures locally — filter savings, conversions, MCP calls, opt-in
 * observe events — and `boost sync` uploads those measurements to JFrog,
 * then prunes the synced rows from the local DB (≥ 0.13.29). It is what makes
 * the JFrog dashboard and team reports show pi at all. Boost's own
 * integrations run it when the agent goes idle — the Claude Code `Stop` hook,
 * the OpenCode `session.idle` handler — and this does the same:
 *
 * - **When.** 8 s after `agent_settled` (the delay Boost's OpenCode plugin
 *   uses), not `agent_end`: `agent_end` fires once per agent loop, and a
 *   prompt with follow-ups or retries runs several, while `agent_settled`
 *   fires once when pi is done with the prompt. A new settle within the
 *   delay restarts it, so a burst of prompts is one upload.
 * - **Single-flight.** A sync can take a while (up to 20 batches, network
 *   permitting), and two at once would upload the same rows twice or race on
 *   the prune. A schedule that comes due while one is running only marks a
 *   re-run, which starts once, when the running child exits — however many
 *   schedules arrived meanwhile. The child's exit is the signal, through
 *   the client's `onExit` (exit, spawn failure, or the watchdog's kill).
 *   That is per process, not per scheduler: pi builds a fresh extension
 *   instance (and with it a fresh scheduler) for every `/new`, `/resume`,
 *   `/fork` and `/reload`, and evaluates this module afresh for the last, so
 *   the running child is tracked in a {@link SyncFlight} hung on
 *   `globalThis` under a registered symbol, as status.ts does for notices.
 *   A session-shutdown flush and the next session's first settle then share
 *   one flight instead of uploading side by side.
 * - **Bounded.** `boost sync --max-batches 20` (F3) caps one run's upload;
 *   anything left goes with the next. The client kills a sync still running
 *   after 120 s (an unref'd watchdog), and this scheduler stops waiting for
 *   an exit that never comes a little after that, so a lost callback cannot
 *   switch sync off for the rest of the process.
 * - **Off-path.** Detached and unref'd: pi never waits for it, and it never
 *   keeps pi alive. It runs with no flag overrides in its environment
 *   (boost-client.ts), so this is where Boost may refresh stale feature
 *   flags, which pi's hot-path calls never do (spec §8.3 amendment).
 * - **Opt-out.** It uploads to JFrog, so `sync: false` or `PI_BOOST_SYNC=0`
 *   turns it off, as does every off switch; `enabled` is read when the
 *   timer fires, not only when it was set.
 * - **Shutdown.** A pending upload is sent at once rather than lost with the
 *   process. One already running is left to finish; what it does not cover
 *   goes with the next session's sync. That includes the one gap in "flushed
 *   on shutdown" (§14): when pi shuts down while a sync runs *and* a later
 *   settle is still inside its delay, that last turn's rows are not uploaded
 *   now — the delay is cancelled and no re-run is queued. Deliberately: a
 *   second sync alongside the running one could upload the same rows twice
 *   or race its prune, and a queued re-run would have to fire from the
 *   running child's exit, which pi exiting means never comes. Boost keeps
 *   the rows in its local DB, so the next sync (any session, any agent)
 *   sends them; nothing is lost, only later.
 *
 * pi asks extensions not to start timers from the extension factory, so
 * nothing here runs until the first `schedule()` call.
 */
import type { BoostClient, HookMeta } from "./boost-client.ts";
import { DEFAULT_TIMEOUTS } from "./boost-client.ts";

/** Matches the delay Boost's OpenCode plugin uses. */
export const SYNC_DELAY_MS = 8_000;
/**
 * How long a running sync blocks the next one when its exit is never
 * reported: the client's watchdog plus a margin for the kill to land.
 */
export const SYNC_STUCK_MS = DEFAULT_TIMEOUTS.syncWatchdog + 10_000;

/**
 * The sync child running in this process, shared by every scheduler in it
 * (see "Single-flight" above). Each scheduler keeps only its own debounce
 * timer.
 */
export interface SyncFlight {
	/** The running child's generation, or undefined when none runs. */
	id: number | undefined;
	generation: number;
	stuckTimer: NodeJS.Timeout | undefined;
	/**
	 * A schedule came due while a sync ran: the re-run to start, once, when it
	 * exits, and the scheduler that queued it (whose dispose() drops it).
	 */
	rerun: { owner: object; run: () => void } | undefined;
}

export function createSyncFlight(): SyncFlight {
	return { id: undefined, generation: 0, stuckTimer: undefined, rerun: undefined };
}

/** The process-wide flight; survives `/reload` re-evaluating this module. */
export function processSyncFlight(): SyncFlight {
	const key = Symbol.for("pi-jfrog-boost.sync-flight");
	const store = globalThis as unknown as Record<symbol, SyncFlight | undefined>;
	store[key] ??= createSyncFlight();
	return store[key];
}

export interface SyncScheduler {
	/** Note that the agent settled; upload once it stays idle for the delay. */
	schedule(meta: HookMeta): void;
	/** Upload now if an upload is pending (session shutdown). */
	flush(meta: HookMeta): void;
	/**
	 * Drop this scheduler's pending timer and queued re-run without
	 * uploading. A running child is left to finish and stays in the
	 * process-wide flight, so the next session's scheduler waits for it.
	 */
	dispose(): void;
	/** Whether a sync child is running (tests, status). */
	running(): boolean;
}

export interface SyncSchedulerOptions {
	client: Pick<BoostClient, "sync">;
	/** The opt-out and every off switch, read live: `sync` on and Boost not off. */
	enabled: () => boolean;
	delayMs?: number;
	/** See {@link SYNC_STUCK_MS}; injected by tests. */
	stuckMs?: number;
	/** Defaults to the process-wide {@link processSyncFlight}; tests pass their own. */
	flight?: SyncFlight;
}

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
	const { client, enabled } = options;
	const delayMs = options.delayMs ?? SYNC_DELAY_MS;
	const stuckMs = options.stuckMs ?? SYNC_STUCK_MS;
	const flight = options.flight ?? processSyncFlight();
	/** Identifies this scheduler's queued re-run in the shared flight. */
	const self = {};
	let timer: NodeJS.Timeout | undefined;

	const isEnabled = () => {
		try {
			return enabled();
		} catch {
			return false;
		}
	};

	const landed = (id: number) => {
		// A late exit from a run already given up on must not end a newer one.
		if (flight.id !== id) return;
		flight.id = undefined;
		if (flight.stuckTimer) clearTimeout(flight.stuckTimer);
		flight.stuckTimer = undefined;
		const next = flight.rerun;
		flight.rerun = undefined;
		next?.run();
	};

	/**
	 * Fail open: a throw from a timer callback would be an uncaught exception
	 * that takes pi down with it, and one from flush() would surface as an
	 * error in pi's shutdown. An upload is never worth either.
	 */
	function start(meta: HookMeta): void {
		if (!isEnabled()) return;
		if (flight.id !== undefined) {
			flight.rerun = { owner: self, run: () => start(meta) };
			return;
		}
		const id = ++flight.generation;
		flight.id = id;
		flight.stuckTimer = setTimeout(() => landed(id), stuckMs);
		flight.stuckTimer.unref?.();
		try {
			client.sync(meta, () => landed(id));
		} catch {
			landed(id);
		}
	}

	const cancel = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	};

	return {
		schedule(meta) {
			if (!isEnabled()) return;
			cancel();
			timer = setTimeout(() => {
				timer = undefined;
				start(meta);
			}, delayMs);
			// A pending upload must never be the reason pi stays alive.
			timer.unref?.();
		},
		flush(meta) {
			const wasPending = timer !== undefined;
			// With a sync running, the pending one is dropped, not queued: see
			// "Shutdown" above.
			cancel();
			if (!wasPending || flight.id !== undefined) return;
			start(meta);
		},
		dispose() {
			if (flight.rerun?.owner === self) flight.rerun = undefined;
			// A running child is left to finish, and still tracked in the
			// process-wide flight (its unref'd stuck timer included), so the
			// next session's scheduler cannot start a second one alongside it.
			cancel();
		},
		running: () => flight.id !== undefined,
	};
}
