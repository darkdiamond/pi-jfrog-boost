/**
 * Reading Boost's own configuration, `~/.boost/config.toml` — and never
 * writing it (invariant 4).
 *
 * Boost keeps everything this extension needs to decide *without spawning*
 * in that one file (the path is always `$HOME/.boost/config.toml`, NP8):
 *
 *   accept_terms = "yes"                      → documents can be converted
 *   [feature_flags._metadata]
 *   last_updated_at = "…"                     → flags were fetched at least once (F2)
 *   [feature_flags."boost-cli-filtering"]
 *   user = true / remote = false              → whether shell output is filtered (§8.4)
 *   [filters]
 *   disabled = ["go", "node-test"]            → filters Boost switched off after retrieves
 *   [measurement]
 *   boost_off_sessions = false
 *
 * The alternative, `boost feature-flags`, is slow, goes to the network and
 * rewrites this very file, so it is never run (the spawn spy enforces that).
 *
 * The parser is a tolerant TOML subset — sections (including quoted names),
 * basic and literal strings, booleans, numbers, multi-line arrays, inline
 * tables and comments. A statement it cannot parse is skipped, not fatal:
 * Boost owns the format, and a new construct in a part of the file this
 * extension does not read must not blind it to the parts it does. Files over
 * 1 MiB are not read at all — Boost writes a few kilobytes, so anything that
 * large is not a config worth parsing on a tool's critical path.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type BoostVersion,
	compareVersions,
	FLAGS_MIN_VERSION,
	VALIDATED_BOOST_VERSION,
} from "./boost-binary.ts";
import type { ShellMode } from "./settings.ts";

/** Larger config files are skipped (treated as absent). */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/** The flag that gates Boost's stdin filter since v0.14.6. */
export const CLI_FILTERING_FLAG = "boost-cli-filtering";
/** The flag that gates `boost hook claude`'s MCP filters. */
export const MCP_FILTERING_FLAG = "boost-mcp-filtering";

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

/** A parsed document: section path (JSON-encoded) → key → value. */
export type TomlDocument = Map<string, Map<string, TomlValue>>;

const sectionKey = (path: readonly string[]): string => JSON.stringify(path);

class TomlError extends Error {}

/**
 * Parse the TOML subset described above. Statements that fail to parse are
 * skipped to the end of their line; the rest of the document still parses.
 * A leading UTF-8 byte order mark is skipped, as Boost's Go decoder does.
 */
