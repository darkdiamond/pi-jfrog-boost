/**
 * The extension's settings (spec §9): schema, defaults, the file, environment
 * overrides, kill switches and precedence.
 *
 * The file is `$PI_JFROG_BOOST_SETTINGS`, or `<agentDir>/jfrog-boost.json`
 * where agentDir mirrors pi's `getAgentDir()` (`$PI_CODING_AGENT_DIR`, else
 * `~/.pi/agent`) without importing a value from pi. It is deliberately
 * global only: a repository must not be able to change what leaves the
 * machine (sync, observe, MCP bodies) or point the extension at a binary.
 * `pi.getSettings()` is not used — it is missing on 0.86.1 and read-only.
 *
 * Validation is per key: one bad value falls back to its default with a
 * warning naming the key and the file, and every other key still applies.
 * A settings typo must never be the reason Boost is off, or on.
 *
 * Precedence, highest first:
 *   1. env kill switch (`DISABLE_BOOST`, `BOOST_DISABLED`) — read live
 *   2. `--no-boost`
 *   3. the session toggle (`/boost on|off`)
 *   4. per-key env (`PI_BOOST_SHELL`, `PI_BOOST_DOCUMENTS`, …)
 *   5. the file
 *   6. defaults
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETTINGS_SCHEMA_URL =
	"https://raw.githubusercontent.com/darkdiamond/pi-jfrog-boost/main/settings.schema.json";
export const SETTINGS_FILE_NAME = "jfrog-boost.json";

export type ShellMode = "auto" | "on" | "off";
export const SHELL_MODES: readonly ShellMode[] = ["auto", "on", "off"];

export interface Settings {
	/** Persisted master switch. */
	enabled: boolean;
	/** "auto" follows Boost's boost-cli-filtering flag; "on" forces it for pi's own Boost calls. */
	shell: ShellMode;
	/** Re-filter pi's full output file when bash output was truncated. */
	fullOutput: boolean;
	/** Skip shell/log output smaller than this many bytes. */
	minBytes: number;
	/** Convert PDF/Office/ODF reads (needs Boost's Preview Agreement accepted). */
	documents: boolean;
	/** Convert whole reads of .ipynb ≥ 16 KiB. */
	notebooks: boolean;
	/** Compact whole reads of *.log / *.out. */
	readLogs: boolean;
	/** Compact mcp__* results via Boost's MCP filters. */
	mcp: boolean;
	/** Glob patterns of MCP tool names never sent to Boost. */
	mcpExclude: string[];
	/** More tool names routed like bash. */
	extraTools: string[];
	footer: boolean;
	/** Per-row transcript badge (pi ≥ 1.0.1). */
	badges: boolean;
	awareness: boolean;
	/** Run `boost sync` when the agent settles (uploads to JFrog). */
	sync: boolean;
	/** Lifecycle telemetry (tool I/O excerpts) to Boost. */
	observe: boolean;
}

export type SettingsKey = keyof Settings;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
	enabled: true,
	shell: "auto",
	fullOutput: true,
	minBytes: 2048,
	documents: true,
	notebooks: true,
	readLogs: false,
	mcp: true,
	mcpExclude: [],
	extraTools: [],
	footer: true,
	badges: true,
	awareness: true,
	sync: true,
	observe: false,
});

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

/** The largest `minBytes` worth accepting: above the 1 MiB input ceiling nothing is ever sent. */
const MAX_MIN_BYTES = 1024 * 1024;

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isStringList = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((item) => typeof item === "string" && item.trim() !== "");

/** Per-key validators. A value that fails falls back to the default. */
const VALID: { [K in SettingsKey]: (v: unknown) => boolean } = {
	enabled: isBoolean,
	shell: (v) => typeof v === "string" && (SHELL_MODES as readonly string[]).includes(v),
	fullOutput: isBoolean,
	minBytes: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_MIN_BYTES,
	documents: isBoolean,
	notebooks: isBoolean,
	readLogs: isBoolean,
	mcp: isBoolean,
	mcpExclude: isStringList,
	extraTools: isStringList,
	footer: isBoolean,
	badges: isBoolean,
	awareness: isBoolean,
	sync: isBoolean,
	observe: isBoolean,
};

