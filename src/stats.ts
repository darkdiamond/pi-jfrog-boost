/**
 * Per-session savings by surface (spec §10.2 `/boost stats`, §10.5).
 *
 * Six buckets — bash, powershell, extra (`extraTools`), logs (`*.log` /
 * `*.out` reads), documents (PDF/Office/notebook reads) and mcp — each
 * counting results seen, compacted, converted, skipped by reason and failed,
 * plus the size of what reached Boost and of what the model got back.
 *
 * The snapshot is persisted in the session with
 * `pi.appendEntry("jfrog-boost-stats", {v: 1, buckets})` so `/resume` and a
 * fork keep their numbers. It holds **numbers only**: reason codes as keys
 * and counts as values, never a command, a path or any output. Session
 * files are shared and uploaded with bug reports; nothing the tools printed
 * may end up in one through this extension. Restoring validates every value
 * for the same reason — an entry is data from disk, not trusted state.
 *
 * Sizes are counted in characters (UTF-16 code units), the unit of
 * `details.jfrogBoost.before/after` and of the footer's "chars ÷ 4" token
 * estimate (§10.1). The fields keep the spec's `bytesIn`/`bytesOut` names;
 * for the ASCII that dominates tool output the two units agree.
 */
import { documentMode } from "./documents.ts";
import { isMcpTool } from "./mcp.ts";
import { isShellLike } from "./router.ts";
import { extensionOf, LOG_EXTENSIONS } from "./tools.ts";

export const STATS_ENTRY = "jfrog-boost-stats";
export const STATS_VERSION = 1;

export const BUCKETS = ["bash", "powershell", "extra", "logs", "documents", "mcp"] as const;
export type BucketName = (typeof BUCKETS)[number];

export interface Bucket {
	/**
	 * Results of this kind that reached the extension while it was working:
	 * not nested, not switched off, Boost ready. An idle extension (off, or
	 * Boost missing) counts nothing here, so it never writes a stats entry
	 * into a session it had no part in (§10.5).
	 */
	seen: number;
	/** Replaced by Boost's shorter text (shell, logs, MCP). */
	compacted: number;
	/** Replaced by converted text (documents). */
	converted: number;
	/** Kept as they were, by reason code (`small`, `shell-off`, `unchanged`, …). */
	skipped: Record<string, number>;
	/** Boost timed out, failed to start or was killed. */
	failed: number;
	/** Characters of the results Boost processed, before. */
	bytesIn: number;
	/** Characters of what the model got for them, after. */
	bytesOut: number;
	/**
	 * Characters removed, summed per result and never negative per result.
	 * Not `bytesIn - bytesOut`: a converted document is routinely longer
	 * than pi's raw read of it (a stored .docx reads as pi's one-line "line
	 * exceeds 50KB" notice), and that growth must not cancel what shell and
	 * MCP compaction removed elsewhere — the footer would drop its savings or
	 * `/boost status` read "nothing saved yet" next to a bucket that saved
	 * (invariant 6).
	 */
	saved: number;
}

export interface StatsSnapshot {
	v: typeof STATS_VERSION;
	buckets: Record<BucketName, Bucket>;
}

const emptyBucket = (): Bucket => ({
	seen: 0,
	compacted: 0,
	converted: 0,
	skipped: {},
	failed: 0,
	bytesIn: 0,
	bytesOut: 0,
	saved: 0,
});

export function emptySnapshot(): StatsSnapshot {
	const buckets = {} as Record<BucketName, Bucket>;
	for (const name of BUCKETS) buckets[name] = emptyBucket();
	return { v: STATS_VERSION, buckets };
}

/** `41` for 41 %, rounded; 0 when nothing was measured. */
export function percent(removed: number, original: number): number {
	return original > 0 ? Math.round((removed / original) * 100) : 0;
}

