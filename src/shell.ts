/**
 * The shell route (spec §6): which shell commands must reach the model
 * exactly as printed, and how a shell result is sent through Boost's stdin
 * filter and put back.
 *
 * pi's shell runs in its own process, so a `DISABLE_BOOST=1` written in the
 * command never reaches this extension's environment, and Boost — which only
 * sees the output on stdin — never sees it either. The command text is all
 * there is, so it is parsed here, generously: a false positive only costs one
 * result its compaction, while a false negative compacts output the model
 * explicitly asked to see whole, or re-compacts a `boost retrieve`, which
 * hands back another marker instead of the original.
 *
 * The filter call itself (§6.2) keeps pi's notices out of Boost's sight,
 * strips terminal escapes from what Boost reads, and only accepts a reply
 * that is a meaningful reduction. A reply that is not leaves the tool's
 * original bytes — escapes and all — untouched (invariant 1).
 *
 * When pi truncated the output, the full-output re-filter (§6.3) sends the
 * whole run pi saved to its temp file instead of the tail pi kept, so the
 * early failures pi's tail cut off reach the model — without changing what
 * was executed.
 */
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, sep } from "node:path";
import type { BoostCall } from "./boost-client.ts";
import {
	isMeaningfulReduction,
	isPlainObject,
	looksLikeHtmlDocument,
	parseMarker,
	splitNotices,
	stripAnsi,
} from "./content.ts";
import { PI_MAX_BYTES, PI_MAX_LINES } from "./documents.ts";

// ---------------------------------------------------------------------------
// Command parsing

/**
 * Split a command line into the simple commands it runs: on `;`, `&&`, `||`,
 * `|`, `&`, `(`, `)` and newlines, outside quotes. PowerShell's call operator
 * `& 'C:\…\boost.exe' retrieve 1` splits on its `&` too, which leaves the
 * quoted program at the front of a segment, where it belongs.
 */