export function parseToml(text: string): TomlDocument {
	const doc: TomlDocument = new Map();
	let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	let section: string[] = [];

	const peek = (offset = 0) => text[pos + offset] ?? "";
	const startsWith = (token: string) => text.startsWith(token, pos);
	const skipInline = () => {
		while (peek() === " " || peek() === "\t") pos++;
	};
	const skipToEol = () => {
		while (pos < text.length && peek() !== "\n") pos++;
	};
	/** Whitespace, newlines and comments: what may sit between array items. */
	const skipBlank = () => {
		for (;;) {
			const c = peek();
			if (c === " " || c === "\t" || c === "\r" || c === "\n") pos++;
			else if (c === "#") skipToEol();
			else return;
		}
	};

	const basicString = (): string => {
		const multi = startsWith('"""');
		pos += multi ? 3 : 1;
		if (multi && peek() === "\n") pos++;
		else if (multi && startsWith("\r\n")) pos += 2;
		let out = "";
		for (;;) {
			if (pos >= text.length) throw new TomlError("unterminated string");
			if (multi ? startsWith('"""') : peek() === '"') {
				pos += multi ? 3 : 1;
				return out;
			}
			const c = peek();
			if (!multi && c === "\n") throw new TomlError("newline in string");
			if (c === "\\") {
				const e = peek(1);
				pos += 2;
				const simple: Record<string, string> = {
					b: "\b",
					t: "\t",
					n: "\n",
					f: "\f",
					r: "\r",
					'"': '"',
					"\\": "\\",
				};
				if (e in simple) out += simple[e];
				else if (e === "u" || e === "U") {
					const len = e === "u" ? 4 : 8;
					const hex = text.slice(pos, pos + len);
					if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new TomlError("bad escape");
					out += String.fromCodePoint(Number.parseInt(hex, 16));
					pos += len;
				} else if (multi && (e === "\n" || e === " " || e === "\t" || e === "\r")) {
					// Line-ending backslash: trim the newline and leading whitespace.
					pos--;
					while (/[ \t\r\n]/.test(peek())) pos++;
				} else throw new TomlError("bad escape");
				continue;
			}
			out += c;
			pos++;
		}
	};

	const literalString = (): string => {
		const multi = startsWith("'''");
		pos += multi ? 3 : 1;
		if (multi && peek() === "\n") pos++;
		const end = text.indexOf(multi ? "'''" : "'", pos);
		if (end < 0) throw new TomlError("unterminated string");
		const out = text.slice(pos, end);
		if (!multi && out.includes("\n")) throw new TomlError("newline in string");
		pos = end + (multi ? 3 : 1);
		return out;
	};

	const keySegment = (): string => {
		if (peek() === '"') return basicString();
		if (peek() === "'") return literalString();
		const match = /^[A-Za-z0-9_-]+/.exec(text.slice(pos, pos + 256));
		if (!match) throw new TomlError("bad key");
		pos += match[0].length;
		return match[0];
	};

	const dottedKey = (): string[] => {
		const parts = [keySegment()];
		for (;;) {
			skipInline();
			if (peek() !== ".") return parts;
			pos++;
			skipInline();
			parts.push(keySegment());
		}
	};

	const value = (): TomlValue => {
		const c = peek();
		if (c === '"') return basicString();
		if (c === "'") return literalString();
		if (c === "[") {
			pos++;
			const items: TomlValue[] = [];
			for (;;) {
				skipBlank();
				if (peek() === "]") {
					pos++;
					return items;
				}
				items.push(value());
				skipBlank();
				if (peek() === ",") pos++;
				else if (peek() !== "]") throw new TomlError("bad array");
			}
		}
		if (c === "{") {
			pos++;
			const table: { [key: string]: TomlValue } = {};
			skipInline();
			if (peek() === "}") {
				pos++;
				return table;
			}
			for (;;) {
				skipInline();
				const key = dottedKey().join(".");
				skipInline();
				if (peek() !== "=") throw new TomlError("bad inline table");
				pos++;
				skipInline();
				table[key] = value();
				skipInline();
				if (peek() === ",") pos++;
				else if (peek() === "}") {
					pos++;
					return table;
				} else throw new TomlError("bad inline table");
			}
		}
		// A bare token: boolean, number, or a date-time (kept as its text).
		const match = /^[^\s,\]}#]+/.exec(text.slice(pos, pos + 256));
		if (!match) throw new TomlError("missing value");
		let token = match[0];
		pos += token.length;
		// An offset date-time may contain one space between date and time.
		if (/^\d{4}-\d{2}-\d{2}$/.test(token) && /^ \d{2}:/.test(text.slice(pos, pos + 4))) {
			const time = /^ [^\s,\]}#]+/.exec(text.slice(pos, pos + 64));
			if (time) {
				token += time[0];
				pos += time[0].length;
			}
		}
		if (token === "true") return true;
		if (token === "false") return false;
		const numeric = token.replaceAll("_", "");
		if (/^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|inf|nan)$/.test(numeric)) return Number(numeric);
		if (/^0x[0-9a-fA-F]+$/.test(numeric)) return Number.parseInt(numeric.slice(2), 16);
		if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(token)) return token;
		throw new TomlError("bad value");
	};

	const put = (path: readonly string[], key: string, v: TomlValue) => {
		const id = sectionKey(path);
		let table = doc.get(id);
		if (!table) {
			table = new Map();
			doc.set(id, table);
		}
		table.set(key, v);
	};

	while (pos < text.length) {
		skipBlank();
		if (pos >= text.length) break;
		const statementStart = pos;
		try {
			if (peek() === "[") {
				// `[[array.of.tables]]` is not needed; its keys are skipped by
				// pointing the section somewhere no reader looks.
				const arrayTable = startsWith("[[");
				pos += arrayTable ? 2 : 1;
				skipInline();
				const path = dottedKey();
				skipInline();
				if (!startsWith(arrayTable ? "]]" : "]")) throw new TomlError("bad header");
				pos += arrayTable ? 2 : 1;
				section = arrayTable ? ["\u0000array", ...path] : path;
				if (!doc.has(sectionKey(section))) doc.set(sectionKey(section), new Map());
			} else {
				const key = dottedKey();
				skipInline();
				if (peek() !== "=") throw new TomlError("expected =");
				pos++;
				skipInline();
				const v = value();
				const last = key[key.length - 1] ?? "";
				put([...section, ...key.slice(0, -1)], last, v);
			}
			skipInline();
			if (peek() === "#") skipToEol();
			if (pos < text.length && peek() !== "\n" && !startsWith("\r\n")) throw new TomlError("trailing");
		} catch (error) {
			if (!(error instanceof TomlError)) throw error;
			// Tolerant: drop this statement and resume on the line after the one
			// it started on — not after wherever parsing gave up, which for an
			// unterminated array would swallow the valid lines that follow it.
			pos = statementStart;
			skipToEol();
		}
	}
	return doc;
}

