/**
 * Locating the Boost binary and checking that it speaks the hook protocol.
 *
 * The search order mirrors `_boost_resolve_exe` in Boost's own `boost-sync.sh`
 * hook, so this extension finds the same install every other Boost integration
 * on the machine does — including Windows layouts, where Boost ships as
 * `boost.exe` under `%LOCALAPPDATA%\boost\bin`.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Lowest Boost release that answers `boost hook <agent>` with hook JSON. */
export const MIN_BOOST_VERSION: BoostVersion = [0, 13, 13];

export type BoostVersion = [number, number, number];

export interface ResolveOptions {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	home: string;
	/** Injected by tests; defaults to a real `X_OK` check. */
	isExecutable?: (path: string) => boolean;
}

function executableOnDisk(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The first Boost binary that exists, or `undefined` when Boost is not
 * installed. `BOOST_BIN` wins outright so users can point at a custom build.
 */
export function resolveBoostBinary(options: ResolveOptions): string | undefined {
	const { env, platform, home } = options;
	const isExecutable = options.isExecutable ?? executableOnDisk;
	const names = platform === "win32" ? ["boost.exe", "boost"] : ["boost"];
	const candidates: string[] = [];

	if (env.BOOST_BIN) candidates.push(env.BOOST_BIN);
	for (const name of names) candidates.push(join(home, ".local", "bin", name));
	if (env.LOCALAPPDATA) {
		candidates.push(join(env.LOCALAPPDATA, "boost", "bin", "boost.exe"));
	}
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) candidates.push(join(dir, name));
	}

	return candidates.find(isExecutable);
}

/** Parse the `boost v0.13.24` banner `boost version` prints. */
export function parseBoostVersion(output: string): BoostVersion | undefined {
	const match = /\bv(\d+)\.(\d+)\.(\d+)/.exec(output);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `version` is at least {@link MIN_BOOST_VERSION}. */
export function isSupportedVersion(version: BoostVersion | undefined): boolean {
	if (!version) return false;
	for (let i = 0; i < MIN_BOOST_VERSION.length; i++) {
		const found = version[i] ?? 0;
		const required = MIN_BOOST_VERSION[i] ?? 0;
		if (found !== required) return found > required;
	}
	return true;
}
