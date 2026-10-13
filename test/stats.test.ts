/**
 * Per-bucket savings and their persistence (spec §10.2 `/boost stats`,
 * §10.5): bucket mapping, counting, numbers-only snapshots, and restoring
 * from the branch with the entries as the fallback.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BUCKETS,
	bucketFor,
	createStats,
	emptySnapshot,
	formatStats,
	parseSnapshot,
	restoreSnapshot,
	STATS_ENTRY,
	totals,
} from "../src/stats.ts";

test("results map to the six buckets, and everything else to none", () => {
	assert.equal(bucketFor("bash", {}, []), "bash");
	assert.equal(bucketFor("powershell", {}, []), "powershell");
	assert.equal(bucketFor("fetch", {}, ["fetch"]), "extra");
	assert.equal(bucketFor("fetch", {}, []), undefined);
	assert.equal(bucketFor("read", { path: "logs/app.LOG" }, []), "logs");
	assert.equal(bucketFor("read", { path: "run.out" }, []), "logs");
	for (const path of ["q3.pdf", "a.docx", "b.xlsx", "c.pptx", "d.odt", "old.doc", "nb.ipynb"]) {
		assert.equal(bucketFor("read", { path }, []), "documents", path);
	}
	assert.equal(bucketFor("mcp__slack__slack_get_users", {}, []), "mcp");
	for (const [tool, input] of [
		["read", { path: "src/index.ts" }],
		["read", { path: "data.csv" }],
		["edit", {}],
		["write", {}],
		["grep", {}],
	] as const) {
		assert.equal(bucketFor(tool, input, ["edit", "read"]), undefined, tool);
	}
});

test("counting: seen, compacted, converted, skipped by reason, failed, sizes", () => {
	const stats = createStats();
	assert.equal(stats.changed(), false);
	stats.seen("bash");
	stats.seen("bash");
	stats.seen("bash");
	stats.skip("bash", "small");
	stats.processed("bash", 10_000, 1_000, "compacted");
	stats.processed("bash", 3_000, 3_000);
	stats.skip("bash", "unchanged");
	stats.seen("documents");
	stats.processed("documents", 40_000, 6_000, "converted");
	stats.seen("mcp");
	stats.failed("mcp");
	assert.equal(stats.changed(), true);
	const snap = stats.snapshot();
	assert.deepEqual(snap.buckets.bash, {
		seen: 3,
		compacted: 1,
		converted: 0,
		skipped: { small: 1, unchanged: 1 },
		failed: 0,
		bytesIn: 13_000,
		bytesOut: 4_000,
	});
	assert.equal(snap.buckets.documents.converted, 1);
	assert.equal(snap.buckets.mcp.failed, 1);
	const sum = totals(snap);
	assert.equal(sum.bytesIn - sum.bytesOut, 9_000 + 34_000);
	assert.equal(sum.seen, 5);
});

test("a reason that is not a plain code is never kept as a key", () => {
	const stats = createStats();
	stats.skip("bash", "full-unfit");
	stats.skip("bash", "rm -rf / && cat ~/.ssh/id_rsa");
	assert.deepEqual(stats.snapshot().buckets.bash.skipped, { "full-unfit": 1, other: 1 });
});

test("the snapshot is a copy, and saved()/restore() reset the changed flag", () => {
	const stats = createStats();
	stats.seen("bash");
	const snap = stats.snapshot();
	snap.buckets.bash.seen = 99;
	assert.equal(stats.snapshot().buckets.bash.seen, 1);
	stats.saved();
	assert.equal(stats.changed(), false);
	stats.seen("bash");
	stats.restore(snap);
	assert.equal(stats.changed(), false);
	assert.equal(stats.snapshot().buckets.bash.seen, 99);
	stats.restore();
	assert.deepEqual(stats.snapshot(), emptySnapshot());
});

/** Every leaf of a value: a snapshot must hold nothing but numbers under its keys. */
function leaves(value: unknown, out: unknown[] = []): unknown[] {
	if (typeof value === "object" && value !== null) for (const v of Object.values(value)) leaves(v, out);
	else out.push(value);
	return out;
}