/** One feature flag as Boost records it: the user's override and the fetched value. */
export interface FlagValue {
	user?: boolean;
	remote?: boolean;
}

export interface BoostConfig {
	/** Boost's Preview Agreement is recorded (`accept_terms = "yes"`). */
	termsAccepted: boolean;
	/** When it was accepted, as Boost wrote it. */
	termsAt?: string;
	/**
	 * When flags were last fetched (`[feature_flags._metadata] last_updated_at`).
	 * Absent on a fresh install, which makes every call stall ~5 s unless
	 * flag fetching is disabled for it (F2, §8.3).
	 */
	flagsUpdatedAt?: string;
	/** A flag's recorded values; `{}` when the flag is not in the file. */
	flag(name: string): FlagValue;
	/** Filters Boost switched off after repeated retrieves (`[filters] disabled`). */
	disabledFilters: string[];
	/** `[measurement] boost_off_sessions`, shown in status only. */
	boostOffSessions?: boolean;
}

function get(doc: TomlDocument, path: readonly string[], key: string): TomlValue | undefined {
	return doc.get(sectionKey(path))?.get(key);
}

const asBool = (v: TomlValue | undefined): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const asString = (v: TomlValue | undefined): string | undefined =>
	typeof v === "string" && v ? v : undefined;

/** The facts this extension reads from a `config.toml` text. */
export function parseBoostConfig(text: string): BoostConfig {
	const doc = parseToml(text);
	const terms = get(doc, [], "accept_terms");
	const termsAccepted = terms === true || (typeof terms === "string" && terms.toLowerCase() === "yes");
	const termsAt = asString(get(doc, [], "accept_terms_at"));
	const flagsUpdatedAt = asString(get(doc, ["feature_flags", "_metadata"], "last_updated_at"));
	const disabled = get(doc, ["filters"], "disabled");
	const boostOffSessions = asBool(get(doc, ["measurement"], "boost_off_sessions"));
	return {
		termsAccepted,
		...(termsAt ? { termsAt } : {}),
		...(flagsUpdatedAt ? { flagsUpdatedAt } : {}),
		flag(name) {
			const user = asBool(get(doc, ["feature_flags", name], "user"));
			const remote = asBool(get(doc, ["feature_flags", name], "remote"));
			return { ...(user !== undefined ? { user } : {}), ...(remote !== undefined ? { remote } : {}) };
		},
		disabledFilters: Array.isArray(disabled)
			? disabled.filter((item): item is string => typeof item === "string")
			: [],
		...(boostOffSessions !== undefined ? { boostOffSessions } : {}),
	};
}

/** What a missing, unreadable or oversized config means: nothing recorded. */
export const EMPTY_CONFIG: BoostConfig = parseBoostConfig("");

/** Where Boost keeps its config for a given home directory. */
export function boostConfigPath(home: string): string {
	return join(home, ".boost", "config.toml");
}