/** All buckets added together. */
export function totals(snapshot: StatsSnapshot): Bucket {
	const sum = emptyBucket();
	for (const name of BUCKETS) {
		const b = snapshot.buckets[name];
		sum.seen += b.seen;
		sum.compacted += b.compacted;
		sum.converted += b.converted;
		sum.failed += b.failed;
		sum.bytesIn += b.bytesIn;
		sum.bytesOut += b.bytesOut;
		sum.saved += b.saved;
		for (const [reason, n] of Object.entries(b.skipped)) sum.skipped[reason] = (sum.skipped[reason] ?? 0) + n;
	}
	return sum;
}

/**
 * Which bucket a tool result belongs to, from the tool and its input alone,
 * or undefined for results no route could ever change (`edit`, a `read` of
 * source, `grep`): those are counted in `/boost status`'s skip line only, so
 * the buckets stay about the surfaces Boost works on.
 */
export function bucketFor(
	toolName: string,
	input: Readonly<Record<string, unknown>>,
	extraTools: readonly string[],
): BucketName | undefined {
	if (toolName === "bash") return "bash";
	if (toolName === "powershell") return "powershell";
	if (isMcpTool(toolName)) return "mcp";
	if (toolName === "read") {
		if (LOG_EXTENSIONS.has(extensionOf(input.path))) return "logs";
		return documentMode(input.path) ? "documents" : undefined;
	}
	// The same rule the router applies, so a result is counted where it is routed.
	if (isShellLike(toolName, extraTools)) return "extra";
	return undefined;
}

/** A reason code fit to be a persisted key: short, lower-case, no text from a tool. */
const REASON = /^[a-z][a-z0-9-]{0,39}$/;
const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * A snapshot from a session entry's data, or undefined when it is not one
 * this version wrote. Unknown buckets and fields are dropped, and a bucket
 * with any invalid number is dropped whole rather than half-trusted.
 */
export function parseSnapshot(data: unknown): StatsSnapshot | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (record.v !== STATS_VERSION) return undefined;
	const raw = record.buckets;
	if (typeof raw !== "object" || raw === null) return undefined;
	const snapshot = emptySnapshot();
	for (const name of BUCKETS) {
		const b = (raw as Record<string, unknown>)[name];
		if (typeof b !== "object" || b === null) continue;
		const fields = b as Record<string, unknown>;
		const parsed = emptyBucket();
		let valid = true;
		for (const key of ["seen", "compacted", "converted", "failed", "bytesIn", "bytesOut", "saved"] as const) {
			const n = count(fields[key]);
			if (n === undefined) valid = false;
			else parsed[key] = n;
		}
		// Never more than went in: a larger number is not a real saving.
		if (parsed.saved > parsed.bytesIn) valid = false;
		const skipped = fields.skipped;
		if (typeof skipped === "object" && skipped !== null && !Array.isArray(skipped)) {
			for (const [reason, value] of Object.entries(skipped)) {
				const n = count(value);
				if (!REASON.test(reason) || n === undefined) valid = false;
				else parsed.skipped[reason] = n;
			}
		} else {
			valid = false;
		}
		if (valid) snapshot.buckets[name] = parsed;
	}
	return snapshot;
}

/** The parts of pi's session manager this reads; both exist from 0.86.1 on. */
export interface SessionEntries {
	getBranch?: () => unknown;
	getEntries?: () => unknown;
}

function lastStatsEntry(entries: unknown): StatsSnapshot | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (entry && entry.type === "custom" && entry.customType === STATS_ENTRY) {
			const parsed = parseSnapshot(entry.data);
			if (parsed) return parsed;
		}
	}
	return undefined;
}

/**
 * The last persisted snapshot on the current branch (§10.5). The branch, not
 * every entry: after `/tree` or a fork the numbers are the branch's own, not
 * those of a sibling that never happened here. `getEntries()` is only the
 * fallback for a session manager whose branch cannot be read at all.
 */
