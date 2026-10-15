/**
 * The extension's settings (spec §9): schema, defaults, the file, environment
 * overrides, kill switches and precedence.
 *
 * The file is `$PI_JFROG_BOOST_SETTINGS`, or `<agentDir>/jfrog-boost.json`
 * where agentDir mirrors pi's `getAgentDir()` (`$PI_CODING_AGENT_DIR`, else
 * `~/.pi/agent`, normalised as pi's `normalizePath` does) without importing
 * a value from pi. It is deliberately
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
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Git Bash, MSYS, Cygwin and WSL drive paths (`/c/Users/me`, `/mnt/c/…`,
 * `/cygdrive/c/…`) as native Windows paths, as pi's
 * `normalizeWindowsShellPath` does; anything else unchanged.
 */
function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return path;
	return `${(match[1] ?? "").toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/**
 * A configured path normalised the way pi 1.2's `normalizePath` treats
 * `$PI_CODING_AGENT_DIR` (shell drive paths on Windows, `~`, `file://`), so
 * this reads and saves the file in the directory pi itself uses.
 */
function normalizeConfiguredPath(input: string, home: string, platform: NodeJS.Platform): string {
	const windows = platform === "win32";
	const path = windows ? windowsShellPath(input) : input;
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return joinFor(platform)(home, path.slice(2));
	if (path.startsWith("file://")) return fileURLToPath(path, { windows });
	return path;
}

function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
	return platform === "win32" ? win32.join : posix.join;
}

/** pi's agent directory, as `getAgentDir()` computes it. */
export function agentDir(
	env: NodeJS.ProcessEnv,
	home: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const configured = env.PI_CODING_AGENT_DIR;
	return configured
		? normalizeConfiguredPath(configured, home, platform)
		: joinFor(platform)(home, ".pi", "agent");
}

/** Where the settings file is read from and saved to. */
export function settingsPath(
	env: NodeJS.ProcessEnv,
	home: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const explicit = env.PI_JFROG_BOOST_SETTINGS;
	return explicit
		? normalizeConfiguredPath(explicit, home, platform)
		: joinFor(platform)(agentDir(env, home, platform), SETTINGS_FILE_NAME);
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
	/** Absent in a test double: the path is then taken as it is. */
	realpathSync?(path: string): string;
	/** Absent in a test double: a new file's mode is used. */
	statSync?(path: string): { mode: number };
}

const realFs: SettingsFs = {
	readFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
	rmSync,
	realpathSync: (path) => realpathSync(path),
	statSync: (path) => statSync(path),
};

/** A leading UTF-8 byte order mark (PowerShell 5, older Notepad), as pi drops it from its own settings. */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

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
		return parseSettings(JSON.parse(stripBom(text)));
	} catch (error) {
		return { values: {}, invalid: [], unknown: [], error: (error as Error).message, raw: {} };
	}
}

/**
 * Write the file atomically: a temp file next to it, then a rename over it,
 * so pi exiting mid-save (or a second pi saving at once) never leaves a
 * truncated file that would reset every setting to its default.
 *
 * A symlinked file (a dotfiles repo under stow or chezmoi) is written
 * through: the rename lands on the link's target, so the link stays a link.
 * An existing file keeps its permission bits (a user's 0600 stays 0600).
 */
