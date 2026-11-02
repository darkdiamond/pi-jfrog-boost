/**
 * Stand-ins for the runtime pieces `createBoostExtension` takes as deps, so
 * suites that drive the extension never read the real `~/.boost/config.toml`
 * or `~/.pi/agent/jfrog-boost.json`, and never wait on a real readiness probe.
 */
import type { BoostCall, BoostClient } from "../../src/boost-client.ts";
import {
	type BoostConfig,
	type ConfigReader,
	EMPTY_CONFIG,
	parseBoostConfig,
} from "../../src/boost-config.ts";
import type { Readiness, ReadinessState } from "../../src/health.ts";
import {
	createSettingsStore,
	type SettingsFs,
	type SettingsStore,
	settingsPath,
} from "../../src/settings.ts";

/** A finished call that printed `stdout` and exited `code`. */
export function call(stdout: string, code: number | null = 0): BoostCall {
	return { code, stdout, ms: 1, timedOut: false, aborted: false };
}

/** A client whose every surface does nothing; tests override what they exercise. */
export function stubClient(overrides: Partial<BoostClient> = {}): BoostClient {
	return {
		binary: () => "/fake/boost",
		refresh: () => {},
		childEnv: () => ({}),
		version: async () => call("boost v0.16.11\n"),
		filter: async () => call("", 0),
		convert: async () => call("", 1),
		mcp: async () => call("", 0),
		observeDetached: () => {},
		sync: () => {},
		exec: async () => call(""),
		killAll: () => {},
		...overrides,
	};
}

/** A config reader that always returns `config` (TOML text or a parsed config). */
export function fixedConfig(config: BoostConfig | string = EMPTY_CONFIG): ConfigReader {
	const parsed = typeof config === "string" ? parseBoostConfig(config) : config;
	return { read: () => parsed };
}

/** A readiness that reports `state` and records how it was driven. */
export function fixedReadiness(
	state: ReadinessState = { kind: "ready", version: [0, 16, 11] },
	binary: string | undefined = "/fake/boost",
): Readiness & { starts: number; checks: number } {
	const r = {
		starts: 0,
		checks: 0,
		state: () => state,
		start() {
			r.starts++;
		},
		check() {
			r.checks++;
			return state;
		},
		wait: async () => state,
		retry() {},
		lastKnown: () => state,
		binary: () => binary,
		version: () => ("version" in state ? state.version : undefined),
	};
	return r;
}

/** An in-memory settings file system: `files` maps path → contents. */
export function memoryFs(
	files: Map<string, string> = new Map(),
): SettingsFs & { files: Map<string, string> } {
	return {
		files,
		readFileSync(path) {
			const text = files.get(path);
			if (text === undefined) {
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			}
			return text;
		},
		writeFileSync(path, data) {
			files.set(path, data);
		},
		renameSync(from, to) {
			const text = files.get(from);
			if (text === undefined) throw new Error(`ENOENT: ${from}`);
			files.set(to, text);
			files.delete(from);
		},
		mkdirSync: () => undefined,
		rmSync(path) {
			files.delete(path);
		},
	};
}

/**
 * A settings store over an in-memory settings file for HOME `/fake/home`,
 * holding `file` (if given), with `env` as the live environment.
 */
export function memorySettings(
	options: { env?: NodeJS.ProcessEnv; file?: Record<string, unknown>; flag?: () => unknown } = {},
): SettingsStore {
	const fs = memoryFs();
	if (options.file) fs.files.set(settingsPath(options.env ?? {}, "/fake/home"), JSON.stringify(options.file));
	return createSettingsStore({
		env: options.env ?? {},
		home: () => "/fake/home",
		fs,
		...(options.flag ? { flag: options.flag } : {}),
	});
}
