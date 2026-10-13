/**
 * A throwaway HOME for running the real Boost binary from tests (spec §16.3).
 *
 * Why this exists: Boost keeps machine-wide state under HOME — the config with
 * the Preview Agreement and feature flags, a history DB that feeds
 * `boost report`, and a retrieve counter that switches a filter off for every
 * agent after a few retrieves. The 0.3.0 suite isolated only `XDG_DATA_HOME`,
 * which Boost ignores on macOS, so each run wrote the maintainer's real history
 * and counted its retrieve towards disabling a real filter. Here nothing Boost
 * can find through the environment points outside a temp directory, and a
 * tripwire proves it afterwards.
 *
 * What it does, in order:
 *  1. Resolves the binary *before* HOME moves (`BOOST_BIN`, else the normal
 *     resolver), and passes it on through `BOOST_BIN` and the front of PATH.
 *  2. `mkdtemp`s a root; each HOME under it gets a synthesized
 *     `.boost/config.toml`: fresh `[feature_flags._metadata] last_updated_at`
 *     (without it every call stalls ~5 s on a flag refresh, spec F2) and
 *     `boost-cli-filtering` `user = true`, so shell filtering is
 *     deterministic whatever JFrog's remote default is that day.
 *  3. Copies only the three terms lines, read-only, from
 *     `BOOST_E2E_TERMS_FROM` (default: the real `~/.boost/config.toml`), or
 *     the whole config from `BOOST_E2E_HOME/.boost/config.toml`. The suite
 *     never accepts the agreement itself; without terms, document cases skip.
 *  4. Points HOME/USERPROFILE, BOOST_DB_PATH, TMPDIR/TEMP/TMP and XDG_* into
 *     the temp HOME, and every proxy variable at a refused port
 *     (127.0.0.1:9) so Boost cannot reach the network for flags, updates or
 *     sync. `PI_BOOST_SYNC=0` and `BOOST_FEATURE_FLAGS_TTL=24h` keep it quiet.
 *  5. Fingerprints the real Boost state (sha256 + size + mtime, or absence) so
 *     the suite can fail on any change — including a `.boost/` or
 *     `install_id` appearing where none was. Data directories are walked and
 *     every file in them fingerprinted, so a rewrite of state the suite does
 *     not name (`unused-hint`, lock files) is caught too. Another agent using
 *     the real Boost during the run trips it as well: keep them idle.
 *
 * Variant HOMEs (`user-false`, `no-metadata`, `no-terms`) are for cases that
 * need Boost to see a different machine state; each is its own directory with
 * its own DB and temp dir.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveBoostBinary } from "../../src/boost-binary.ts";

export type HomeVariant = "default" | "user-false" | "no-metadata" | "no-terms";

/** A port nothing listens on: connections are refused at once rather than timing out. */
export const REFUSED_PROXY = "http://127.0.0.1:9";

const TERMS_KEYS = ["accept_terms", "accept_terms_at", "terms_version"] as const;

/**
 * The terms lines of a Boost config: top-level `accept_terms`,
 * `accept_terms_at` and `terms_version` assignments, before the first
 * `[section]`. Nothing else from the source file is ever copied.
 */
export function termsLinesFrom(config: string): string[] {
	const lines: string[] = [];
	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) break;
		const key = /^([A-Za-z_]+)\s*=/.exec(line)?.[1];
		if (key && (TERMS_KEYS as readonly string[]).includes(key)) lines.push(line);
	}
	return lines;
}

/** Whether the terms lines record an accepted agreement. */
export function termsAccepted(lines: readonly string[]): boolean {
	return lines.some((line) => /^accept_terms\s*=\s*(?:"yes"|'yes'|true)\s*$/i.test(line));
}