export function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			else if (quote === '"' && char === "\\" && i + 1 < command.length) current += command[++i];
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
		} else if (";&|()\n\r".includes(char)) {
			segments.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	segments.push(current);
	return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * A segment's words with quotes removed: `"$HOME/.local/bin/boost"` becomes
 * `$HOME/.local/bin/boost`. Backslashes outside quotes are kept literally —
 * they are Windows path separators far more often than POSIX escapes here.
 */
export function words(segment: string): string[] {
	const out: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i] as string;
		if (quote) {
			if (char === quote) quote = undefined;
			else if (quote === '"' && char === "\\" && (segment[i + 1] === '"' || segment[i + 1] === "\\")) {
				current += segment[++i];
			} else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (char === " " || char === "\t") {
			if (started) out.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (started) out.push(current);
	return out;
}

/** `NAME=value`: an assignment prefix (`FOO=1 cmd`), or an `export`/`env` argument. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Wrappers that run the command after them; their own flags are skipped too. */
const PLAIN_WRAPPERS: ReadonlySet<string> = new Set([
	"time",
	"command",
	"exec",
	"nohup",
	"export",
	"builtin",
	"xargs",
	"stdbuf",
	"ionice",
]);
/** Flags of the wrappers that take a separate argument (`sudo -u root`, `xargs -n 1`). */
const FLAGS_WITH_ARGUMENT: Readonly<Record<string, ReadonlySet<string>>> = {
	env: new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
	sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
	nice: new Set(["-n", "--adjustment"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	// Not `-i`, `-l` or `-e`: in GNU xargs their argument is optional and attached.
	xargs: new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
};
/** Wrappers with positional arguments before the command: `timeout 30 make`. */
const POSITIONAL_ARGUMENTS: Readonly<Record<string, number>> = { timeout: 1 };
/**
 * Shell reserved words that come before a command in the same segment:
 * `do boost retrieve $i`, `if boost …`, `then …`, `{ boost …`, `! boost …`.
 * Unlike wrappers they take no flags of their own.
 */
const RESERVED_PREFIXES: ReadonlySet<string> = new Set([
	"if",
	"then",
	"elif",
	"else",
	"do",
	"while",
	"until",
	"!",
	"{",
]);
/** Reserved words that close a compound command and run nothing: `}`, `fi`, `done`, `esac`. */
const RESERVED_CLOSERS: ReadonlySet<string> = new Set(["}", "fi", "done", "esac"]);

/** A program name without directory or `.exe`, lower-cased: `C:\bin\Boost.EXE` → `boost`. */
export function programName(word: string): string {
	const base = word.split(/[\\/]/).pop() ?? word;
	return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * A segment's words from the program it runs onwards, after the prefixes that
 * only set up how it runs: `VAR=value` assignments, `export`,
 * `env [-i] [-u NAME] [VAR=…]`, `time`, `command`, `exec`, `nice [-n N]`,
 * `nohup`, `sudo [-u user]`, `timeout [-s SIG] DURATION`, `xargs [-n N]`,
 * `stdbuf -oL`, `ionice -c N`, PowerShell's `.` (dot-sourcing), and the
 * shell's reserved words (`if`, `then`, `do`, `while`, `!`, `{`…). Empty
 * when there is no program (`export FOO=1` alone, `done`, `}`).
 */
export function commandWords(segment: string): string[] {
	const list = words(segment);
	let i = 0;
	while (i < list.length) {
		const word = list[i] as string;
		if (ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (RESERVED_PREFIXES.has(word)) {
			i++;
			continue;
		}
		if (RESERVED_CLOSERS.has(word)) return [];
		const lower = word.toLowerCase();
		const withArgs = FLAGS_WITH_ARGUMENT[lower];
		if (PLAIN_WRAPPERS.has(lower) || withArgs || lower === ".") {
			i++;
			// The wrapper's own options: `env -i`, `sudo -u root`, `nice -n 10`, `time -p`.
			while (i < list.length && (list[i] as string).startsWith("-")) {
				const flag = list[i] as string;
				i += withArgs?.has(flag) ? 2 : 1;
				if (flag === "--") break;
			}
			i += POSITIONAL_ARGUMENTS[lower] ?? 0;
			continue;
		}
		return list.slice(i);
	}
	return [];
}

/** The program a segment runs (see {@link commandWords}), or undefined when there is none. */
export function programOf(segment: string): string | undefined {
	return commandWords(segment)[0];
}

/** `DISABLE_BOOST=1`, `BOOST_DISABLED=true`: the per-command opt-outs, as a word. */
const OPT_OUT_WORD = /^(?:DISABLE_BOOST|BOOST_DISABLED)=(?:1|true)$/i;
/** PowerShell's form, `$env:DISABLE_BOOST=1` or `$env:BOOST_DISABLED = "true"`. */
const OPT_OUT_POWERSHELL = /\$env:(?:DISABLE_BOOST|BOOST_DISABLED)\s*=\s*(["']?)(?:1|true)\1(?![\w])/i;

/** POSIX shells whose `-c` argument is a script: `bash -c 'boost retrieve 3'`, `sh -ec "…"`. */
const POSIX_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Shells that run the rest of their arguments as a command: `pwsh -Command …`, `cmd /c …`. */
const REST_SHELLS: ReadonlySet<string> = new Set(["pwsh", "powershell", "cmd"]);
/** How deep scripts inside scripts are followed; real commands nest once or twice. */
const MAX_NESTING = 4;

/**
 * The commands a segment hands to another shell, as text to parse again:
 * the script after `bash -c` (or `-lc`, `-ec`…), everything after
 * PowerShell's `-c`/`-Command` or cmd's `/c`, or the arguments of `eval`.
 */
function innerScripts(argv: readonly string[]): string[] {
	const program = programName(argv[0] ?? "");
	if (program === "eval") return argv.length > 1 ? [argv.slice(1).join(" ")] : [];
	if (POSIX_SHELLS.has(program)) {
		const at = argv.findIndex((word, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
		return at > 0 && at + 1 < argv.length ? [argv[at + 1] as string] : [];
	}
	if (REST_SHELLS.has(program)) {
		const at = argv.findIndex((word, i) => i > 0 && /^(?:-c|-command|\/c|\/k)$/i.test(word));
		return at > 0 ? [argv.slice(at + 1).join(" ")] : [];
	}
	return [];
}

/**
 * The bodies of command substitutions — `$(…)` and backticks — anywhere in
 * the command, double quotes included: `echo "$(boost retrieve 3)"` runs
 * boost even though the operators are quoted. Innermost `$(…)` first; single
 * quotes are not honoured, which at worst makes a quoted `'$(boost …)'` a
 * harmless false positive.
 */
function substitutions(command: string): string[] {
	const bodies: string[] = [];
	for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
		const body = match[1] ?? match[2];
		if (body?.trim()) bodies.push(body);
	}
	return bodies;
}

/**
 * Whether a shell command's output must reach the model exactly as printed
 * (spec §6.1):
 *
 * - any simple command in it runs `boost` itself — `boost retrieve 147`,
 *   `~/.local/bin/boost retrieve 147`, `"C:\…\boost.exe" read x`,
 *   `env BOOST_DB_PATH=x boost …`, `… | boost`, `timeout 30 boost …`,
 *   `bash -c 'boost …'`, `echo "$(boost …)"`. Compacting a retrieve would
 *   hand back another marker instead of the original, and the awareness text
 *   gives the model the full path when `boost` is not on PATH (our-code 6);
 * - or it sets `DISABLE_BOOST` / `BOOST_DISABLED` to `1` or `true` anywhere:
 *   as a prefix, after `export`, or as PowerShell's `$env:`.
 *
 * Commands that merely mention Boost (`grep -rn boost src`, `cat boost.toml`,
 * `./boosted`) are filtered as usual.
 */
export function bypassesBoost(command: unknown, depth = 0): boolean {
	if (typeof command !== "string" || !command) return false;
	if (OPT_OUT_POWERSHELL.test(command)) return true;
	const nested = depth < MAX_NESTING;
	if (nested && substitutions(command).some((body) => bypassesBoost(body, depth + 1))) return true;
	for (const segment of splitSegments(command)) {
		if (words(segment).some((word) => OPT_OUT_WORD.test(word))) return true;
		const argv = commandWords(segment);
		if (argv.length === 0) continue;
		if (programName(argv[0] as string) === "boost") return true;
		if (nested && innerScripts(argv).some((script) => bypassesBoost(script, depth + 1))) return true;
	}
	return false;
}

/** Programs whose output is a fetched web page (curl, wget, HTTPie, xh, PowerShell's cmdlets). */
const WEB_FETCHERS: ReadonlySet<string> = new Set([
	"curl",
	"wget",
	"http",
	"https",
	"xh",
	"invoke-webrequest",
	"iwr",
	"invoke-restmethod",
	"irm",
]);

/**
 * Whether the command fetches from the web. A whole HTML page in its output
 * is then the page the model asked for, and Boost turning it into readable
 * text is the point (boost-integrations 10); anywhere else, an HTML document
 * in shell output is a file the model is about to edit, and is left exact.
 */
export function isWebFetch(command: unknown): boolean {
	if (typeof command !== "string" || !command) return false;
	return splitSegments(command).some((segment) => {
		const program = programOf(segment);
		return program !== undefined && WEB_FETCHERS.has(programName(program));
	});
}

// ---------------------------------------------------------------------------
// The filter call (spec §6.2)

/** What a compaction Boost's reply produced, when it was worth applying. */
export interface Compaction {
	/** The new text: Boost's reply, then pi's notices verbatim. */
	text: string;
	/** Characters of the tool's text before, and of the new text after. */
	before: number;
	after: number;
	/** The id in Boost's trailing marker, when it added one. */
	retrieveId?: number;
	/** Built from pi's full-output file rather than the tail pi kept (§6.3). */
	full?: true;
}

export interface CompactOutcome {
	/** The call, for counting errors; absent when nothing was sent. */
	call?: BoostCall;
	/** Set only when the reply is worth applying. */
	compaction?: Compaction;
}

/**
 * Send a shell (or log) result's body through Boost and decide whether to use
 * the reply.
 *
 * 1. pi's trailing notices are split off: Boost never sees them, and they are
 *    put back verbatim, so `Command exited with code 3` and the
 *    `Full output:` path survive whatever the filter keeps.
 * 2. Boost gets the body without terminal escapes.
 * 3. The reply is used only when it is a meaningful reduction of what Boost
 *    was given. Otherwise the tool's original text stands, byte for byte —
 *    escapes included, because "Boost could not shorten this" must not
 *    change what the model sees.
 */
export async function compactShellOutput(
	text: string,
	filter: (body: string) => Promise<BoostCall>,
): Promise<CompactOutcome> {
	const { body, notices } = splitNotices(text);
	const stripped = stripAnsi(body);
	if (!stripped.trim()) return {};
	const call = await filter(stripped);
	if (call.code !== 0 || call.skipped || !isMeaningfulReduction(stripped, call.stdout)) return { call };
	const reply = call.stdout.trimEnd();
	const replacement = `${reply}${notices}`;
	const marker = parseMarker(reply);
	return {
		call,
		compaction: {
			text: replacement,
			before: text.length,
			after: replacement.length,
			...(marker ? { retrieveId: marker.id } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// The full-output re-filter (spec §6.3)

/**
 * The largest full-output file read (spec §8.5): twice the 1 MiB every other
 * route sends. A test run long enough for pi to truncate is exactly the
 * output this route exists for, and a run that printed more than 2 MiB is
 * left to the tail route rather than costing a 10 s filter call.
 */
export const FULL_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The full-output file a shell result names, from where pi records it:
 * `structuredContent.full_output_path` (pi 1.x's bash output schema) or
 * `details.fullOutputPath` (bash and powershell on every supported pi,
 * 0.86.1 included). Undefined when neither holds a non-empty string.
 */
export function fullOutputPathOf(structuredContent: unknown, details: unknown): string | undefined {
	const sources: [unknown, string][] = [
		[structuredContent, "full_output_path"],
		[details, "fullOutputPath"],
	];
	for (const [source, key] of sources) {
		const path = isPlainObject(source) ? source[key] : undefined;
		if (typeof path === "string" && path) return path;
	}
	return undefined;
}

/**
 * The notice in `notices` (as {@link splitNotices} returns them) through
 * which pi told the model it truncated the output and where the rest is:
 * `[Showing lines 7001-9000 of 9000. Full output: <path>]` and its byte-limit
 * and partial-line variants. Its index among the "\n\n"-separated notices,
 * or -1 when there is none naming exactly `path`.
 *
 * The path has to be the one the tool recorded. A result whose `details`
 * point at one file while its text names another (or none: an `extraTools`
 * tool that merely has a `fullOutputPath` field) is not pi's truncation, and
 * keeps the tail route.
 */
export function fullOutputNoticeIndex(notices: string, path: string): number {
	return notices
		.split("\n\n")
		.findIndex((notice) => notice.startsWith("[") && notice.endsWith(`Full output: ${path}]`));
}

export interface FullOutputFileDeps {
	/** Where pi writes its full-output files; defaults to `os.tmpdir()`, read per call. */
	tmpdir?: () => string;
	readFile?: (path: string) => Promise<string>;
	realpath?: (path: string) => string;
	stat?: (path: string) => { isFile(): boolean; size: number; uid?: number };
	/** The current user's id, or undefined where there is none (Windows); defaults to `process.getuid`. */
	uid?: () => number | undefined;
}

/**
 * The text of a full-output file, or undefined when it must not be read.
 * The path comes from the result's `details` or `structuredContent`, which
 * the tool fills — and an `extraTools` tool is anyone's code — while what is
 * read goes to Boost (whose DB keeps it and whose sync uploads it) and
 * replaces the result. So it is read only when, after resolving links, it is:
 *
 *   - an absolute path inside the temp directory pi writes to (pi's
 *     `createOutputFilePath` joins `os.tmpdir()`); never anywhere else;
 *   - a regular file owned by this user (pi creates it 0600), where the
 *     platform has user ids;
 *   - no larger than {@link FULL_OUTPUT_MAX_BYTES};
 *   - text: a NUL means binary on stdout, which Boost does not filter.
 *
 * Never throws: a file that vanished, a dangling link or an unreadable
 * temp directory is simply not used.
 */
export async function readFullOutputFile(
	path: string,
	deps: FullOutputFileDeps = {},
): Promise<string | undefined> {
	const realpath = deps.realpath ?? realpathSync;
	const stat = deps.stat ?? statSync;
	const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
	try {
		if (!isAbsolute(path)) return undefined;
		const root = realpath((deps.tmpdir ?? tmpdir)());
		const real = realpath(path);
		if (!real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return undefined;
		const info = stat(real);
		if (!info.isFile() || info.size > FULL_OUTPUT_MAX_BYTES) return undefined;
		const me = (deps.uid ?? (() => process.getuid?.()))();
		if (me !== undefined && info.uid !== undefined && info.uid !== me) return undefined;
		const text = await read(real);
		// Checked on what was read too: the file may have grown since the stat.
		if (Buffer.byteLength(text) > FULL_OUTPUT_MAX_BYTES || text.includes("\0")) return undefined;
		return text;
	} catch {
		return undefined;
	}
}

/** Lines in `text` as pi counts a run's output: a final newline ends the last line, it does not start one. */
function lineCount(text: string): number {
	if (!text) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/** Whether `text` fits the page pi's own truncation leaves the model: 2000 lines and 50 KiB. */
function fitsPiPage(text: string): boolean {
	return lineCount(text) <= PI_MAX_LINES && Buffer.byteLength(text) <= PI_MAX_BYTES;
}

export interface FullOutcome extends CompactOutcome {
	/**
	 * Why the full output was not used and the tail route ran instead:
	 * `unreadable` when the file failed the checks of
	 * {@link readFullOutputFile} (or the result names no such file), `html`
	 * when the run is a whole HTML page the router would have kept exact,
	 * `unfit` when Boost answered but its version of the whole run was no
	 * meaningful reduction or would not fit pi's page.
	 */
	fullSkipped?: "unreadable" | "html" | "unfit";
}

export interface FullOutputRequest {
	/** The result's text: pi's tail and its notices. */
	text: string;
	/** The full-output file the result names ({@link fullOutputPathOf}). */
	path: string;
	/**
	 * Whether a whole HTML page may go to Boost: the router's `html` rule
	 * judges pi's tail, which is the end of a page, not its `<!doctype>`.
	 */
	htmlAllowed: boolean;
}

/**
 * The full-output re-filter (spec §6.3): pi truncated a shell result to its
 * last 2000 lines or 50 KiB and saved the whole run to a temp file. A test
 * run's failures are usually at the top or in the middle, so the tail the
 * model got is mostly passing tests; Boost given the whole run keeps the
 * failures and drops the passes.
 *
 * 1. The file is read under the guards of {@link readFullOutputFile},
 *    stripped of terminal escapes, and filtered.
 * 2. The reply is used only when it is a meaningful reduction of the whole
 *    run and fits pi's own page, so the model never gets more than pi would
 *    have given it. pi's `Full output:` notice is then rewritten to say what
 *    happened — `[Boost compacted the full 9000-line output. Full output: <path>]`
 *    — and pi's other notices (the exit status) stay as they were.
 * 3. Anything else falls back to the tail route (§6.2) in the same call:
 *    an unusable file, an HTML page, or a reply that is too long or saves
 *    too little. When the call itself failed — refused (busy, paused),
 *    timed out, killed, exited non-zero — the original result stands
 *    instead: a second call would meet the same Boost, and invariant 2
 *    says a slow Boost is not waited on twice.
 *
 * Cost. The whole run is filtered at about 3 ms per KiB (measured on Boost
 * v0.15.4: 78 KB in 0.41 s, 848 KB in 2.6 s, 1.68 MB in 4.9 s), so a file
 * near the 2 MiB ceiling takes ~6 s against the 10 s timeout cap of §8.5.
 * A slower machine can time out there; that counts as a bad call for the
 * breaker and keeps pi's tail unfiltered — the fail-open outcome, at the
 * price of the wait.
 *
 * The `unfit` fallback makes a second call in a row: the result waits on
 * both, and Boost records two filter invocations, so its own DB and report
 * show two entries (and two savings) for one command. That is accepted
 * because the second call is cheap — pi's tail is at most 50 KiB, a few
 * hundred milliseconds — and it is what the model would have got from the
 * tail route anyway; skipping it would leave the result unfiltered for a
 * reply that merely did not fit. The extension's own stats record the
 * command as one `full-unfit` skip plus the tail's own outcome.
 *
 * Never throws for the file's or Boost's sake.
 */
export async function compactFullOutput(
	request: FullOutputRequest,
	filter: (body: string) => Promise<BoostCall>,
	deps: FullOutputFileDeps = {},
): Promise<FullOutcome> {
	const { text, path } = request;
	// On `unfit` the full call is not returned: it ran to completion and
	// exited 0 (anything else returned above), so it has no refusal or error
	// to count, and `fullSkipped` already says why its reply went unused —
	// counting it again as `unchanged` would report one run twice. Its
	// duration still reached the breaker inside the client.
	const tail = async (fullSkipped: NonNullable<FullOutcome["fullSkipped"]>) => ({
		...(await compactShellOutput(text, filter)),
		fullSkipped,
	});
	const { notices } = splitNotices(text);
	const parts = notices.split("\n\n");
	const at = fullOutputNoticeIndex(notices, path);
	if (at < 0) return tail("unreadable");
	const full = await readFullOutputFile(path, deps);
	const stripped = full === undefined ? "" : stripAnsi(full);
	if (!stripped.trim()) return tail("unreadable");
	if (!request.htmlAllowed && looksLikeHtmlDocument(stripped)) return tail("html");
	const call = await filter(stripped);
	if (call.code !== 0 || call.skipped || call.timedOut || call.aborted) return { call };
	const reply = call.stdout.trimEnd();
	if (!isMeaningfulReduction(stripped, reply) || !fitsPiPage(reply)) return tail("unfit");
	parts[at] = `[Boost compacted the full ${lineCount(stripped)}-line output. Full output: ${path}]`;
	const replacement = `${reply}${parts.join("\n\n")}`;
	const marker = parseMarker(reply);
	return {
		call,
		compaction: {
			text: replacement,
			before: text.length,
			after: replacement.length,
			...(marker ? { retrieveId: marker.id } : {}),
			full: true,
		},
	};
}
