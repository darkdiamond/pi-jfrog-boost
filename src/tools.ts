/**
 * Mapping pi's tools onto what Boost understands.
 *
 * Attribution, as measured on Boost v0.15.4 (spec §14):
 *
 *   surface                            span session.agent_type   Boost session list (conversations.tool)
 *   ---------------------------------  ------------------------  ----------------------------------------
 *   stdin filter, `boost read`         pi                        claude_code (Boost does not recognise pi)
 *   `boost hook claude` (MCP)          claude_code               claude_code; mcp_tool_calls.agent_type =
 *                                                                claude_code, no conversation id
 *   `boost hook observe claude` (opt)  pi (earlier spans kept)   claude_code; creates and closes
 *                                                                agent_tool_calls rows
 *   `boost sync`                       unchanged                 unchanged; uploads, then prunes local
 *                                                                rows (≥ 0.13.29)
 *
 * So the agent-neutral surfaces — the stdin filter and `boost read` — carry
 * pi's identity through `BOOST_HOOK_META` into the spans, while Boost's own
 * session list files every pi session under claude_code whatever the
 * surface. `hook opencode` is never used. MCP results go through
 * `hook claude` because it is the only surface that runs Boost's MCP
 * filters.
 *
 * Output is filtered after a tool runs, never streamed through Boost during
 * it, and the executed command is never rewritten (invariant 3): pi bounds
 * tool output before handing it over anyway.
 *
 * Which results are sent at all is decided in router.ts. Reads of text files,
 * `edit`, `write`, `grep`, `find` and `ls` are left exact.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** pi's shell tools: their output is the shell route's input. */
export const SHELLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/**
 * Binary documents pi's `read` returns as raw bytes decoded as UTF-8, which
 * Boost converts to text (spec §5, documents.ts). Not `.csv` (Boost returns
 * a lossy 40-line preview with no retrieve), nor `.rtf`, `.html` and `.htm`,
 * which pi already reads as text — and the model edits from that text.
 */
export const BINARY_DOCS: ReadonlySet<string> = new Set([
	".pdf",
	".docx",
	".xlsx",
	".pptx",
	".odt",
	".ods",
	".odp",
]);

/**
 * Legacy binary Office files: neither pi nor Boost can read them. Boost
 * answers with a one-line `[boost] …` advisory, which documents.ts turns into
 * an error result instead of letting the model puzzle over raw bytes.
 */
export const LEGACY_OFFICE: ReadonlySet<string> = new Set([".doc", ".xls", ".ppt"]);

/** Log files that `readLogs` (opt-in) sends through the stdin filter when read whole. */
export const LOG_EXTENSIONS: ReadonlySet<string> = new Set([".log", ".out"]);

/**
 * Tools that are never routed like a shell, even when `extraTools` names
 * them: `read` of text, `edit` and `write` must reach the model exactly
 * (invariant 1) — the model edits from what it read.
 */
export const NEVER_EXTRA: ReadonlySet<string> = new Set(["read", "edit", "write"]);

export function isShell(toolName: string): boolean {
	return SHELLS.has(toolName);
}

/** The lower-cased extension of a path, `""` when it has none (`.bashrc` has none). */
export function extensionOf(path: unknown): string {
	if (typeof path !== "string") return "";
	const name = path.split(/[\\/]/).pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** pi's `UNICODE_SPACES` (pi/dist/utils/paths.js): spaces a model may type that the file name does not have. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * pi's `normalizeWindowsShellPath` (pi/dist/utils/paths.js): a Git Bash,
 * MSYS, Cygwin or WSL drive path (`/c/Users/x`, `/mnt/c/x`,
 * `/cygdrive/c/x`) in the form native Windows APIs accept. Applied on win32
 * only, as pi does; anything else is returned unchanged.
 */
export function normalizeWindowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return path;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${(match[1] as string).toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * The absolute path pi's `read` opens for `path`, resolved the way pi 1.2.0
 * does without importing it (`resolveToCwd` in
 * pi/dist/core/tools/path-utils.js, which calls `normalizePath` in
 * pi/dist/utils/paths.js with `normalizeUnicodeSpaces` and `stripAtPrefix`):
 *
 *   1. Unicode spaces (NBSP, the U+2000 range, narrow NBSP, …) become ` `
 *   2. one leading `@` is stripped
 *   3. on win32 only, an MSYS/WSL drive path becomes `C:\…`
 *   4. `~` and `~/` expand to the home directory; `~\` too, on win32 only —
 *      elsewhere `~\a.pdf` is a relative file name, and expanding it would
 *      stat (and convert) a different file from the one pi read
 *   5. a `file://` URL becomes its path
 *   6. resolved against the session's working directory
 *
 * pi then tries a few look-alike names when this one does not exist; see
 * {@link readPathCandidates}. `platform` is injectable for tests.
 */
export function resolveReadPath(
	path: string,
	cwd: string,
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	let p = path.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (platform === "win32") p = normalizeWindowsShellPath(p);
	if (p === "~") p = home;
	else if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) p = join(home, p.slice(2));
	else if (/^file:\/\//.test(p)) {
		try {
			p = fileURLToPath(p);
		} catch {
			/* pi would throw here and refuse the read; the stat that follows fails the same way */
		}
	}
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * The paths pi's `read` tries, in its order, when the resolved one does not
 * exist (`resolveReadPath` in pi/dist/core/tools/path-utils.js): macOS
 * screenshot names with a narrow no-break space before AM/PM, the NFD form
 * macOS stores names in, a curly apostrophe (U+2019) for a straight one, and
 * NFD with the curly apostrophe. pi opens the first that exists, so the
 * caller stats these in order and takes the first hit — the same file pi
 * read. Duplicates are dropped.
 */
export function readPathCandidates(abs: string): string[] {
	const nfd = abs.normalize("NFD");
	const curly = (p: string) => p.replace(/'/g, "\u2019");
	const all = [abs, abs.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(abs), curly(nfd)];
	return [...new Set(all)];
}

/** Quote an argument for a POSIX shell command line when it needs it. */
export function shellQuote(value: string): string {
	return /^[\w./@=:+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell command a tool call is equivalent to, for `BOOST_HOOK_META`.
 *
 * On v0.15.4 the stdin filter picks its filter from the output itself and
 * mostly ignores `tool_input` (boost-surfaces 5), so this is kept for
 * attribution and for filters that do key on the command:
 * - a shell tool, or an `extraTools` tool with a `command`: that command;
 * - a whole `read` of a log (`readLogs`): `cat <abs>`, the way Boost's own
 *   integrations describe a file read.
 * Undefined for anything else.
 */
export function equivalentCommand(
	toolName: string,
	input: Readonly<Record<string, unknown>>,
	absPath?: string,
): string | undefined {
	if (toolName === "read") return absPath ? `cat ${shellQuote(absPath)}` : undefined;
	return typeof input.command === "string" ? input.command : undefined;
}
