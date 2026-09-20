/**
 * Debounced `boost sync`.
 *
 * `boost hook observe` records spans locally; `boost sync` drains them to the
 * dashboard, which is what makes `boost report` show anything at all. Boost's
 * own integrations run it when the agent goes idle — the Claude Code `Stop`
 * hook, the OpenCode `session.idle` handler — so this does the same, coalescing
 * a burst of turns into one upload and flushing immediately on shutdown.
 *
 * pi asks extensions not to start timers from the extension factory, so nothing
 * here runs until the first `schedule()` call.
 */
import type { BoostClient, HookMeta } from "./boost-client.ts";

/** Matches the delay Boost's OpenCode plugin uses. */
export const SYNC_DELAY_MS = 8_000;

export interface SyncScheduler {
	/** Note that the agent went idle; upload once it stays idle. */
	schedule(meta: HookMeta): void;
	/** Upload now, cancelling any pending timer. */
	flush(meta: HookMeta): void;
	/** Drop any pending timer without uploading. */
	dispose(): void;
}

export function createSyncScheduler(client: BoostClient, delayMs = SYNC_DELAY_MS): SyncScheduler {
	let timer: NodeJS.Timeout | undefined;

	const cancel = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	};

	return {
		schedule(meta) {
			if (!client.enabled()) return;
			cancel();
			timer = setTimeout(() => {
				timer = undefined;
				client.sync(meta);
			}, delayMs);
			// A pending upload must never be the reason pi stays alive.
			timer.unref?.();
		},
		flush(meta) {
			const wasPending = timer !== undefined;
			cancel();
			if (wasPending) client.sync(meta);
		},
		dispose: cancel,
	};
}
