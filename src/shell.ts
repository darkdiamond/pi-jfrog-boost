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
 */
import type { BoostCall } from "./boost-client.ts";
import { isMeaningfulReduction, parseMarker, splitNotices, stripAnsi } from "./content.ts";

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
]);
/** Flags of `env`, `sudo` and `nice` that take a separate argument. */
const FLAGS_WITH_ARGUMENT: Readonly<Record<string, ReadonlySet<string>>> = {
	env: new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
	sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"]),
	nice: new Set(["-n", "--adjustment"]),
};

/** A program name without directory or `.exe`, lower-cased: `C:\bin\Boost.EXE` → `boost`. */
export function programName(word: string): string {
	const base = word.split(/[\\/]/).pop() ?? word;
	return base.toLowerCase().replace(/\.exe$/, "");
}

/**
 * The program a segment runs, after the prefixes that only set up how it
 * runs: `VAR=value` assignments, `export`, `env [-i] [-u NAME] [VAR=…]`,
 * `time`, `command`, `exec`, `nice [-n N]`, `nohup`, `sudo [-u user]`, and
 * PowerShell's `.` (dot-sourcing). Undefined when there is none
 * (`export FOO=1` alone).
 */
export function programOf(segment: string): string | undefined {
	const list = words(segment);
	let i = 0;
	while (i < list.length) {
		const word = list[i] as string;
		if (ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
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
			continue;
		}
		return word;
	}
	return undefined;
}

/** `DISABLE_BOOST=1`, `BOOST_DISABLED=true`: the per-command opt-outs, as a word. */
const OPT_OUT_WORD = /^(?:DISABLE_BOOST|BOOST_DISABLED)=(?:1|true)$/i;
/** PowerShell's form, `$env:DISABLE_BOOST=1` or `$env:BOOST_DISABLED = "true"`. */
const OPT_OUT_POWERSHELL = /\$env:(?:DISABLE_BOOST|BOOST_DISABLED)\s*=\s*(["']?)(?:1|true)\1(?![\w])/i;

/**
 * Whether a shell command's output must reach the model exactly as printed
 * (spec §6.1):
 *
 * - any simple command in it runs `boost` itself — `boost retrieve 147`,
 *   `~/.local/bin/boost retrieve 147`, `"C:\…\boost.exe" read x`,
 *   `env BOOST_DB_PATH=x boost …`, `… | boost`. Compacting a retrieve would
 *   hand back another marker instead of the original, and the awareness text
 *   gives the model the full path when `boost` is not on PATH (our-code 6);
 * - or it sets `DISABLE_BOOST` / `BOOST_DISABLED` to `1` or `true` anywhere:
 *   as a prefix, after `export`, or as PowerShell's `$env:`.
 *
 * Commands that merely mention Boost (`grep -rn boost src`, `cat boost.toml`,
 * `./boosted`) are filtered as usual.
 */
export function bypassesBoost(command: unknown): boolean {
	if (typeof command !== "string" || !command) return false;
	if (OPT_OUT_POWERSHELL.test(command)) return true;
	for (const segment of splitSegments(command)) {
		if (words(segment).some((word) => OPT_OUT_WORD.test(word))) return true;
		const program = programOf(segment);
		if (program !== undefined && programName(program) === "boost") return true;
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
