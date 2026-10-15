/**
 * What the model is told about Boost (spec §12).
 *
 * Lossy compaction is only safe if the model knows how to get the original
 * back, so every Boost integration ships some text like this —
 * `~/.claude/rules/boost-awareness.md` for Claude Code, `BOOST.md` for Codex,
 * a skill for OpenCode. pi has `before_agent_start`, which lets us put it
 * directly in the system prompt rather than hoping the model opens a skill.
 *
 * Three rules shape everything here:
 *
 * - **Honest** (invariant 6). The text names only the surfaces that are
 *   actually active in this session: shell output only when Boost's shell
 *   gate is on and a shell tool (or an `extraTools` tool, routed like one)
 *   is visible, whole reads of logs only when `readLogs` is on as well, MCP
 *   only when the route can run and an `mcp__*` tool is visible, documents
 *   only when `read` is visible and the Preview Agreement is accepted. And
 *   it never calls a surface exact that is not: with `readLogs` on, `read`
 *   of a text file is no longer always exact, so the text stops saying so.
 *   0.3.0 claimed `read`, `grep`,
 *   `find` and `ls` were compacted, which on Boost v0.15.4 they never were;
 *   nothing here claims anything about them now. With no surface active
 *   there is no section at all — a model told "output may be shortened"
 *   when none ever is learns to distrust exact output.
 * - **Byte-stable.** pi diffs named sections against what the model already
 *   has, so an unchanged section keeps the provider's prompt cache. The text
 *   is a pure function of the view, and the view is built only from things
 *   that change on the triggers §12 lists (readiness to or from ready,
 *   `/boost on|off`, settings, an install, the config file, the loadout) —
 *   never from the breaker, a busy semaphore or the savings, which change
 *   from one tool result to the next.
 * - **Short.** It is paid for on every turn: under 1,200 characters with
 *   every surface active, Boost off PATH at a 100-character install path
 *   (longer than a Windows `%LOCALAPPDATA%\boost\bin\boost.exe` with a long
 *   user name) and a short `extraTools` name. The `extraTools` names are the
 *   one input the user can make arbitrarily long; each is named once.
 */
import { atLeast, type BoostVersion, MCP_MIN_VERSION } from "./boost-binary.ts";
import { isShellLike } from "./router.ts";
import { excludedBy } from "./settings.ts";

/** The system prompt section name; pi wraps the body as `<jfrog-boost>…</jfrog-boost>`. */
export const AWARENESS_SECTION = "jfrog-boost";

/** pi's shell tools, in the order the text names them. */
const SHELL_TOOLS = ["bash", "powershell"] as const;

/**
 * The tools pi shows the model when `systemPromptOptions` carries no
 * loadout (pi's `normalizeBuildSystemPromptOptions` default, 0.86.1 and
 * 1.2.0 alike). Spec §12 says "bash assumed"; taking pi's whole default also
 * keeps `read` — and so documents — visible on a pi that sends no loadout.
 */
export const DEFAULT_LOADOUT: readonly string[] = ["read", "bash", "edit", "write"];

/** Everything the awareness text depends on, and nothing else (spec §12). */
export interface AwarenessView {
	/** Visible shell tools whose output Boost filters: a subset of bash/powershell. */
	shellTools: readonly string[];
	/** Visible `extraTools` tools, routed like bash, whose output Boost filters. */
	extraTools: readonly string[];
	/** Whole `read`s of *.log / *.out go through Boost's filter (`readLogs`). */
	logs: boolean;
	/** MCP results go through Boost's MCP filters, and an `mcp__*` tool is visible. */
	mcp: boolean;
	/** `read` is visible, `documents` is on and the Preview Agreement is accepted. */
	documents: boolean;
	/** `documents`, and whole reads of large notebooks are converted too. */
	notebooks: boolean;
	/** How the model should spell Boost in a shell: `boost`, or the quoted absolute path. */
	boostCmd: string;
	/** Whether `boost` typed in the model's shell finds this binary. */
	onPath: boolean;
	/**
	 * Off PATH on win32 with both `bash` and `powershell` visible: the
	 * double-quoted path runs in bash but needs PowerShell's `&` call
	 * operator, so the text says so (see {@link boostCommand}).
	 */
	callOperator: boolean;
}

