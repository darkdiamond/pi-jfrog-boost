import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BoostClient, HookMeta } from "../src/boost-client.ts";
import { createSyncScheduler } from "../src/sync.ts";

const meta: HookMeta = { session_id: "s1", cwd: "/tmp" };

function stubClient(enabled = true) {
	const calls: HookMeta[] = [];
	const client = {
		enabled: () => enabled,
		sync: (m: HookMeta) => calls.push(m),
	} as unknown as BoostClient;
	return { client, calls };
}

test("a burst of idle turns produces one upload, not one per turn", async () => {
	const { client, calls } = stubClient();
	const sync = createSyncScheduler(client, 10);
	sync.schedule(meta);
	sync.schedule(meta);
	sync.schedule(meta);
	assert.equal(calls.length, 0, "nothing uploads while turns keep arriving");
	await delay(30);
	assert.deepEqual(calls, [meta]);
});

test("shutdown uploads immediately instead of waiting out the debounce", () => {
	const { client, calls } = stubClient();
	const sync = createSyncScheduler(client, 10_000);
	sync.schedule(meta);
	sync.flush(meta);
	assert.deepEqual(calls, [meta]);
});

test("flushing with nothing pending does not upload", () => {
	const { client, calls } = stubClient();
	createSyncScheduler(client, 10).flush(meta);
	assert.equal(calls.length, 0);
});

test("dispose cancels a pending upload", async () => {
	const { client, calls } = stubClient();
	const sync = createSyncScheduler(client, 10);
	sync.schedule(meta);
	sync.dispose();
	await delay(30);
	assert.equal(calls.length, 0);
});

test("a flush after dispose does not resurrect the upload", async () => {
	const { client, calls } = stubClient();
	const sync = createSyncScheduler(client, 10);
	sync.schedule(meta);
	sync.dispose();
	sync.flush(meta);
	await delay(30);
	assert.equal(calls.length, 0);
});

test("nothing is scheduled when Boost is disabled", async () => {
	const { client, calls } = stubClient(false);
	const sync = createSyncScheduler(client, 10);
	sync.schedule(meta);
	await delay(30);
	assert.equal(calls.length, 0);
});
