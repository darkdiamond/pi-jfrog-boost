/**
 * Mapping pi's tools onto what Boost understands.
 *
 * Boost has no pi agent type. Its `hook <agent>` dialects stamp every span with
 * the agent named by the subcommand — `boost hook claude` rewrites `agent_type`
 * to `claude_code` even when the payload says otherwise — so using one would
 * file pi's sessions under Claude Code and corrupt `boost report`. The
 * agent-neutral surfaces honour the `agent_type` in `BOOST_HOOK_META`, so this
 * integration uses only those: the stdin filter and `boost read`.
 *
 * That means output is filtered after a tool runs rather than streamed through
 * Boost during it. It is the same trade-off Boost's own OpenCode plugin makes
 * on Windows, and pi bounds tool output before handing it to us anyway.
 *
 * `edit` and `write` return diffs pi already summarises, and are left alone.
 */

/** pi tools whose output is worth piping through Boost. */
const FILTERED: ReadonlySet<string> = new Set(["bash", "powershell", "read", "grep", "find", "ls"]);

/**
 * Files Boost can convert to Markdown. pi's `read` rejects most of these as
 * binary, so a failed read is the signal to try `boost read` instead.
 */
const DOCUMENTS: ReadonlySet<string> = new Set([
	".csv",
	".doc",
	".docx",
	".htm",
	".html",
	".odp",
	".ods",
	".odt",
	".pdf",
	".ppt",
	".pptx",
	".rtf",
	".xls",
	".xlsx",
]);

export function isFiltered(toolName: string): boolean {
	return FILTERED.has(toolName);
}

/** Whether Boost might extract more from this path than pi's `read` can. */
export function isDocument(path: unknown): path is string {
	if (typeof path !== "string") return false;
	const dot = path.lastIndexOf(".");
	return dot > 0 && DOCUMENTS.has(path.slice(dot).toLowerCase());
}

function arg(value: unknown, fallback = "."): string {
	if (typeof value !== "string" || !value) return fallback;
	return /^[\w./@=:+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell command a pi tool call is equivalent to.
 *
 * Boost's filters are keyed on commands, not tool names, so the stdin filter
 * has to be told which one produced the output it is reading — the same trick
 * Boost's OpenCode plugin uses when it filters `read` results as `cat <path>`.
 * Returns undefined for tools with no equivalent.
 */
export function equivalentCommand(
	toolName: string,
	input: Readonly<Record<string, unknown>>,
): string | undefined {
	switch (toolName) {
		case "bash":
		case "powershell":
			return typeof input.command === "string" ? input.command : undefined;
		case "read":
			return `cat ${arg(input.path)}`;
		case "ls":
			return `ls -la ${arg(input.path)}`;
		case "find":
			return `find ${arg(input.path)} -name ${arg(input.pattern, "*")}`;
		case "grep":
			return `grep -rn ${arg(input.pattern, "")} ${arg(input.path)}`;
		default:
			return undefined;
	}
}