/** The inputs a view is derived from; gathered by index.ts without spawning. */
export interface AwarenessInputs {
	/** Boost is ready and no off switch is active. */
	ready: boolean;
	/** The `awareness` setting. */
	awareness: boolean;
	/** The shell gate (spec §8.4): Boost's stdin filter will filter shell output. */
	shellOn: boolean;
	settings: {
		mcp: boolean;
		mcpExclude: readonly string[];
		documents: boolean;
		notebooks: boolean;
		readLogs: boolean;
		extraTools: readonly string[];
	};
	/** The running Boost's version (the MCP route needs ≥ 0.15.3). */
	boostVersion: BoostVersion | undefined;
	/** `boost-mcp-filtering` as resolved from env and config. */
	mcpFlag: boolean | "unknown";
	termsAccepted: boolean;
	/** `systemPromptOptions` loadout (compat.ts `loadout`). */
	loadout: { selected?: readonly string[]; hidden?: readonly string[] };
	/** The resolved binary. */
	binary: string | undefined;
	onPath: boolean;
	platform: NodeJS.Platform;
}

/**
 * A path the model can paste into its shell as a command. Single quotes on
 * POSIX, where nothing inside them is special and a quote itself is closed,
 * escaped and reopened (`'\''`); double quotes on win32, where a path cannot
 * contain one.
 */