/** The synthesized `config.toml` for one HOME variant. */
export function synthesizeConfig(variant: HomeVariant, terms: readonly string[], now: Date): string {
	const parts: string[] = [];
	if (variant !== "no-terms" && terms.length > 0) parts.push(`${terms.join("\n")}\n`);
	if (variant !== "no-metadata") {
		parts.push(`[feature_flags._metadata]\nlast_updated_at = "${now.toISOString()}"\n`);
	}
	parts.push(
		`[feature_flags."boost-cli-filtering"]\nuser = ${variant === "user-false" ? "false" : "true"}\n`,
	);
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Tripwire

export interface FileFingerprint {
	kind: "file";
	sha256: string;
	size: number;
	mtimeMs: number;
}

export type Fingerprint =
	| { kind: "absent" }
	| FileFingerprint
	| {
			kind: "dir";
			/** Every entry below the directory, as sorted relative paths (`/`-separated). */
			entries: string[];
			/** A fingerprint of every regular file below it, keyed like `entries`. */
			files: Record<string, FileFingerprint | { kind: "entry-only" }>;
	  }
	| { kind: "other" };

/**
 * SQLite's shared-memory index: rewritten by any process that merely opens
 * the DB in WAL mode, readers included, so its bytes say nothing about
 * whether Boost wrote state. Its appearance or disappearance still counts.
 */
const ENTRY_ONLY = /-shm$/;
/** Bounds for walking a watched directory; Boost's own hold a handful of files. */
const MAX_DEPTH = 4;
const MAX_ENTRIES = 2000;

function fileFingerprint(path: string, stats: Stats): FileFingerprint {
	const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	return { kind: "file", sha256, size: stats.size, mtimeMs: stats.mtimeMs };
}

/**
 * A read-only fingerprint. A directory is walked, and each regular file in it
 * is fingerprinted too (sha256 + size + mtime), not only its name: Boost
 * keeps state in files the suite does not name — `unused-hint`, the
 * `*.lock` files, files a future release adds — and a run that rewrote one
 * must not pass. Directory mtimes are ignored; entries and file contents
 * carry the signal.
 */
export function fingerprint(path: string): Fingerprint {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch {
		return { kind: "absent" };
	}
	if (stats.isFile()) return fileFingerprint(path, stats);
	if (!stats.isDirectory()) return { kind: "other" };
	const entries: string[] = [];
	const files: Record<string, FileFingerprint | { kind: "entry-only" }> = {};
	const walk = (dir: string, prefix: string, depth: number) => {
		for (const name of readdirSync(dir).sort()) {
			if (entries.length >= MAX_ENTRIES) return;
			const rel = prefix ? `${prefix}/${name}` : name;
			const full = join(dir, name);
			entries.push(rel);
			let inner: Stats;
			try {
				inner = statSync(full);
			} catch {
				// Gone between readdir and stat: the entry list still records it,
				// and the next fingerprint will not, so the change is reported.
				continue;
			}
			if (inner.isFile()) {
				files[rel] = ENTRY_ONLY.test(name) ? { kind: "entry-only" } : fileFingerprint(full, inner);
			} else if (inner.isDirectory() && depth < MAX_DEPTH) {
				walk(full, rel, depth + 1);
			}
		}
	};
	walk(path, "", 1);
	return { kind: "dir", entries, files };
}

/** What changed inside a watched directory, one line per entry. */
function dirChanges(
	was: Extract<Fingerprint, { kind: "dir" }>,
	now: Extract<Fingerprint, { kind: "dir" }>,
): string[] {
	const found: string[] = [];
	const names = [...new Set([...was.entries, ...now.entries])].sort();
	for (const name of names) {
		const before = was.entries.includes(name) ? (was.files[name] ?? { kind: "dir" as const }) : undefined;
		const after = now.entries.includes(name) ? (now.files[name] ?? { kind: "dir" as const }) : undefined;
		if (JSON.stringify(before) === JSON.stringify(after)) continue;
		const show = (print: typeof before) =>
			print === undefined ? "absent" : print.kind === "file" ? describe(print) : print.kind;
		found.push(`${name}: ${show(before)} → ${show(after)}`);
	}
	return found;
}

function describe(print: Fingerprint): string {
	switch (print.kind) {
		case "file":
			return `file ${print.size} B sha256 ${print.sha256.slice(0, 12)} mtime ${print.mtimeMs}`;
		case "dir":
			return `dir [${print.entries.join(", ")}]`;
		default:
			return print.kind;
	}
}

export interface Tripwire {
	readonly paths: readonly string[];
	/** Human-readable changes since the snapshot; empty when nothing moved. */
	changes(): string[];
	/** Throws, naming every changed path, when anything moved. */
	assertUnchanged(): void;
}

export function createTripwire(paths: readonly string[]): Tripwire {
	const unique = [...new Set(paths.map((path) => resolve(path)))];
	const before = new Map(unique.map((path) => [path, fingerprint(path)]));
	const changes = () => {
		const found: string[] = [];
		for (const [path, was] of before) {
			const now = fingerprint(path);
			if (JSON.stringify(now) === JSON.stringify(was)) continue;
			if (now.kind === "dir" && was.kind === "dir") {
				for (const change of dirChanges(was, now)) found.push(`${path}/${change}`);
			} else {
				found.push(`${path}: ${describe(was)} → ${describe(now)}`);
			}
		}
		return found;
	};
	return {
		paths: unique,
		changes,
		assertUnchanged() {
			const found = changes();
			if (found.length > 0) {
				throw new Error(
					`hermetic tripwire: real Boost state changed during the run:\n  ${found.join("\n  ")}`,
				);
			}
		},
	};
}

/**
 * Where a real Boost keeps state for `realHome`: the config and its directory,
 * the history DB on macOS (`~/Library/Application Support/boost`, where it
 * also writes `install_id`), Linux (`~/.local/share/boost` or
 * `$XDG_DATA_HOME/boost`) and Windows (`%LOCALAPPDATA%\boost`), plus a
 * `.boost/` in the working directory, where hook-based integrations write.
 */
export function realBoostPaths(realHome: string, env: NodeJS.ProcessEnv, cwd: string): string[] {
	const appSupport = join(realHome, "Library", "Application Support", "boost");
	const share = join(realHome, ".local", "share", "boost");
	const paths = [
		join(realHome, ".boost"),
		join(realHome, ".boost", "config.toml"),
		appSupport,
		join(appSupport, "history.db"),
		join(appSupport, "history.db-wal"),
		join(appSupport, "install_id"),
		share,
		join(share, "history.db"),
		join(share, "history.db-wal"),
		join(cwd, ".boost"),
	];
	// A custom DB location in the developer's own environment: `inherited()`
	// strips BOOST_DB_PATH from the child env, so that DB is never written,
	// but it is real Boost state and must be watched like the default one.
	if (env.BOOST_DB_PATH) paths.push(env.BOOST_DB_PATH, `${env.BOOST_DB_PATH}-wal`);
	if (env.XDG_DATA_HOME) paths.push(join(env.XDG_DATA_HOME, "boost"));
	if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, "boost"));
	return paths;
}