/**
 * The read-only file operations the reader is allowed. Typed this narrowly on
 * purpose: there is no write method to call by mistake.
 */
export interface ConfigFs {
	statSync(path: string): { mtimeMs: number; size: number; isFile(): boolean };
	readFileSync(path: string, encoding: "utf8"): string;
}

export interface ConfigReader {
	/** The current config: re-read only when the file's mtime or size changed. */
	read(): BoostConfig;
}

export interface ConfigReaderOptions {
	/** Defaults to `os.homedir()`, read on every call so a changed HOME is followed. */
	home?: () => string;
	/** Overrides the path outright (tests). */
	path?: string;
	fs?: ConfigFs;
}

export function createConfigReader(options: ConfigReaderOptions = {}): ConfigReader {
	const fs: ConfigFs = options.fs ?? { statSync, readFileSync };
	const home = options.home ?? homedir;
	const pathOf = () => options.path ?? boostConfigPath(home());
	let cache: { path: string; mtimeMs: number; size: number; config: BoostConfig } | undefined;

	return {
		read() {
			const path = pathOf();
			try {
				const stat = fs.statSync(path);
				if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
					cache = undefined;
					return EMPTY_CONFIG;
				}
				if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
					return cache.config;
				}
				const config = parseBoostConfig(fs.readFileSync(path, "utf8"));
				cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, config };
				return config;
			} catch {
				// Missing (never initialised) or unreadable: nothing recorded.
				cache = undefined;
				return EMPTY_CONFIG;
			}
		},
	};
}

/** Where a flag's effective value came from, highest precedence first. */
export type FlagSource = "force-enabled" | "force-disabled" | "user" | "remote" | "unknown";

export interface FlagResolution {
	value: boolean | "unknown";
	source: FlagSource;
}

/** A comma-separated list (`a, b ,c` → `["a","b","c"]`), empty items dropped. */
export function envList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * A flag's value as Boost will see it, decided without spawning Boost:
 * `BOOST_FEATURE_FLAGS_FORCE_ENABLED`, then `…_FORCE_DISABLED` (comma lists in
 * the environment Boost inherits), then the user's override, then the
 * fetched remote value. None of them: `unknown`, and Boost's built-in default
 * applies — which the caller must decide per Boost version.
 */
export function resolveFlag(config: BoostConfig, name: string, env: NodeJS.ProcessEnv): FlagResolution {
	if (envList(env.BOOST_FEATURE_FLAGS_FORCE_ENABLED).includes(name)) {
		return { value: true, source: "force-enabled" };
	}
	if (envList(env.BOOST_FEATURE_FLAGS_FORCE_DISABLED).includes(name)) {
		return { value: false, source: "force-disabled" };
	}
	const flag = config.flag(name);
	if (flag.user !== undefined) return { value: flag.user, source: "user" };
	if (flag.remote !== undefined) return { value: flag.remote, source: "remote" };
	return { value: "unknown", source: "unknown" };
}

/** Why the shell route is on or off; `/boost status` explains it from this. */
export type ShellGateReason =
	| "setting-on"
	| "setting-off"
	| "flag"
	| "unknown-before-flags"
	| "unknown-newer-than-validated"
	| "unknown-default-off";

export interface ShellGate {
	on: boolean;
	reason: ShellGateReason;
	flag: FlagResolution;
}

/**
 * Whether Boost's stdin filter will filter pi's shell output, so a result is
 * only sent when it can come back shorter (spec §8.4). Without this gate the
 * extension spawned Boost for every shell result on a default install, where
 * CLI filtering is off and every call is a ~200 ms no-op.
 *
 * - `on`: always — `boost-cli-filtering` is then forced on in pi's own child
 *   environment only (F1); config.toml is never touched.
 * - `off`: never.
 * - `auto`: the flag's resolved value. When nothing records it, Boost's
 *   built-in default decides: on before v0.14.6, off ("CLI filtering remains
 *   opt-in") from v0.14.6 through the validated 0.15.x, and for a Boost newer
 *   than that the call is made and Boost decides, so a future default change
 *   is not shadowed by this extension.
 */
