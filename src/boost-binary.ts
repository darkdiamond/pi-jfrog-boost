/**
 * Locating the Boost binary, and the version facts the rest of the extension
 * keys on.
 *
 * The search order mirrors `_boost_resolve_exe` in Boost's own `boost-sync.sh`
 * hook, so this extension finds the same install every other Boost integration
 * on the machine does — including Windows layouts, where Boost ships as
 * `boost.exe` under `%LOCALAPPDATA%\boost\bin`.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type BoostVersion = [number, number, number];

/** Lowest Boost release that answers `boost hook <agent>` with hook JSON. */
export const MIN_BOOST_VERSION: BoostVersion = [0, 13, 13];
/**
 * The release this version of the extension was validated against (spec §2).
 * A newer Boost still works; `/boost status` says it is newer than validated,
 * and the shell gate lets Boost decide an unset CLI-filtering flag (§8.4).
 */
export const VALIDATED_BOOST_VERSION: BoostVersion = [0, 15, 4];
/** From here on CLI filtering is behind the opt-in `boost-cli-filtering` flag. */
export const FLAGS_MIN_VERSION: BoostVersion = [0, 14, 6];
/** First release whose `boost hook claude` filters MCP tool results. */
export const MCP_MIN_VERSION: BoostVersion = [0, 15, 3];

export interface ResolveOptions {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	home: string;
	/** Injected by tests; defaults to a real regular-file + `X_OK` check. */
	isExecutable?: (path: string) => boolean;
}

/**
 * A regular file the current user may execute. `X_OK` alone accepts a
 * directory (its search bit), so a `~/.local/bin/boost/` folder — or a
 * `BOOST_BIN` pointing at one — used to resolve, and every spawn then failed
 * with EACCES. On Windows `X_OK` is the same as `F_OK`; the `.exe`
 * preference below is what keeps an unrunnable file from winning there.
 */
export function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Every place Boost may be, best first: `BOOST_BIN`, then its `BOOST_EXE`
 * alias (the name Boost's own hooks read), the default install directory,
 * the Windows install directory, then PATH.
 */
function candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
	const names = platform === "win32" ? ["boost.exe", "boost"] : ["boost"];
	const list: string[] = [];
	if (env.BOOST_BIN) list.push(env.BOOST_BIN);
	if (env.BOOST_EXE) list.push(env.BOOST_EXE);
	if (home) for (const name of names) list.push(join(home, ".local", "bin", name));
	if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, "boost", "bin", "boost.exe"));
	for (const dir of pathDirs(env)) for (const name of names) list.push(join(dir, name));
	return list;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
	// Windows spells it `Path`; process.env is case-insensitive there, but an
	// injected plain object is not.
	const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	return (env[key] ?? "").split(delimiter).filter(Boolean);
}

/**
 * The first Boost binary that exists, or `undefined` when Boost is not
 * installed. `BOOST_BIN` wins outright so users can point at a custom build;
 * one that does not exist falls through rather than disabling Boost.
 *
 * On Windows a `.exe` anywhere beats an extensionless `boost` anywhere: the
 * extensionless one is the POSIX shell script Boost's installer leaves for
 * Git Bash, which `spawn` cannot run without a shell.
 */
export function resolveBoostBinary(options: ResolveOptions): string | undefined {
	const { env, platform, home } = options;
	const isExecutable = options.isExecutable ?? isExecutableFile;
	const list = candidates(env, platform, home);
	if (platform === "win32") {
		const exe = list.find((path) => path.toLowerCase().endsWith(".exe") && isExecutable(path));
		if (exe) return exe;
	}
	return list.find(isExecutable);
}

function realpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Whether `boost` typed in a shell finds this binary: the first `boost` on
 * PATH is the same file. When it is not, the awareness text gives the model
 * the absolute path instead (spec §12) — a binary-only install into
 * `~/.local/bin` is often not on PATH.
 */
export function onPath(
	binary: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
	isExecutable: (path: string) => boolean = isExecutableFile,
): boolean {
	const names = platform === "win32" ? ["boost.exe", "boost"] : ["boost"];
	const target = realpath(binary);
	for (const dir of pathDirs(env)) {
		for (const name of names) {
			const path = join(dir, name);
			if (isExecutable(path)) return realpath(path) === target;
		}
	}
	return false;
}

/** The parts of a binary's identity that change when Boost updates itself. */
export interface BinaryStamp {
	mtimeMs: number;
	size: number;
}

/**
 * The binary's stamp, or undefined when it is gone. Boost auto-updates in
 * place, so the readiness memo is keyed on this rather than on the path.
 */
export function binaryStamp(path: string): BinaryStamp | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
	} catch {
		return undefined;
	}
}

/** Parse the `boost v0.13.24` banner `boost version` prints. */
export function parseBoostVersion(output: string): BoostVersion | undefined {
	const match = /\bv(\d+)\.(\d+)\.(\d+)/.exec(output);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a: BoostVersion, b: BoostVersion): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Whether `version` is at least `min`; false when the version is unknown. */
export function atLeast(version: BoostVersion | undefined, min: BoostVersion): boolean {
	return version !== undefined && compareVersions(version, min) >= 0;
}

/** Whether `version` is at least {@link MIN_BOOST_VERSION}. */
export function isSupportedVersion(version: BoostVersion | undefined): boolean {
	return atLeast(version, MIN_BOOST_VERSION);
}

/** `0.15.4`, for messages. */
export function formatVersion(version: BoostVersion): string {
	return version.join(".");
}