export function restoreSnapshot(sessionManager: SessionEntries | undefined): StatsSnapshot | undefined {
	if (!sessionManager) return undefined;
	let branch: unknown;
	try {
		if (typeof sessionManager.getBranch === "function") branch = sessionManager.getBranch();
	} catch {
		branch = undefined;
	}
	if (Array.isArray(branch)) return lastStatsEntry(branch);
	try {
		if (typeof sessionManager.getEntries === "function") return lastStatsEntry(sessionManager.getEntries());
	} catch {
		/* no entries to restore from */
	}
	return undefined;
}

export interface Stats {
	/** A result of this kind reached the extension while it was working (see {@link Bucket.seen}). */
	seen(bucket: BucketName): void;
	skip(bucket: BucketName, reason: string): void;
	failed(bucket: BucketName): void;
	/**
	 * Boost processed a result. `after` is what the model got: Boost's text
	 * when it was used (`applied`), the original otherwise, so the footer's
	 * percentage is over everything that reached Boost (§10.1).
	 */
	processed(bucket: BucketName, before: number, after: number, applied?: "compacted" | "converted"): void;
	snapshot(): StatsSnapshot;
	/** Whether anything changed since the last {@link Stats.saved} or {@link Stats.restore}. */
	changed(): boolean;
	/** The snapshot was persisted. */
	saved(): void;
	/** Start from `snapshot` (a restored session), or from zero. */
	restore(snapshot?: StatsSnapshot): void;
}

export function createStats(): Stats {
	let state = emptySnapshot();
	let dirty = false;
	return {
		seen(bucket) {
			state.buckets[bucket].seen++;
			dirty = true;
		},
		skip(bucket, reason) {
			// A reason that is not a plain code is never persisted as a key.
			const key = REASON.test(reason) ? reason : "other";
			const skipped = state.buckets[bucket].skipped;
			skipped[key] = (skipped[key] ?? 0) + 1;
			dirty = true;
		},
		failed(bucket) {
			state.buckets[bucket].failed++;
			dirty = true;
		},
		processed(bucket, before, after, applied) {
			const b = state.buckets[bucket];
			const inChars = Math.max(0, Math.round(before));
			const outChars = Math.max(0, Math.round(after));
			b.bytesIn += inChars;
			b.bytesOut += outChars;
			b.saved += Math.max(0, inChars - outChars);
			if (applied) b[applied]++;
			dirty = true;
		},
		snapshot: () => structuredClone(state),
		changed: () => dirty,
		saved() {
			dirty = false;
		},
		restore(snapshot) {
			state = snapshot ? structuredClone(snapshot) : emptySnapshot();
			dirty = false;
		},
	};
}

/**
 * `/boost stats` (§10.2): one line per bucket that saw anything, then the
 * totals. Sizes as characters before → after with the share removed.
 */
export function formatStats(snapshot: StatsSnapshot, tokens: (chars: number) => string): string {
	const describe = (name: string, b: Bucket) => {
		const skipped = Object.entries(b.skipped)
			.filter(([, n]) => n > 0)
			.sort(([a], [c]) => a.localeCompare(c))
			.map(([reason, n]) => `${reason} ${n}`)
			.join(", ");
		return [
			`${name.padEnd(11)}seen ${b.seen}`,
			`compacted ${b.compacted}`,
			`converted ${b.converted}`,
			`skipped ${skipped || "none"}`,
			`failed ${b.failed}`,
			`${b.bytesIn} → ${b.bytesOut} chars (${percent(b.saved, b.bytesIn)}% saved, ~${tokens(b.saved)} tokens)`,
		].join(" · ");
	};
	const rows = BUCKETS.filter((name) => snapshot.buckets[name].seen > 0).map((name) =>
		describe(name, snapshot.buckets[name]),
	);
	return [
		"JFrog Boost — savings this session",
		...(rows.length ? rows : ["nothing seen yet"]),
		describe("total", totals(snapshot)),
	].join("\n");
}