test("a snapshot holds numbers only", () => {
	const stats = createStats();
	for (const name of BUCKETS) {
		stats.seen(name);
		stats.skip(name, "small");
		stats.processed(name, 5_000, 100, "compacted");
	}
	assert.ok(leaves(stats.snapshot()).every((leaf) => typeof leaf === "number"));
	assert.deepEqual(Object.keys(stats.snapshot()), ["v", "buckets"]);
});

const entry = (data: unknown, customType = STATS_ENTRY) => ({ type: "custom", id: "e", customType, data });

test("parsing drops anything that is not a valid v1 snapshot, bucket by bucket", () => {
	assert.equal(parseSnapshot(undefined), undefined);
	assert.equal(parseSnapshot({ v: 2, buckets: {} }), undefined);
	const good = createStats();
	good.seen("bash");
	good.processed("bash", 10, 5, "compacted");
	const data = JSON.parse(JSON.stringify(good.snapshot()));
	data.buckets.mcp = { ...data.buckets.mcp, seen: "lots" };
	data.buckets.logs = { ...data.buckets.logs, skipped: { "<script>": 1 } };
	data.buckets.extra = { ...data.buckets.extra, bytesIn: -1 };
	data.buckets.unknown = { seen: 1 };
	const parsed = parseSnapshot(data);
	assert.equal(parsed?.buckets.bash.seen, 1);
	assert.deepEqual(parsed?.buckets.mcp, emptySnapshot().buckets.mcp, "an invalid bucket is dropped whole");
	assert.deepEqual(parsed?.buckets.logs, emptySnapshot().buckets.logs);
	assert.deepEqual(parsed?.buckets.extra, emptySnapshot().buckets.extra);
	assert.equal("unknown" in (parsed?.buckets ?? {}), false);
});

test("restore takes the last stats entry on the branch", () => {
	const a = createStats();
	a.seen("bash");
	const b = createStats();
	b.seen("bash");
	b.seen("bash");
	const branch = [
		{ type: "message", id: "m1" },
		entry(a.snapshot()),
		entry({ ignored: true }, "other-extension"),
		entry(b.snapshot()),
		{ type: "message", id: "m2" },
	];
	assert.equal(restoreSnapshot({ getBranch: () => branch, getEntries: () => [] })?.buckets.bash.seen, 2);
	assert.equal(
		restoreSnapshot({ getBranch: () => [], getEntries: () => branch }),
		undefined,
		"the branch wins",
	);
});

test("restore falls back to getEntries when the branch cannot be read", () => {
	const s = createStats();
	s.seen("mcp");
	const entries = [entry(s.snapshot())];
	assert.equal(restoreSnapshot({ getEntries: () => entries })?.buckets.mcp.seen, 1);
	assert.equal(
		restoreSnapshot({
			getBranch: () => {
				throw new Error("stale");
			},
			getEntries: () => entries,
		})?.buckets.mcp.seen,
		1,
	);
	assert.equal(restoreSnapshot(undefined), undefined);
	assert.equal(restoreSnapshot({}), undefined);
});

test("/boost stats lists each bucket that saw anything, then the totals", () => {
	const stats = createStats();
	stats.seen("bash");
	stats.processed("bash", 8_000, 2_000, "compacted");
	stats.seen("bash");
	stats.skip("bash", "small");
	const text = formatStats(stats.snapshot(), (chars) => `${chars / 4}`);
	assert.equal(
		text,
		[
			"JFrog Boost — savings this session",
			"bash       seen 2 · compacted 1 · converted 0 · skipped small 1 · failed 0 · 8000 → 2000 chars (75% saved, ~1500 tokens)",
			"total      seen 2 · compacted 1 · converted 0 · skipped small 1 · failed 0 · 8000 → 2000 chars (75% saved, ~1500 tokens)",
		].join("\n"),
	);
	assert.match(formatStats(emptySnapshot(), String), /\nnothing seen yet\n/);
});