export function isValidSetting<K extends SettingsKey>(key: K, value: unknown): value is Settings[K] {
	return VALID[key](value);
}

// ---------------------------------------------------------------------------
// Paths

function expandTilde(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

/** pi's agent directory, as `getAgentDir()` computes it. */
export function agentDir(env: NodeJS.ProcessEnv, home: string): string {
	const configured = env.PI_CODING_AGENT_DIR;
	return configured ? expandTilde(configured, home) : join(home, ".pi", "agent");
}

/** Where the settings file is read from and saved to. */
export function settingsPath(env: NodeJS.ProcessEnv, home: string): string {
	const explicit = env.PI_JFROG_BOOST_SETTINGS;
	return explicit ? expandTilde(explicit, home) : join(agentDir(env, home), SETTINGS_FILE_NAME);
}

// ---------------------------------------------------------------------------
// The file

export interface FileSettings {
	/** Valid keys from the file. */
	values: Partial<Settings>;
	/** Keys present but invalid; their defaults apply. */
	invalid: SettingsKey[];
	/** Keys this version does not know (listed by `/boost settings`, otherwise ignored). */
	unknown: string[];
	/** Why the file could not be used at all; absent when it was read or does not exist. */
	error?: string;
	/** The whole parsed object, so a save keeps keys this version does not know. */
	raw: Record<string, unknown>;
}

/** Validate a settings object key by key. */
export function parseSettings(raw: unknown): FileSettings {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { values: {}, invalid: [], unknown: [], error: "not a JSON object", raw: {} };
	}
	const record = raw as Record<string, unknown>;
	const values: Partial<Record<SettingsKey, unknown>> = {};
	const invalid: SettingsKey[] = [];
	const unknown: string[] = [];
	for (const [key, value] of Object.entries(record)) {
		if (key === "$schema") continue;
		if (!(key in VALID)) {
			unknown.push(key);
			continue;
		}
		const k = key as SettingsKey;
		if (VALID[k](value)) values[k] = Array.isArray(value) ? [...value] : value;
		else invalid.push(k);
	}
	return { values: values as Partial<Settings>, invalid, unknown, raw: { ...record } };
}

/** Narrow file access, injectable by tests. */
export interface SettingsFs {
	readFileSync(path: string, encoding: "utf8"): string;
	writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode: number }): void;
	renameSync(from: string, to: string): void;
	mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
	rmSync(path: string, options: { force: true }): void;
}

const realFs: SettingsFs = { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync };

/** Read and validate the file. A missing file is not an error: it means defaults. */
export function loadSettingsFile(path: string, fs: SettingsFs = realFs): FileSettings {
	let text: string;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { values: {}, invalid: [], unknown: [], raw: {} };
		}
		return { values: {}, invalid: [], unknown: [], error: (error as Error).message, raw: {} };
	}
	try {
		return parseSettings(JSON.parse(text));
	} catch (error) {
		return { values: {}, invalid: [], unknown: [], error: (error as Error).message, raw: {} };
	}
}

/**
 * Write the file atomically: a temp file next to it, then a rename over it,
 * so pi exiting mid-save (or a second pi saving at once) never leaves a
 * truncated file that would reset every setting to its default.
 */
export function saveSettingsFile(path: string, raw: Record<string, unknown>, fs: SettingsFs = realFs): void {
	fs.mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	const tmp = `${path}.tmp-${process.pid}`;
	const body = `${JSON.stringify({ $schema: SETTINGS_SCHEMA_URL, ...raw }, null, "\t")}\n`;
	try {
		fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o644 });
		fs.renameSync(tmp, path);
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			/* nothing to clean */
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Environment

/** `0/1/true/false/yes/no`, any case; anything else is not a boolean. */
export function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "1" || v === "true" || v === "yes") return true;
	if (v === "0" || v === "false" || v === "no") return false;
	return undefined;
}