export function quoteCommand(path: string, platform: NodeJS.Platform): string {
	if (platform === "win32") return `"${path}"`;
	return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * How the model should spell Boost in its shell, and whether the text must
 * add that PowerShell needs `&` in front of it.
 *
 * On PATH it is just `boost`. Off PATH it is the quoted absolute path
 * (spec §12) — except that PowerShell parses a leading quoted string as an
 * expression, so `"C:\…\boost.exe" retrieve 147` is a parse error there
 * ("Unexpected token 'retrieve'"); only `& "C:\…\boost.exe" retrieve 147`
 * runs. With PowerShell the only visible shell, the command carries the `&`
 * itself. With bash visible too, it cannot — `&` at the start of a bash
 * command is a syntax error — so the path stays bare and the off-PATH line
 * names the operator instead. The shells counted are the visible ones,
 * gate or not: the model runs `retrieve` in whichever shell it has.
 */
export function boostCommand(
	binary: string,
	onPath: boolean,
	platform: NodeJS.Platform,
	visibleShells: readonly string[],
): { boostCmd: string; callOperator: boolean } {
	if (onPath) return { boostCmd: "boost", callOperator: false };
	const quoted = quoteCommand(binary, platform);
	if (platform !== "win32" || !visibleShells.includes("powershell")) {
		return { boostCmd: quoted, callOperator: false };
	}
	if (visibleShells.includes("bash")) return { boostCmd: quoted, callOperator: true };
	return { boostCmd: `& ${quoted}`, callOperator: false };
}

/** The tools the model can see: `selected − hidden`, or pi's default loadout. */
export function visibleTools(loadout: AwarenessInputs["loadout"]): string[] {
	const hidden = new Set(loadout.hidden ?? []);
	return (loadout.selected ?? DEFAULT_LOADOUT).filter((name) => !hidden.has(name));
}

/**
 * The view for these inputs, or undefined when the text must not be shown:
 * Boost not ready or off, `awareness: false`, or no surface active. Pure.
 */
export function awarenessView(r: AwarenessInputs): AwarenessView | undefined {
	if (!r.ready || !r.awareness || !r.binary) return undefined;
	const visible = visibleTools(r.loadout);
	const visibleShells = SHELL_TOOLS.filter((name) => visible.includes(name));
	const shellTools = r.shellOn ? visibleShells : [];
	// The rest of the shell route (router.ts `isShellLike`): a user's
	// `extraTools` entry, e.g. an extension's `fetch`, is filtered like bash
	// whenever the gate is on, so it is named like bash. In the order the
	// user listed them, which is as stable as the settings file.
	const extraTools = r.shellOn
		? [...new Set(r.settings.extraTools)].filter(
				(name) =>
					visible.includes(name) &&
					!SHELL_TOOLS.some((shell) => shell === name) &&
					isShellLike(name, r.settings.extraTools),
			)
		: [];
	// The log row of the read route: whole reads of *.log/*.out, through the
	// same stdin filter and so behind the same gate.
	const logs = r.shellOn && r.settings.readLogs && visible.includes("read");
	// The route's own static conditions (router.ts / mcp.ts `mcpSkip`): an
	// explicit `boost-mcp-filtering = false`, a Boost before 0.15.3, or every
	// visible MCP tool excluded means no MCP result will ever be shortened.
	const mcpRoute = r.settings.mcp && r.mcpFlag !== false && atLeast(r.boostVersion, MCP_MIN_VERSION);
	const mcp =
		mcpRoute &&
		visible.some((name) => name.startsWith("mcp__") && excludedBy(name, r.settings.mcpExclude) === undefined);
	const documents = visible.includes("read") && r.settings.documents && r.termsAccepted;
	const notebooks = documents && r.settings.notebooks;
	if (shellTools.length === 0 && extraTools.length === 0 && !logs && !mcp && !documents) return undefined;
	return {
		shellTools,
		extraTools,
		logs,
		mcp,
		documents,
		notebooks,
		...boostCommand(r.binary, r.onPath, r.platform, visibleShells),
		onPath: r.onPath,
	};
}

/** "a", "a and b", "a, b, and c". */
function joinList(items: readonly string[]): string {
	if (items.length <= 2) return items.join(" and ");
	return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * The section body for `view`, or undefined when there is none. Byte-stable:
 * the same view always gives the same string.
 */
export function buildAwareness(view: AwarenessView | undefined): string | undefined {
	if (!view) return undefined;
	const surfaces: string[] = [];
	const filtered = [...view.shellTools, ...view.extraTools];
	if (filtered.length > 0) surfaces.push(`${joinList(filtered.map((t) => `\`${t}\``))} output`);
	if (view.logs) surfaces.push("whole `read`s of *.log/*.out");
	if (view.mcp) surfaces.push("MCP tool results (`mcp__*`)");
	if (view.documents) surfaces.push("PDF and Office files you `read`");
	if (surfaces.length === 0) return undefined;

	// The §12 template, tightened: verbatim it came to ~1,385 characters with
	// every surface active and Boost off PATH, over §12's own 1,200 budget,
	// before a long Windows install path or the log and extraTools surfaces
	// (which §12's template predates) were counted. Every instruction and
	// every conditional line is kept; only phrasing went, and the second
	// full `retrieve` command became `(or --lines 40-80)`, so a long
	// absolute path is paid for once.
	const b = view.boostCmd;
	// With `readLogs` on, a `read` of a text file is not always exact any
	// more (invariant 6): the first line must not say it is.
	const exact = view.logs ? "other `read`s" : "`read` of text files";
	const lines = [
		`JFrog Boost shortens some tool output before you see it: ${joinList(surfaces)}. Everything else (${exact}, \`edit\`, \`write\`, …) is exact.`,
		"- Shortened output is intentional and usually enough; prefer it.",
		`- If a result ends with \`[… boost retrieve 147]\` and you need a dropped detail, run \`${b} retrieve <id> --query "<term>"\` (or \`--lines 40-80\`) rather than re-running the tool. Retrieve narrowly: repeated retrieves turn that filter off for every agent on this machine.`,
	];
	if (view.shellTools.length > 0) {
		lines.push(
			"- Prefix a command with `DISABLE_BOOST=1` for its exact output (e.g. raw HTML from curl/wget, which may arrive as readable text). Never pipe into `boost` yourself.",
		);
	}
	if (view.documents) {
		const nb = view.notebooks;
		lines.push(
			`- Documents${nb ? ", and notebooks read whole," : ""} arrive as converted text, paged like any read. Line numbers are not file lines; never \`edit\` from them.${nb ? " offset=1 gives a notebook's raw JSON." : ""}`,
		);
	}
	if (!view.onPath) {
		lines.push(
			view.callOperator
				? "- `boost` is not on PATH; use the full path above (in `powershell`, after `&`)."
				: "- `boost` is not on PATH; use the full path above.",
		);
	}
	lines.push("- Boost's secret redaction is best effort, not a security boundary.");
	return lines.join("\n");
}

/**
 * Append the awareness block to a whole system prompt: the fallback for a pi
 * whose `before_agent_start` carries no `systemPromptOptions.sections`. Not
 * appended twice when handlers chain.
 */
export function withAwareness(systemPrompt: string, body: string): string {
	return systemPrompt.includes(`<${AWARENESS_SECTION}>`)
		? systemPrompt
		: `${systemPrompt}\n\n<${AWARENESS_SECTION}>\n${body}\n</${AWARENESS_SECTION}>`;
}
