import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { HookMeta } from "../src/boost-client.ts";
import { createSyncScheduler, SYNC_DELAY_MS } from "../src/sync.ts";

const meta: HookMeta = { session_id: "s1", cwd: "/tmp" };

/**
 * A client whose `sync` behaves like the detached child: it is recorded, and
 * it "exits" only when the test says so, through the `onExit` it was given.
 */
function fakeSync(options: { exitAtOnce?: boolean } = {}) {
	const calls: HookMeta[] = [];
	const exits: ((code: number | null) => void)[] = [];
	let running = 0;
	let maxRunning = 0;
	const client = {
		sync(m: HookMeta, onExit?: (code: number | null) => void) {
			calls.push(m);
			running++;
			maxRunning = Math.max(maxRunning, running);
			const exit = (code: number | null) => {
				running--;
				onExit?.(code);
			};
			if (options.exitAtOnce) exit(0);
			else exits.push(exit);
		},
	};
	return {
		client,
		calls,
		/** Let the oldest running child exit. */
		exit(code: number | null = 0) {
			exits.shift()?.(code);
		},
		maxRunning: () => maxRunning,
	};
}

test("syncs 8 s after the agent settles by default", () => {
	assert.equal(SYNC_DELAY_MS, 8_000);
});

test("a burst of settles produces one upload, not one per settle", async () => {
	const fake = fakeSync({ exitAtOnce: true });
	const sync = createSyncScheduler({ client: fake.client, enabled: () => true, delayMs: 10 });
	sync.schedule(meta);
	sync.schedule(meta);
	sync.schedule(meta);
	assert.equal(fake.calls.length, 0, "nothing uploads while settles keep arriving");
	await delay(30);
	assert.deepEqual(fake.calls, [meta]);
});

test("never two at once: a schedule due while one runs re-runs once, after it exits", async () => {
	const fake = fakeSync();
	const sync = createSyncScheduler({ client: fake.client, enabled: () => true, delayMs: 5 });
	sync.schedule(meta);
	await delay(20);
	assert.equal(fake.calls.length, 1);
	assert.equal(sync.running(), true);

	const later = { ...meta, session_id: "s2" };
	for (let i = 0; i < 3; i++) {
		sync.schedule(later);
		await delay(20);
	}
	assert.equal(fake.calls.length, 1, "nothing else starts while the first runs");

	fake.exit();
	assert.equal(fake.calls.length, 2, "one re-run when it exits, however many schedules came due");
	assert.deepEqual(fake.calls[1], later, "with the latest metadata");
	fake.exit();
	await delay(20);
	assert.equal(fake.calls.length, 2, "and only one");
	assert.equal(fake.maxRunning(), 1);
	assert.equal(sync.running(), false);
});

test("an exit that never comes stops blocking after the stuck timeout", async () => {
	const fake = fakeSync();
	const sync = createSyncScheduler({ client: fake.client, enabled: () => true, delayMs: 1, stuckMs: 60 });
	sync.schedule(meta);
	await delay(10);
	sync.schedule(meta);
	await delay(10);
	assert.equal(fake.calls.length, 1);
	// The first is given up on at ~60 ms; the re-run's own wait ends at ~120 ms.
	await delay(70);
	assert.equal(fake.calls.length, 2, "the pending re-run started once the first was given up on");
	// The first child's late exit must not end the second's flight.
	fake.exit();
	assert.equal(sync.running(), true);
	sync.dispose();
});

test("shutdown uploads a pending sync at once instead of waiting out the debounce", () => {
	const fake = fakeSync({ exitAtOnce: true });
	const sync = createSyncScheduler({ client: fake.client, enabled: () => true, delayMs: 10_000 });
	sync.schedule(meta);
	sync.flush(meta);
	assert.deepEqual(fake.calls, [meta]);
});

test("shutdown with a sync already running starts no second one", async () => {
	const fake = fakeSync();
	const sync = createSyncScheduler({ client: fake.client, enabled: () => true, delayMs: 1 });
	sync.schedule(meta);
	await delay(10);
	sync.schedule(meta);
	sync.flush(meta);
	assert.equal(fake.calls.length, 1);
	sync.dispose();
	fake.exit();
	assert.equal(fake.calls.length, 1, "dispose dropped the pending re-run");
});

test("flushing with nothing pending does not upload", () => {
	const fake = fakeSync();
	createSyncScheduler({ client: fake.client, enabled: () => true, delayMs: 10 }).flush(meta);
	assert.equal(fake.calls.length, 0);
});

test("dispose cancels a pending upload, and a flush after it does not resurrect it", async () => {
	const fake = fakeSync();
	const sync = createSyncScheduler({ client: fake.client, enabled: () => true, delayMs: 10 });
	sync.schedule(meta);
	sync.dispose();
	sync.flush(meta);
	await delay(30);
	assert.equal(fake.calls.length, 0);
});

test("the opt-out is read when the timer fires, not only when it was set", async () => {
	let enabled = true;
	const fake = fakeSync();
	const sync = createSyncScheduler({ client: fake.client, enabled: () => enabled, delayMs: 10 });
	sync.schedule(meta);
	enabled = false;
	await delay(30);
	assert.equal(fake.calls.length, 0);
	sync.schedule(meta);
	await delay(30);
	assert.equal(fake.calls.length, 0, "nothing is scheduled while it is off");
});

test("a throwing client or opt-out fails open, from the timer and from flush", async () => {
	const uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => uncaught.push(error);
	process.on("uncaughtException", onUncaught);
	try {
		const client = {
			sync: () => {
				throw new Error("boost exploded");
			},
		};
		const sync = createSyncScheduler({ client, enabled: () => true, delayMs: 5 });
		sync.schedule(meta);
		await delay(20);
		assert.equal(sync.running(), false, "a spawn that threw is not left running");
		sync.schedule(meta);
		assert.doesNotThrow(() => sync.flush(meta));
		const broken = createSyncScheduler({
			client,
			enabled: () => {
				throw new Error("settings exploded");
			},
			delayMs: 5,
		});
		assert.doesNotThrow(() => broken.schedule(meta));
		assert.deepEqual(uncaught, []);
	} finally {
		process.off("uncaughtException", onUncaught);
	}
});
