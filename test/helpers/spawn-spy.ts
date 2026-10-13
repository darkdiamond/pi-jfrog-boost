/**
 * Suite-wide guard for the never-spawn rule (spec invariant 4): the extension
 * must never run `boost retrieve`, `feature-flags`, `init` or `filters`.
 *
 * Why it matters: those commands mutate Boost's state for every agent on the
 * machine. A retrieve counts towards Boost switching a filter off globally,
 * `feature-flags` rewrites `~/.boost/config.toml` and goes to the network,
 * `init` accepts JFrog's agreement and installs hooks into other agents. Only
 * the model (through its own shell) or the user may run them.
 *
 * `npm test` and `npm run test:e2e` load this file with `node --import`, which
 * node's test runner passes on to every test file's process, so the spy
 * covers the whole suite. Suites that spawn Boost also import it directly, so
 * running one file by hand is still guarded; installing twice is a no-op.
 *
 * Mechanism: `child_process` is patched on its CommonJS object and then
 * `syncBuiltinESMExports()` pushes the patch into the live ESM bindings, so
 * `import { spawn } from "node:child_process"` in `src/` sees the spy too.
 * A forbidden spawn throws before any process starts — the command never runs
 * — and is recorded; the process then exits non-zero, which the test runner
 * reports as a failed file even if the caller swallowed the throw (as the
 * fail-open client does).
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

/** Boost subcommands the extension must never run itself. */
export const FORBIDDEN: ReadonlySet<string> = new Set(["retrieve", "feature-flags", "init", "filters"]);

export interface Violation {
	file: string;
	args: string[];
	stack: string;
}

const KEY = Symbol.for("pi-jfrog-boost.spawn-spy");
interface SpyState {
	violations: Violation[];
}

/**
 * The Boost subcommand a spawn would run. Normally `args[0]`; for the Node
 * stand-in (`node test/fixtures/fake-boost.mjs <args>`) it is the argument
 * after the script, so unit tests are held to the same rule as real Boost.
 */
export function boostSubcommand(args: readonly string[]): string | undefined {
	const first = args[0];
	if (first !== undefined && basename(first) === "fake-boost.mjs") return args[1];
	return first;
}

/**
 * Whether a spawn with `args` breaks the never-spawn rule. Deliberately blind
 * to the executable: the rule is about what Boost is asked to do, and a
 * binary can be called anything (`BOOST_BIN`, a wrapper script, the stand-in).
 */
export function isForbiddenSpawn(args: readonly string[] | undefined): boolean {
	if (!Array.isArray(args)) return false;
	const sub = boostSubcommand(args);
	return sub !== undefined && FORBIDDEN.has(sub);
}

function install(): SpyState {
	const existing = (globalThis as Record<symbol, unknown>)[KEY] as SpyState | undefined;
	if (existing) return existing;
	const state: SpyState = { violations: [] };
	(globalThis as Record<symbol, unknown>)[KEY] = state;

	const cp = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
	// Every entry point that takes (file, args): spawn, execFile and their sync
	// forms. `exec`/`execSync` take a shell string, which the extension never
	// uses; `fork` runs a module, not Boost.
	for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
		const original = cp[name] as (...a: unknown[]) => unknown;
		cp[name] = function spied(this: unknown, file: unknown, args: unknown, ...rest: unknown[]) {
			const argv = Array.isArray(args) ? (args as unknown[]).map(String) : undefined;
			if (typeof file === "string" && isForbiddenSpawn(argv)) {
				const violation = {
					file,
					args: argv ?? [],
					stack: new Error("forbidden spawn").stack ?? "",
				};
				state.violations.push(violation);
				throw new Error(`spawn-spy: forbidden Boost command \`${violation.args.join(" ")}\``);
			}
			return original.call(this, file, args, ...rest);
		};
	}
	syncBuiltinESMExports();

	process.on("exit", () => {
		if (state.violations.length === 0) return;
		for (const v of state.violations) {
			process.stderr.write(
				`spawn-spy: the never-spawn rule was broken: ${v.file} ${v.args.join(" ")}\n${v.stack}\n`,
			);
		}
		process.exitCode = 1;
	});
	return state;
}

const state = install();

/** Violations recorded so far in this process. */
export function violations(): readonly Violation[] {
	return state.violations;
}

/**
 * Remove and return the recorded violations. Only the spy's own self-test
 * should call this, after deliberately tripping it.
 */
export function takeViolations(): Violation[] {
	return state.violations.splice(0);
}