/** Per-key environment overrides (precedence 4). */
export const ENV_KEYS: Readonly<Partial<Record<SettingsKey, string>>> = {
	shell: "PI_BOOST_SHELL",
	documents: "PI_BOOST_DOCUMENTS",
	mcp: "PI_BOOST_MCP",
	sync: "PI_BOOST_SYNC",
	observe: "PI_BOOST_OBSERVE",
};

export function envOverrides(env: NodeJS.ProcessEnv): Partial<Settings> {
	const out: Partial<Settings> = {};
	const shell = env.PI_BOOST_SHELL?.trim().toLowerCase();
	if (shell && (SHELL_MODES as readonly string[]).includes(shell)) out.shell = shell as ShellMode;
	for (const key of ["documents", "mcp", "sync", "observe"] as const) {
		const name = ENV_KEYS[key];
		const value = name ? parseEnvBoolean(env[name]) : undefined;
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** The env kill switches, `1` or `true` (any case). */
export const KILL_SWITCH_VARS = ["DISABLE_BOOST", "BOOST_DISABLED"] as const;

/** The env kill switch that is set, if any. Read on every call: no caching. */
export function envKillSwitch(env: NodeJS.ProcessEnv): (typeof KILL_SWITCH_VARS)[number] | undefined {
	for (const name of KILL_SWITCH_VARS) {
		const value = env[name]?.trim().toLowerCase();
		if (value === "1" || value === "true") return name;
	}
	return undefined;
}

/** The `--no-boost` flag's value counts as on when it is `true` or `"true"`. */
export function flagIsOn(value: unknown): boolean {
	return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

// ---------------------------------------------------------------------------
// mcpExclude

/**
 * Whether `name` matches a `mcpExclude` pattern: `*` stands for any run of
 * characters (none included), everything else is literal and case-sensitive,
 * and the whole name must match. `mcp__secrets__*` covers one server,
 * `*__delete_*` a kind of tool on every server.
 *
 * Deliberately this small: a full glob or regex grammar would make a privacy
 * control easy to get subtly wrong (`.` or `?` matching more than the user
 * meant) for no gain, since pi's MCP tool names are `[A-Za-z0-9_]` only — it
 * replaces everything else with `_` when it builds them. Implemented by hand rather than as a RegExp
 * so a user pattern can never be a pathological expression; the greedy
 * backtracking below is linear in practice for names this short.
 */
export function globMatches(pattern: string, name: string): boolean {
	const parts = pattern.split("*");
	if (parts.length === 1) return pattern === name;
	const first = parts[0] as string;
	const last = parts[parts.length - 1] as string;
	if (name.length < first.length + last.length) return false;
	if (!name.startsWith(first) || !name.endsWith(last)) return false;
	// Each middle piece must appear, in order, between the fixed ends; taking
	// the earliest occurrence of each is always safe for `*`-only patterns.
	let index = first.length;
	const end = name.length - last.length;
	for (const part of parts.slice(1, -1)) {
		if (!part) continue;
		const found = name.indexOf(part, index);
		if (found < 0 || found + part.length > end) return false;
		index = found + part.length;
	}
	return true;
}

/** The first `mcpExclude` pattern `toolName` matches, if any. */
export function excludedBy(toolName: string, patterns: readonly string[]): string | undefined {
	return patterns.find((pattern) => globMatches(pattern.trim(), toolName));
}

// ---------------------------------------------------------------------------
// The store

export type SettingSource = "default" | "file" | "env";

/** What switched the extension off, when it is off. */
export type OffReason =
	| { by: "env"; name: (typeof KILL_SWITCH_VARS)[number] }
	| { by: "flag" }
	| { by: "session" }
	| { by: "settings" };

export interface SettingsStore {
	/** The settings file path. */
	path(): string;
	/**
	 * Re-read the file. Returns the warnings not yet given in this process
	 * (an invalid key, an unreadable file), for the caller to show.
	 */
	load(): string[];
	/** Per-key env over the file over defaults (precedence 4–6). */
	effective(): Settings;
	/** Where each effective value came from. */
	sources(): Record<SettingsKey, SettingSource>;
	/** Keys in the file this version does not know. */
	unknownKeys(): string[];
	/**
	 * Whether the extension is off, and why, highest precedence first:
	 * env kill switch, `--no-boost`, session toggle, the `enabled` setting.
	 */
	off(): OffReason | undefined;
	/** `/boost on|off` for this session; undefined clears it. */
	setSession(enabled: boolean | undefined): void;
	/** Merge `values` into the file and save it atomically (only from `/boost settings`). */
	save(values: Partial<Settings>): void;
}

export interface SettingsStoreDeps {
	/** Live environment (kill switches and overrides are read on every call). */
	env?: NodeJS.ProcessEnv;
	home?: () => string;
	/** The `--no-boost` flag's current value. */
	flag?: () => unknown;
	fs?: SettingsFs;
}

/**
 * Warnings already given in this process. Module-level on purpose: `/reload`
 * builds a new store, and the same bad key should not warn again for it.
 */
const warned = new Set<string>();

function formatDefault(value: unknown): string {
	return JSON.stringify(value);
}

export function createSettingsStore(deps: SettingsStoreDeps = {}): SettingsStore {
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir;
	const fs = deps.fs ?? realFs;
	const pathOf = () => settingsPath(env, home());
	let file: FileSettings = { values: {}, invalid: [], unknown: [], raw: {} };
	let session: boolean | undefined;

	const effective = (): Settings => {
		const merged = { ...DEFAULT_SETTINGS, ...file.values, ...envOverrides(env) };
		return { ...merged, mcpExclude: [...merged.mcpExclude], extraTools: [...merged.extraTools] };
	};

	return {
		path: pathOf,
		load() {
			const path = pathOf();
			file = loadSettingsFile(path, fs);
			const out: string[] = [];
			const once = (id: string, message: string) => {
				if (warned.has(id)) return;
				warned.add(id);
				out.push(message);
			};
			if (file.error) {
				once(
					`${path}\u0000<file>`,
					`pi-jfrog-boost: could not read ${path} (${file.error}); using the default settings.`,
				);
			}
			for (const key of file.invalid) {
				once(
					`${path}\u0000${key}`,
					`pi-jfrog-boost: ignored invalid "${key}" in ${path} (using ${formatDefault(DEFAULT_SETTINGS[key])}).`,
				);
			}
			return out;
		},
		effective,
		sources() {
			const fromEnv = envOverrides(env);
			const out = {} as Record<SettingsKey, SettingSource>;
			for (const key of SETTINGS_KEYS) {
				out[key] = key in fromEnv ? "env" : key in file.values ? "file" : "default";
			}
			return out;
		},
		unknownKeys: () => [...file.unknown],
		off() {
			const name = envKillSwitch(env);
			if (name) return { by: "env", name };
			if (flagIsOn(deps.flag?.())) return { by: "flag" };
			if (session !== undefined) return session ? undefined : { by: "session" };
			return effective().enabled ? undefined : { by: "settings" };
		},
		setSession(enabled) {
			session = enabled;
		},
		save(values) {
			const path = pathOf();
			// Re-read first so a key edited by hand since load() is not reverted.
			const current = loadSettingsFile(path, fs);
			// A file that exists but cannot be read or parsed (a stray comma, a
			// permissions change) reads as `{}`. Saving over it would replace the
			// user's mostly-correct file with just the keys being saved, so refuse
			// and say why; the user fixes or removes it and saves again.
			if (current.error !== undefined) {
				throw new Error(`cannot save: ${path} is unreadable (${current.error}); fix or remove it first`);
			}
			const raw: Record<string, unknown> = { ...current.raw };
			delete raw.$schema;
			for (const key of SETTINGS_KEYS) {
				if (!(key in values)) continue;
				const value = values[key];
				if (!isValidSetting(key, value)) throw new Error(`invalid value for "${key}"`);
				raw[key] = value;
			}
			saveSettingsFile(path, raw, fs);
			file = parseSettings(raw);
		},
	};
}
