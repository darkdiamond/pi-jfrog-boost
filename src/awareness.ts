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
 *   gate is on and a shell tool is visible, MCP only when the route can run
 *   and an `mcp__*` tool is visible, documents only when `read` is visible
 *   and the Preview Agreement is accepted. 0.3.0 claimed `read`, `grep`,
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
 *   every surface active.
 */
import { atLeast, type BoostVersion, MCP_MIN_VERSION } from "./boost-binary.ts";
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
}

/** The inputs a view is derived from; gathered by index.ts without spawning. */
export interface AwarenessInputs {
	/** Boost is ready and no off switch is active. */
	ready: boolean;
	/** The `awareness` setting. */
	awareness: boolean;
	/** The shell gate (spec §8.4): Boost's stdin filter will filter shell output. */
	shellOn: boolean;
	settings: { mcp: boolean; mcpExclude: readonly string[]; documents: boolean; notebooks: boolean };
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
	const shellTools = r.shellOn ? SHELL_TOOLS.filter((name) => visible.includes(name)) : [];
	// The route's own static conditions (router.ts / mcp.ts `mcpSkip`): an
	// explicit `boost-mcp-filtering = false`, a Boost before 0.15.3, or every
	// visible MCP tool excluded means no MCP result will ever be shortened.
	const mcpRoute = r.settings.mcp && r.mcpFlag !== false && atLeast(r.boostVersion, MCP_MIN_VERSION);
	const mcp =
		mcpRoute &&
		visible.some((name) => name.startsWith("mcp__") && excludedBy(name, r.settings.mcpExclude) === undefined);
	const documents = visible.includes("read") && r.settings.documents && r.termsAccepted;
	const notebooks = documents && r.settings.notebooks;
	if (shellTools.length === 0 && !mcp && !documents) return undefined;
	return {
		shellTools,
		mcp,
		documents,
		notebooks,
		boostCmd: r.onPath ? "boost" : quoteCommand(r.binary, r.platform),
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
	if (view.shellTools.length > 0) surfaces.push(`${joinList(view.shellTools.map((t) => `\`${t}\``))} output`);
	if (view.mcp) surfaces.push("MCP tool results (`mcp__*`)");
	if (view.documents) surfaces.push("PDF and Office files you `read`");
	if (surfaces.length === 0) return undefined;

	// The §12 template, tightened by a few words per line: verbatim it came
	// to ~1,375 characters with every surface active and Boost off PATH
	// (~1,260 on PATH), over §12's own 1,200 budget. Every instruction and
	// every conditional line is kept; only phrasing went, and the second
	// full `retrieve` command became `(or --lines 40-80)`, so a long
	// absolute path is paid for once.
	const b = view.boostCmd;
	const lines = [
		`JFrog Boost shortens some tool output before you see it: ${joinList(surfaces)}. Everything else, including \`read\` of text files, \`edit\` and \`write\`, is exact.`,
		"- Shortened output is intentional and usually enough; prefer it.",
		`- If a shortened result ends with \`[Boost compressed ~85%. … boost retrieve 147]\` and you need a dropped detail, run \`${b} retrieve <id> --query "<term>"\` (or \`--lines 40-80\`) instead of re-running the tool. Retrieve narrowly: repeated retrieves switch that filter off on this machine for every agent.`,
	];
	if (view.shellTools.length > 0) {
		lines.push(
			"- For one command's exact output, prefix it with `DISABLE_BOOST=1`. Never pipe commands into `boost` yourself. curl/wget pages may arrive as readable text; `DISABLE_BOOST=1 curl …` gives raw HTML.",
		);
	}
	if (view.documents) {
		const nb = view.notebooks;
		lines.push(
			`- PDF and Office files${nb ? ", and notebooks read whole," : ""} that you \`read\` arrive as converted text, paged like any read (use offset to continue). Line numbers are not file lines; never \`edit\` from them.${nb ? " Read a notebook with offset=1 for its raw JSON." : ""}`,
		);
	}
	if (!view.onPath) lines.push("- `boost` is not on PATH; use the full path above.");
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
