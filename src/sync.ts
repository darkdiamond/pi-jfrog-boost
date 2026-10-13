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
 *   goes with the next session's sync.
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

export interface SyncScheduler {
	/** Note that the agent settled; upload once it stays idle for the delay. */
	schedule(meta: HookMeta): void;
	/** Upload now if an upload is pending (session shutdown). */
	flush(meta: HookMeta): void;
	/**
	 * Drop any pending timer or re-run without uploading. The scheduler stays
	 * usable: pi may start another session on the same instance.
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
}

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
	const { client, enabled } = options;
	const delayMs = options.delayMs ?? SYNC_DELAY_MS;
	const stuckMs = options.stuckMs ?? SYNC_STUCK_MS;
	let timer: NodeJS.Timeout | undefined;
	/** The running child's generation, or undefined when none runs. */
	let flight: number | undefined;
	let generation = 0;
	let stuckTimer: NodeJS.Timeout | undefined;
	/** A schedule came due while a sync ran: the meta to re-run with, once. */
	let pending: HookMeta | undefined;

	const isEnabled = () => {
		try {
			return enabled();
		} catch {
			return false;
		}
	};

	const landed = (id: number) => {
		// A late exit from a run already given up on must not end a newer one.
		if (flight !== id) return;
		flight = undefined;
		if (stuckTimer) clearTimeout(stuckTimer);
		stuckTimer = undefined;
		const next = pending;
		pending = undefined;
		if (next) start(next);
	};

	/**
	 * Fail open: a throw from a timer callback would be an uncaught exception
	 * that takes pi down with it, and one from flush() would surface as an
	 * error in pi's shutdown. An upload is never worth either.
	 */
	function start(meta: HookMeta): void {
		if (!isEnabled()) return;
		if (flight !== undefined) {
			pending = meta;
			return;
		}
		const id = ++generation;
		flight = id;
		stuckTimer = setTimeout(() => landed(id), stuckMs);
		stuckTimer.unref?.();
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
			cancel();
			if (!wasPending || flight !== undefined) return;
			start(meta);
		},
		dispose() {
			pending = undefined;
			// A running child is left to finish, and still tracked (its unref'd
			// stuck timer included), so a later session on this instance cannot
			// start a second one alongside it.
			cancel();
		},
		running: () => flight !== undefined,
	};
}