// ---------------------------------------------------------------------------
// The hermetic environment

export interface HermeticOptions {
	/** The environment to start from. Default: `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** The user's real home, never written. Default: `os.userInfo().homedir`, which ignores HOME. */
	realHome?: string;
	platform?: NodeJS.Platform;
	now?: Date;
	/** Directory to create the temp root in. Default: the real `os.tmpdir()`. */
	parent?: string;
	/** The working directory whose `.boost/` the tripwire watches. Default: `process.cwd()`. */
	cwd?: string;
}

export interface Hermetic {
	/** The temp root; every HOME lives under it. */
	readonly root: string;
	/** The default HOME (`user = true`, fresh metadata, terms when available). */
	readonly home: string;
	/** The Boost binary, resolved against the real environment before HOME moved. */
	readonly binary: string | undefined;
	/** The terms lines copied in, and where from. */
	readonly terms: readonly string[];
	readonly termsSource: string | undefined;
	readonly termsAvailable: boolean;
	/** Why document cases cannot run, when `termsAvailable` is false. */
	readonly termsMissingReason: string | undefined;
	/** The full child environment for the default HOME. */
	readonly env: NodeJS.ProcessEnv;
	readonly tripwire: Tripwire;
	/** Create (once) and return the HOME for a variant. */
	variantHome(variant: HomeVariant): string;
	/** The full child environment for a HOME made by `variantHome`. */
	envFor(home: string): NodeJS.ProcessEnv;
	/**
	 * Replace `process.env` with the default HOME's environment — pi's own tools
	 * spawn with it — and return a function that restores the original.
	 */
	apply(): () => void;
	/** Throws unless the live HOME is this harness's, and not the real one. */
	assertIsolated(): void;
	/** Remove the temp root. */
	dispose(): void;
}

/** Variables cleared so the caller's shell cannot steer Boost or the extension. */
function inherited(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		const upper = key.toUpperCase();
		if (
			upper.startsWith("BOOST_") ||
			upper.startsWith("PI_BOOST_") ||
			upper.startsWith("XDG_") ||
			upper.startsWith("FAKE_BOOST_") ||
			upper.endsWith("_PROXY") ||
			[
				"DISABLE_BOOST",
				"PI_JFROG_BOOST_SETTINGS",
				"PI_CODING_AGENT_DIR",
				"HOME",
				"USERPROFILE",
				"TMPDIR",
				"TEMP",
				"TMP",
				// Set by node's test runner in each test file's process. A test
				// command the suite runs through pi's bash (`node --test …`) would
				// inherit it, think it is nested, and run nothing.
				"NODE_TEST_CONTEXT",
				// Startup files a non-interactive shell sources: pi's bash runs
				// `bash -c`, which reads BASH_ENV (and sh reads ENV), so either
				// could re-point HOME or PATH for the commands the suite runs —
				// including `boost retrieve` — after this harness set them.
				"BASH_ENV",
				"ENV",
			].includes(upper)
		) {
			continue;
		}
		env[key] = value;
	}
	return env;
}