export function saveSettingsFile(path: string, raw: Record<string, unknown>, fs: SettingsFs = realFs): void {
	let target = path;
	try {
		if (fs.realpathSync) target = fs.realpathSync(path);
	} catch {
		// Not there yet (ENOENT) or not resolvable: write the path as given.
		target = path;
	}
	let mode = 0o644;
	try {
		if (fs.statSync) mode = fs.statSync(target).mode & 0o777;
	} catch {
		/* a new file */
	}
	fs.mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
	const tmp = `${target}.tmp-${process.pid}`;
	const body = `${JSON.stringify({ $schema: SETTINGS_SCHEMA_URL, ...raw }, null, "\t")}\n`;
	try {
		fs.writeFileSync(tmp, body, { encoding: "utf8", mode });
		fs.renameSync(tmp, target);
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
 * meant) for no gain. {@link excludedBy} folds every character outside
 * `[A-Za-z0-9_*]` to `_` in both the pattern and the name before they get
 * here, so `.` in particular is never anything but a literal. Implemented by
 * hand rather than as a RegExp so a user pattern can never be a pathological
 * expression; the greedy backtracking below is linear in practice for names
 * this short.
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

/**
 * `text` spelled the way pi 1.2.0 spells MCP tool names. Its built-in client
 * builds `mcp__<server>__<tool>` and then turns every character outside
 * `[A-Za-z0-9_]` into `_` (`createMcpToolName`, pi 1.2.0
 * `dist/extensions/mcp/tools.js`), so a server configured as `my-secrets` or
 * `acme.slack` reaches this extension as `mcp__my_secrets__…` /
 * `mcp__acme_slack__…`. `*` is spared so it stays the one wildcard.
 */
function foldToolNameChars(text: string): string {
	return text.replace(/[^A-Za-z0-9_*]/g, "_");
}

/**
 * The first `mcpExclude` pattern `toolName` matches, if any (as the user
 * wrote it, for the explanation line).
 *
 * Both sides are folded with {@link foldToolNameChars}, because the names
 * come from two places that disagree. pi 1.2.0's own client sanitizes them,
 * so a user who writes the server's configured name (`mcp__my-secrets__*`)
 * must still match `mcp__my_secrets__get`. But on pi 0.86 every `mcp__*` tool
 * comes from a third-party extension, and nothing makes those sanitize: a
 * Claude-Code-style `mcp__my-secrets__get` keeps its hyphen, and the same
 * pattern must match that too. Folding only the pattern (as an earlier
 * version did) broke the second case; folding only the name would break the
 * first. Folding both covers each, and this is a privacy control, so the one
 * cost — `mcp__my_secrets__*` also catches a distinct server literally named
 * `my-secrets` — errs towards keeping bodies out of Boost's DB and sync, never
 * towards letting them through. `*` is never folded into, so a pattern still
 * cannot match a wider shape than its wildcards allow.
 */
export function excludedBy(toolName: string, patterns: readonly string[]): string | undefined {
	const name = foldToolNameChars(toolName);
	return patterns.find((pattern) => globMatches(foldToolNameChars(pattern.trim()), name));
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
	/**
	 * `/boost settings reset`: drop every key this version knows from the file,
	 * atomically, so defaults apply. Keys it does not know are kept: they may
	 * belong to a newer version of this extension sharing the file.
	 */
	reset(): void;
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
 * Warnings already given in this process (§10.4 `settings`: once per
 * process). Not a module-level set: pi loads extensions with jiti's module
 * cache off and rebuilds them for every `/new`, `/resume`, `/fork` and
 * `/reload`, which evaluates this module afresh and would empty such a set,
 * so the same bad key would warn on every session switch. Hung on
 * `globalThis` under a registered symbol instead, as status.ts does for the
 * other notices.
 */
function warnedInProcess(): Set<string> {
	const key = Symbol.for("pi-jfrog-boost.settings-warned");
	const store = globalThis as unknown as Record<symbol, Set<string> | undefined>;
	store[key] ??= new Set<string>();
	return store[key];
}

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

	/**
	 * The file as it is on disk now, without `$schema`, for a save to merge
	 * into. Re-read so a key edited by hand since load() is not reverted.
	 */
	const currentRaw = (path: string): Record<string, unknown> => {
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
		return raw;
	};

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
			const warned = warnedInProcess();
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
			const raw = currentRaw(path);
			for (const key of SETTINGS_KEYS) {
				if (!(key in values)) continue;
				const value = values[key];
				if (!isValidSetting(key, value)) throw new Error(`invalid value for "${key}"`);
				raw[key] = value;
			}
			saveSettingsFile(path, raw, fs);
			file = parseSettings(raw);
		},
		reset() {
			const path = pathOf();
			const raw = currentRaw(path);
			for (const key of SETTINGS_KEYS) delete raw[key];
			saveSettingsFile(path, raw, fs);
			file = parseSettings(raw);
		},
	};
}

// ---------------------------------------------------------------------------
// The session toggle across a rebuilt runtime

/** Custom session entry holding the last `/boost on|off` (`{ enabled }`). */
export const SESSION_TOGGLE_ENTRY = "jfrog-boost-session";

/** The parts of pi's session manager this reads; both exist from 0.86.1 on. */
export interface SessionToggleEntries {
	getBranch?: () => unknown;
	getEntries?: () => unknown;
}

function lastToggle(entries: unknown): boolean | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (entry && entry.type === "custom" && entry.customType === SESSION_TOGGLE_ENTRY) {
			const enabled = (entry.data as { enabled?: unknown } | null)?.enabled;
			if (typeof enabled === "boolean") return enabled;
		}
	}
	return undefined;
}

/**
 * The last `/boost on|off` on the current branch, or undefined for a session
 * where neither was used. pi rebuilds the extension (and with it the
 * settings store) for `/reload`, `/resume` and `/fork`, so a toggle held only
 * in memory would silently turn Boost back on; it is persisted as a session
 * entry and restored at `session_start`, as the savings are. The branch, not
 * every entry, so a toggle on a sibling branch does not leak in;
 * `getEntries()` only when the branch cannot be read at all.
 */
export function restoreSessionToggle(sessionManager: SessionToggleEntries | undefined): boolean | undefined {
	if (!sessionManager) return undefined;
	let branch: unknown;
	try {
		if (typeof sessionManager.getBranch === "function") branch = sessionManager.getBranch();
	} catch {
		branch = undefined;
	}
	if (Array.isArray(branch)) return lastToggle(branch);
	try {
		if (typeof sessionManager.getEntries === "function") return lastToggle(sessionManager.getEntries());
	} catch {
		/* nothing to restore from */
	}
	return undefined;
}