export function shellGate(
	setting: ShellMode,
	config: BoostConfig,
	env: NodeJS.ProcessEnv,
	version: BoostVersion | undefined,
): ShellGate {
	const flag = resolveFlag(config, CLI_FILTERING_FLAG, env);
	if (setting === "on") return { on: true, reason: "setting-on", flag };
	if (setting === "off") return { on: false, reason: "setting-off", flag };
	if (flag.value !== "unknown") return { on: flag.value, reason: "flag", flag };
	if (version && compareVersions(version, FLAGS_MIN_VERSION) < 0) {
		return { on: true, reason: "unknown-before-flags", flag };
	}
	if (version && newerThanValidatedLine(version)) {
		return { on: true, reason: "unknown-newer-than-validated", flag };
	}
	return { on: false, reason: "unknown-default-off", flag };
}

/** Newer than the validated major.minor line (0.15.x), not merely a later patch. */
function newerThanValidatedLine(version: BoostVersion): boolean {
	return (
		compareVersions(
			[version[0], version[1], 0],
			[VALIDATED_BOOST_VERSION[0], VALIDATED_BOOST_VERSION[1], 0],
		) > 0
	);
}

// ---------------------------------------------------------------------------
// Flag freshness (§8.3 amendment)

/** Default TTL for Boost's flag cache in pi's children, unless the user set one (Probe 3). */
export const FLAGS_TTL = "24h";
/** {@link FLAGS_TTL} in milliseconds: metadata older than this would make Boost refresh. */
export const FLAGS_TTL_MS = 24 * 60 * 60 * 1000;

const GO_DURATION_UNITS: Readonly<Record<string, number>> = {
	ns: 1e-6,
	us: 1e-3,
	µs: 1e-3,
	μs: 1e-3,
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
};

/**
 * A Go `time.ParseDuration` string (`24h`, `1h30m`, `90s`, `1.5h`, `0`) in
 * milliseconds, or undefined when it is not one. Boost reads
 * `BOOST_FEATURE_FLAGS_TTL` with Go's parser; this covers the same grammar
 * except negative values, which no one sets as a cache lifetime. Like Go, it
 * allows no whitespace.
 */
export function parseGoDuration(value: string): number | undefined {
	const text = value.replace(/^\+/, "");
	if (text === "0") return 0;
	if (text === "") return undefined;
	const part = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/y;
	let total = 0;
	let index = 0;
	while (index < text.length) {
		part.lastIndex = index;
		const match = part.exec(text);
		if (!match) return undefined;
		total += Number(match[1]) * (GO_DURATION_UNITS[match[2] as string] ?? Number.NaN);
		index = part.lastIndex;
	}
	return Number.isFinite(total) ? total : undefined;
}

/**
 * How old Boost's fetched feature flags are, and whether that is past the
 * TTL in effect — that is, whether Boost would try to refresh them on a call
 * (and stall offline). The client turns fetching off for pi's hot-path calls
 * when they are stale, so those never refresh them; `/boost status` reports
 * the same answer for the user to judge. A missing or unparseable
 * `last_updated_at` is stale (Boost cannot use it either); a user TTL this
 * parser does not understand is left to the user and Boost (not stale).
 * `ageMs` is undefined when the flags were never fetched or the timestamp is
 * unreadable.
 */
export function flagsFreshness(
	config: BoostConfig,
	env: NodeJS.ProcessEnv,
	now: number,
): { stale: boolean; ageMs?: number } {
	const at = config.flagsUpdatedAt ? Date.parse(config.flagsUpdatedAt) : Number.NaN;
	if (Number.isNaN(at)) return { stale: true };
	const ageMs = Math.max(0, now - at);
	const userTtl = env.BOOST_FEATURE_FLAGS_TTL ? parseGoDuration(env.BOOST_FEATURE_FLAGS_TTL) : undefined;
	// A TTL Go would parse but this cannot is the user's business; say nothing.
	if (env.BOOST_FEATURE_FLAGS_TTL && userTtl === undefined) return { stale: false, ageMs };
	return { stale: ageMs >= (userTtl ?? FLAGS_TTL_MS), ageMs };
}