export function createHermetic(options: HermeticOptions = {}): Hermetic {
	const source = options.env ?? process.env;
	const realHome = options.realHome ?? userInfo().homedir;
	const platform = options.platform ?? process.platform;
	const now = options.now ?? new Date();
	const cwd = options.cwd ?? process.cwd();

	// Fingerprint first, before this function creates anything.
	const tripwire = createTripwire(realBoostPaths(realHome, source, cwd));

	// 1. The binary, while HOME still points at the real home.
	const binary = source.BOOST_BIN || resolveBoostBinary({ env: source, platform, home: realHome });

	// 3. Terms, read-only.
	let terms: string[] = [];
	let termsSource: string | undefined;
	let wholeConfig: string | undefined;
	if (source.BOOST_E2E_HOME) {
		termsSource = join(source.BOOST_E2E_HOME, ".boost", "config.toml");
		if (existsSync(termsSource)) {
			wholeConfig = readFileSync(termsSource, "utf8");
			terms = termsLinesFrom(wholeConfig);
		}
	} else {
		termsSource = source.BOOST_E2E_TERMS_FROM || join(realHome, ".boost", "config.toml");
		if (existsSync(termsSource)) terms = termsLinesFrom(readFileSync(termsSource, "utf8"));
	}
	const termsAvailable = termsAccepted(terms);
	const termsMissingReason = termsAvailable
		? undefined
		: `no accepted Boost Preview Agreement in ${termsSource}; set BOOST_E2E_TERMS_FROM to a config.toml that has one (the suite never accepts it for you)`;

	// 2. The temp root, outside anything that could be a real home.
	const root = mkdtempSync(join(options.parent ?? tmpdir(), "pi-boost-hermetic-"));
	const homes = new Map<HomeVariant, string>();

	const variantHome = (variant: HomeVariant): string => {
		const existing = homes.get(variant);
		if (existing) return existing;
		const home = join(root, variant === "default" ? "home" : `home-${variant}`);
		mkdirSync(join(home, ".boost"), { recursive: true });
		mkdirSync(join(home, "tmp"), { recursive: true });
		const config =
			variant === "default" && wholeConfig !== undefined
				? wholeConfig
				: synthesizeConfig(variant, terms, now);
		writeFileSync(join(home, ".boost", "config.toml"), config);
		homes.set(variant, home);
		return home;
	};

	const base = inherited(source);
	const envFor = (home: string): NodeJS.ProcessEnv => {
		const tmp = join(home, "tmp");
		const env: NodeJS.ProcessEnv = {
			...base,
			HOME: home,
			USERPROFILE: home,
			BOOST_DB_PATH: join(home, "history.db"),
			TMPDIR: tmp,
			TEMP: tmp,
			TMP: tmp,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			HTTP_PROXY: REFUSED_PROXY,
			HTTPS_PROXY: REFUSED_PROXY,
			ALL_PROXY: REFUSED_PROXY,
			http_proxy: REFUSED_PROXY,
			https_proxy: REFUSED_PROXY,
			all_proxy: REFUSED_PROXY,
			BOOST_FEATURE_FLAGS_TTL: "24h",
			PI_BOOST_SYNC: "0",
			// Keeps pi's own settings, and this extension's settings file, inside
			// the temp HOME as well.
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		};
		if (platform === "win32") {
			env.APPDATA = join(home, "AppData", "Roaming");
			env.LOCALAPPDATA = join(home, "AppData", "Local");
		}
		if (binary) {
			env.BOOST_BIN = binary;
			const pathKey = Object.keys(base).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
			env[pathKey] = [dirname(binary), base[pathKey]].filter(Boolean).join(delimiter);
		}
		return env;
	};

	const home = variantHome("default");
	const env = envFor(home);

	const assertIsolated = () => {
		const live = platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
		if (!live || resolve(live) === resolve(realHome)) {
			throw new Error(`hermetic: HOME is the real home (${realHome}); refusing to run Boost`);
		}
		if (resolve(live) !== resolve(home) && ![...homes.values()].some((h) => resolve(h) === resolve(live))) {
			throw new Error(`hermetic: HOME (${live}) is not a hermetic HOME under ${root}`);
		}
	};

	return {
		root,
		home,
		binary,
		terms,
		termsSource,
		termsAvailable,
		termsMissingReason,
		env,
		tripwire,
		variantHome,
		envFor,
		apply() {
			const saved = { ...process.env };
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, env);
			return () => {
				for (const key of Object.keys(process.env)) delete process.env[key];
				Object.assign(process.env, saved);
			};
		},
		assertIsolated,
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
