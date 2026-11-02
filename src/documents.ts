/**
 * The document route (spec §7.1): PDF, Office and OpenDocument files that
 * pi's `read` returns as raw bytes, legacy Office files nobody can convert,
 * and large notebooks read whole — turned into text by `boost read` and paged
 * exactly the way pi pages a text file.
 *
 * pi's `read` only special-cases images. Any other file is decoded as UTF-8,
 * so a PDF reaches the model as NULs and replacement characters (0.3.0
 * learned this the hard way: it assumed an error). Boost's `read` converts
 * the file to text, which this module then treats as if it were the file:
 *
 *   resolve     the path pi opened, normalised as pi normalises it (tools.ts)
 *               and with pi's look-alike fallbacks, required to be a regular
 *               file
 *   check       the file really is the format its extension claims (its magic
 *               number), so a text file that happens to be called `a.pdf`
 *               stays exact; a notebook must be ≥ 16 KiB
 *   terms       only then: without Boost's Preview Agreement nothing is
 *               spawned, and the read is skipped as `terms`
 *   convert     `boost read -- <abs>`, 20 s, 16 MiB stdout cap (client)
 *   validate    anything that is not plain text fails open: a non-zero exit,
 *               empty output, NUL, a binary magic number, Boost's `image …`
 *               answer for pictures, an `[boost] …` advisory, or text that
 *               looks binary
 *   cache       the text, keyed by (abs, mtimeMs, size), so paging through a
 *               document with `offset` converts it once
 *   slice       pi's own algorithm and notices, byte for byte, so `offset`
 *               and `limit` mean what they mean for any other read
 *
 * Legacy `.doc`, `.xls` and `.ppt` are never converted: Boost answers with a
 * one-line `[boost] …` advisory, which becomes an error result saying so. If
 * Boost does not answer, pi's result passes through as it was.
 *
 * Everything here fails open: a result this module cannot stand behind is a
 * `skip`, and the caller keeps pi's result unchanged.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { BoostCall } from "./boost-client.ts";
import { looksBinary } from "./content.ts";
import {
	BINARY_DOCS,
	extensionOf,
	LEGACY_OFFICE,
	readPathCandidates,
	resolveReadPath,
	shellQuote,
} from "./tools.ts";

// ---------------------------------------------------------------------------
// pi's read, reproduced

/**
 * pi's page size for `read`: whichever of 2000 lines or 50 KiB is hit first.
 * Hard-coded rather than imported — every import from pi stays type-only, so
 * the extension loads into any pi release — from `DEFAULT_MAX_LINES` and
 * `DEFAULT_MAX_BYTES` in pi/dist/core/tools/truncate.js (unchanged from
 * 0.86.1 to 1.2.0). If pi ever changes them, converted pages differ from text
 * pages in size only; the notices still tell the model how to continue.
 */
export const PI_MAX_LINES = 2000;
export const PI_MAX_BYTES = 50 * 1024;

/** pi's `formatSize` (truncate.js), so a notice's `50.0KB` reads exactly like pi's. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** One page of a text, as pi's `read` would return it. */
export type Slice =
	| {
			kind: "page";
			/** The selected lines, without the notice. */
			page: string;
			/** pi's continuation notice (with its leading blank line), or "". */
			notice: string;
			/** First and last line shown (1-based), and the text's line count, as pi counts them. */
			lines: [number, number, number];
			/**
			 * pi's `details.truncation` for this page, when pi's read would set
			 * one (the page was cut at 2000 lines or 50 KiB, or its first line is
			 * too long), so pi's renderer warns about this text rather than about
			 * the raw bytes pi read.
			 */
			truncation?: PiTruncation;
	  }
	| { kind: "error"; message: string };

/**
 * pi's `read` on `text` as if it were the file's contents, byte for byte
 * (pi 1.2.0 `dist/core/tools/read.js`, the text branch, and `truncateHead`
 * in truncate.js). Every quirk is kept, because the model pages a converted
 * document with the same `offset`/`limit` arithmetic it uses everywhere else:
 *
 * - The text is split on `\n` and every piece counts, so a trailing newline
 *   adds an empty last line to the "of N" total, as it does for pi.
 * - `offset` is 1-based; 0, absent or negative start at the top (pi's
 *   `offset ? Math.max(0, offset - 1) : 0`). Past the end is an error.
 * - Whole lines only. The page stops at 2000 lines or 50 KiB, whichever
 *   comes first, and a user `limit` that ends early gets the "N more lines"
 *   notice instead.
 *
 * One branch differs: when a single line is over 50 KiB, pi points the model
 * at `sed -n 'Np' <path>` — but here the path is the binary file, whose line
 * N is not this text's line N. The notice keeps pi's wording and points at
 * `boost read` piped into the same `sed`, which does print the right line.
 */
export function sliceLikePiRead(
	text: string,
	offset: number | undefined,
	limit: number | undefined,
	abs: string,
): Slice {
	const allLines = text.split("\n");
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (startLine >= allLines.length) {
		return {
			kind: "error",
			message: `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
		};
	}
	let selected: string;
	let userLimitedLines: number | undefined;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, allLines.length);
		selected = allLines.slice(startLine, endLine).join("\n");
		userLimitedLines = endLine - startLine;
	} else {
		selected = allLines.slice(startLine).join("\n");
	}
	const truncation = truncateHead(selected);
	if (truncation.firstLineExceedsLimit) {
		const size = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
		return {
			kind: "page",
			page: "",
			truncation: piTruncation(truncation),
			notice: `[Line ${startLineDisplay} is ${size}, exceeds ${formatSize(PI_MAX_BYTES)} limit. Use bash: boost read -- ${shellQuote(abs)} | sed -n '${startLineDisplay}p' | head -c ${PI_MAX_BYTES}]`,
			lines: [startLineDisplay, startLineDisplay, totalFileLines],
		};
	}
	if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const notice =
			truncation.truncatedBy === "lines"
				? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
				: `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(PI_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		return {
			kind: "page",
			page: truncation.content,
			notice,
			lines: [startLineDisplay, endLineDisplay, totalFileLines],
			truncation: piTruncation(truncation),
		};
	}
	if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		return {
			kind: "page",
			page: truncation.content,
			notice: `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`,
			lines: [startLineDisplay, startLine + userLimitedLines, totalFileLines],
		};
	}
	const end = userLimitedLines !== undefined ? startLine + userLimitedLines : totalFileLines;
	return {
		kind: "page",
		page: truncation.content,
		notice: "",
		lines: [startLineDisplay, end, totalFileLines],
	};
}

/**
 * The numbers pi's `read` puts in `details.truncation` (pi's
 * `TruncationResult` from truncate.js without its `content`, which would
 * duplicate the page in the session file). pi's read renderer
 * (pi/dist/core/tools/renderers/read.js) turns them into the
 * `[Truncated: …]` / `[First line exceeds …]` warning under the result.
 */
export interface PiTruncation {
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

interface Truncation extends PiTruncation {
	content: string;
}

const piTruncation = ({ content: _content, ...numbers }: Truncation): PiTruncation => numbers;

/**
 * pi's `splitLinesForCounting` (truncate.js): a trailing newline ends the
 * last line rather than starting one, and "" has no lines.
 */
export function splitLinesForCounting(text: string): string[] {
	const lines = text.length === 0 ? [] : text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

/** pi's `truncateHead` (truncate.js) with its default limits, field for field. */
function truncateHead(content: string): Truncation {
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	const limits = {
		totalLines,
		totalBytes,
		lastLinePartial: false,
		maxLines: PI_MAX_LINES,
		maxBytes: PI_MAX_BYTES,
	};
	if (lines.length <= PI_MAX_LINES && totalBytes <= PI_MAX_BYTES) {
		return {
			...limits,
			content,
			truncated: false,
			truncatedBy: null,
			outputLines: totalLines,
			outputBytes: totalBytes,
			firstLineExceedsLimit: false,
		};
	}
	if (Buffer.byteLength(lines[0] ?? "", "utf-8") > PI_MAX_BYTES) {
		return {
			...limits,
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 0,
			outputBytes: 0,
			firstLineExceedsLimit: true,
		};
	}
	const out: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < PI_MAX_LINES; i++) {
		const line = lines[i] as string;
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
		if (bytes + lineBytes > PI_MAX_BYTES) {
			truncatedBy = "bytes";
			break;
		}
		out.push(line);
		bytes += lineBytes;
	}
	if (out.length >= PI_MAX_LINES && bytes <= PI_MAX_BYTES) truncatedBy = "lines";
	const page = out.join("\n");
	return {
		...limits,
		content: page,
		truncated: true,
		truncatedBy,
		outputLines: out.length,
		outputBytes: Buffer.byteLength(page, "utf-8"),
		firstLineExceedsLimit: false,
	};
}

/**
 * pi's error for an `offset` past the end of the file, as its `read` throws
 * it (and pi reports the message as the error result's text).
 */
export const PI_OFFSET_ERROR = /^Offset -?[\d.e+]+ is beyond end of file \(\d+ lines total\)$/;

// ---------------------------------------------------------------------------
// What gets converted

/** Smallest notebook worth converting: below this, its raw JSON is cheap enough (spec §5). */
export const NOTEBOOK_MIN_BYTES = 16 * 1024;

export type DocumentMode = "binary" | "legacy" | "notebook";

/** How a read of `path` is handled, by extension; undefined when it is not a document. */
export function documentMode(path: unknown): DocumentMode | undefined {
	const ext = extensionOf(path);
	if (BINARY_DOCS.has(ext)) return "binary";
	if (LEGACY_OFFICE.has(ext)) return "legacy";
	if (ext === ".ipynb") return "notebook";
	return undefined;
}

/** A PDF's header. */
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
/**
 * How far into a file a PDF header may sit. PDF readers, and Boost's
 * converter, accept `%PDF-` anywhere in the first 1024 bytes, and real files
 * carry a BOM, whitespace or a mail/HTTP preamble before it often enough.
 */
const PDF_HEADER_WINDOW = 1024;
/** OOXML (.docx/.xlsx/.pptx) and ODF (.odt/.ods/.odp) are zip archives. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** Legacy Office files are OLE2 compound documents. */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** How many bytes of the file {@link isDocumentFile} needs. */
export const HEAD_BYTES = PDF_HEADER_WINDOW;

/**
 * Whether a file whose name ends in `ext` and starts with `head` really is
 * that kind of document, judged by its magic number. Checked on the file,
 * not on pi's text: pi may have returned only a slice of it (`offset`), its
 * "line too long" notice (a stored zip's XML is one huge line), or its
 * "offset beyond end of file" error, none of which look like the file's
 * head. Zip and OLE2 must start at byte 0; a PDF header may sit anywhere in
 * the first 1 KiB. True for an extension with no magic to check (notebooks).
 *
 * A password-protected .docx/.xlsx/.pptx is an OLE2 container, not a zip,
 * and is skipped as `not-document` on purpose: Boost v0.15.4 does not
 * decrypt it — `boost read` prints the file's raw bytes and exits 0
 * (checked in the sandbox with an OLE2-headed .xlsx) — so trying would cost
 * a spawn, and up to 16 MiB of stdout, to end in the same fail-open.
 */
export function isDocumentFile(ext: string, head: Buffer): boolean {
	const startsWith = (magic: Buffer) => head.subarray(0, magic.length).equals(magic);
	if (ext === ".pdf") return head.subarray(0, PDF_HEADER_WINDOW).includes(PDF_MAGIC);
	if (BINARY_DOCS.has(ext)) return startsWith(ZIP_MAGIC);
	if (LEGACY_OFFICE.has(ext)) return startsWith(OLE_MAGIC);
	return true;
}

// ---------------------------------------------------------------------------
// Validating Boost's answer

export type InvalidReason = "empty" | "binary" | "image" | "advisory";

/**
 * Binary signatures Boost's `read` hands back unconverted, as they look after
 * the process layer decodes stdout as UTF-8: a byte ≥ 0x80 that does not
 * start a valid sequence becomes U+FFFD, so PNG's `\x89PNG` arrives as
 * U+FFFD then `PNG`, and JPEG's `FF D8 FF` as three U+FFFDs.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching binary signatures is the point
const BINARY_OUTPUT = /^(?:%PDF|PK\u0003\u0004|[\u0089\ufffd]PNG|GIF8[79]a|\u00ff\u00d8\u00ff|\ufffd{3})/;

/**
 * Why Boost's output is not text the model can be given in place of the
 * file, or undefined when it is. Boost's `read` is a general-purpose reader:
 * for a format it does not convert it may print the raw bytes, a path
 * (`image …` for pictures), or a one-line `[boost] …` advisory, and all of
 * them exit 0 (boost-surfaces 7).
 */
export function invalidOutput(stdout: string): InvalidReason | undefined {
	if (!stdout.trim()) return "empty";
	if (stdout.includes("\0")) return "binary";
	if (BINARY_OUTPUT.test(stdout)) return "binary";
	if (stdout.startsWith("image ")) return "image";
	if (stdout.startsWith("[boost]")) return "advisory";
	if (looksBinary(stdout)) return "binary";
	return undefined;
}

// ---------------------------------------------------------------------------
// What the model is told

/**
 * The first line of a converted page. It is not part of the text being
 * paged, so `offset` and the notices count from the line after it.
 *
 * Spreadsheets lose their grid in conversion (boost-surfaces 8), which the
 * model must know before it reasons about rows and columns. A notebook's raw
 * JSON is one read away, because any read with `offset` or `limit` is exact.
 * Both notes go inside the brackets, so the header stays one bracketed
 * notice rather than a notice followed by loose prose.
 */
export function headerFor(name: string, ext: string): string {
	let note = "";
	if (ext === ".xlsx" || ext === ".ods") {
		note = " Spreadsheet cells are listed one per line; table layout is not preserved.";
	} else if (ext === ".ipynb") {
		note = " For the raw notebook JSON, read it again with offset=1.";
	}
	return `[Converted from ${name} by JFrog Boost. Line numbers refer to this text, not the file.${note}]`;
}

/**
 * The error a legacy Office read becomes once Boost has said it cannot
 * convert it (spec §7.1). pi itself returns such a file as garbage bytes,
 * which the model may try to reason about; an error stops it and says what
 * would work. Boost's line usually ends in a full stop, which is dropped so
 * the sentence does not end in two.
 */
export function legacyAdvisory(name: string, stdout: string): string {
	const first = (stdout.split("\n")[0] ?? "").trim().replace(/\.$/, "");
	return `pi-jfrog-boost: ${name} is a legacy binary Office file that neither pi nor Boost can convert to text. Boost says: ${first}. Ask the user for a .docx/.xlsx/.pptx or text export.`;
}

// ---------------------------------------------------------------------------
// Cache

export const CACHE_MAX_ENTRIES = 8;
export const CACHE_MAX_BYTES = 32 * 1024 * 1024;

export interface DocumentCache {
	get(key: string): string | undefined;
	set(key: string, text: string): void;
	/** Entries held; read only by the tests. */
	size(): number;
}

/** The cache key: a file changed in place (new mtime or size) is converted again. */
export function cacheKey(abs: string, mtimeMs: number, size: number): string {
	return `${abs}\u0000${mtimeMs}\u0000${size}`;
}

/**
 * A small LRU of converted texts. Paging through a 5000-line PDF is three
 * reads; without it, each one would run `boost read` again (~200 ms for a
 * small file, seconds for a large one). Bounded by entries and by memory —
 * a JavaScript string costs two bytes per UTF-16 unit — so a session that
 * reads many large documents cannot grow pi's heap without limit. A text
 * larger than the whole budget is simply not cached.
 */
export function createDocumentCache(
	maxEntries: number = CACHE_MAX_ENTRIES,
	maxBytes: number = CACHE_MAX_BYTES,
): DocumentCache {
	const entries = new Map<string, string>();
	let bytes = 0;
	const cost = (text: string) => text.length * 2;
	const remove = (key: string) => {
		const text = entries.get(key);
		if (text === undefined) return;
		bytes -= cost(text);
		entries.delete(key);
	};
	return {
		get(key) {
			const text = entries.get(key);
			if (text === undefined) return undefined;
			// Map order is insertion order: re-inserting marks it most recent.
			entries.delete(key);
			entries.set(key, text);
			return text;
		},
		set(key, text) {
			remove(key);
			if (cost(text) > maxBytes) return;
			entries.set(key, text);
			bytes += cost(text);
			for (const oldest of entries.keys()) {
				if (entries.size <= maxEntries && bytes <= maxBytes) break;
				remove(oldest);
			}
		},
		size: () => entries.size,
	};
}

// ---------------------------------------------------------------------------
// The route

export interface DocumentRequest {
	/** `read`'s arguments, as the model sent them. */
	path: unknown;
	offset: unknown;
	limit: unknown;
	/** The session's working directory, which pi resolves relative paths against. */
	cwd: string;
	/**
	 * Boost's Preview Agreement is recorded in its config. `boost read` exits 1
	 * without it (NP3), so nothing is spawned; the read is skipped as `terms`
	 * — but only once the file has passed every other check, so a small
	 * notebook or a text file called `x.pdf` is counted as what it is, and the
	 * terms notice is never shown for a read that would not have converted
	 * anyway. A text already in the cache is still served: it was converted
	 * when the terms were there, and the file has not changed since.
	 */
	termsAccepted: boolean;
}

interface FileStat {
	isFile(): boolean;
	mtimeMs: number;
	size: number;
}

export interface DocumentDeps {
	/** `boost read -- <abs>` (the client's `convert`). */
	convert(abs: string, size: number): Promise<BoostCall>;
	cache: DocumentCache;
	/** Injected by tests; default `fs.statSync`. */
	stat?: (path: string) => FileStat;
	/** The first `bytes` bytes of a file; injected by tests. */
	readHead?: (path: string, bytes: number) => Buffer;
	home?: string;
}

export type DocumentOutcome =
	| {
			kind: "skip";
			/** Why pi's result is kept: a counter key for `/boost stats`. */
			reason: string;
			/** The Boost call, when one was made: the caller counts its failures. */
			call?: BoostCall;
	  }
	| {
			kind: "page";
			/** The header, the page and pi's notice: what the model reads. */
			text: string;
			/** The page and its notice without the header: what pi's `read` would return for the converted text. */
			page: string;
			ext: string;
			lines: [number, number, number];
			/** pi's `details.truncation` for this page, when pi would set one (see {@link Slice}). */
			truncation?: PiTruncation;
			call?: BoostCall;
	  }
	| { kind: "error"; text: string; ext: string; call?: BoostCall };

function defaultReadHead(path: string, bytes: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const read = readSync(fd, buffer, 0, bytes, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

/** `read`'s offset or limit as pi would use it, or null when it is not one pi accepts. */
function numberArg(value: unknown): number | undefined | null {
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The continuation notice for a converted notebook's first page. pi's says
 * `Use offset=N to continue`, but a notebook read with an offset is exact
 * (router.ts): it would return the raw JSON from line N of the file — a
 * different text, with nothing to say so — and the rest of the converted text
 * could not be reached at all. This one keeps pi's "Showing lines" wording
 * and points at `boost read` piped into `sed` for the next page of the same
 * size, which does print the converted lines. pi's other notices stand: the
 * "line too long" one already uses `boost read`, and a notebook has no
 * `limit` to end a page early.
 */
export function notebookNotice(slice: Extract<Slice, { kind: "page" }>, abs: string): string {
	const t = slice.truncation;
	if (!t?.truncated || t.firstLineExceedsLimit) return slice.notice;
	const [first, last, total] = slice.lines;
	const next = last + 1;
	const until = Math.min(total, last + (last - first + 1));
	const limit = t.truncatedBy === "bytes" ? ` (${formatSize(PI_MAX_BYTES)} limit)` : "";
	return `\n\n[Showing lines ${first}-${last} of ${total} of the converted notebook${limit}. To continue, use bash: boost read -- ${shellQuote(abs)} | sed -n '${next},${until}p'. A read with offset returns the raw notebook JSON instead.]`;
}

/**
 * Convert a `read` of a document, or say why not. The caller (index.ts) has
 * already routed the read here: a document extension, the setting on, and
 * pi's read not refused for any reason but an offset past the
 * raw bytes' end.
 */
export async function readDocument(req: DocumentRequest, deps: DocumentDeps): Promise<DocumentOutcome> {
	const mode = documentMode(req.path);
	if (!mode || typeof req.path !== "string") return { kind: "skip", reason: "exact" };
	const offset = numberArg(req.offset);
	const limit = numberArg(req.limit);
	if (offset === null || limit === null) return { kind: "skip", reason: "exact" };
	// A partial notebook read is the model asking for exact JSON lines.
	if (mode === "notebook" && (offset !== undefined || limit !== undefined))
		return { kind: "skip", reason: "exact" };

	const ext = extensionOf(req.path);
	// pi opens the first of these that exists; so does this, so the file
	// converted is the file pi read.
	let abs = "";
	let stat: FileStat | undefined;
	for (const candidate of readPathCandidates(resolveReadPath(req.path, req.cwd, deps.home ?? homedir()))) {
		try {
			stat = (deps.stat ?? statSync)(candidate);
			abs = candidate;
			break;
		} catch {
			/* pi tries the next look-alike name */
		}
	}
	if (!stat) return { kind: "skip", reason: "not-file" };
	const name = basename(abs);
	// A directory, a FIFO or a device is not something to hand to a converter.
	if (!stat.isFile()) return { kind: "skip", reason: "not-file" };
	if (mode === "notebook" && stat.size < NOTEBOOK_MIN_BYTES) return { kind: "skip", reason: "small" };
	if (mode !== "notebook") {
		let head: Buffer;
		try {
			head = (deps.readHead ?? defaultReadHead)(abs, HEAD_BYTES);
		} catch {
			return { kind: "skip", reason: "not-file" };
		}
		if (!isDocumentFile(ext, head)) return { kind: "skip", reason: "not-document" };
	}

	const key = cacheKey(abs, stat.mtimeMs, stat.size);
	let text = deps.cache.get(key);
	let call: BoostCall | undefined;
	if (text === undefined) {
		if (!req.termsAccepted) return { kind: "skip", reason: "terms" };
		call = await deps.convert(abs, stat.size);
		if (call.skipped) return { kind: "skip", reason: call.skipped, call };
		if (
			call.timedOut ||
			call.aborted ||
			call.spawnError ||
			call.overflow ||
			call.killedBy ||
			call.code === null
		) {
			return { kind: "skip", reason: "failed", call };
		}
		if (mode === "legacy") {
			// Only Boost's own answer turns into an error. Whatever else it says,
			// pi's result stands: there is nothing better to offer.
			if (!call.stdout.startsWith("[boost]")) return { kind: "skip", reason: "unconverted", call };
			deps.cache.set(key, call.stdout);
			return { kind: "error", text: legacyAdvisory(name, call.stdout), ext, call };
		}
		// `boost read` exits 1 without the Preview Agreement (NP3), for a file
		// it cannot open, and for formats it gives up on.
		if (call.code !== 0) return { kind: "skip", reason: "exit", call };
		const invalid = invalidOutput(call.stdout);
		if (invalid) return { kind: "skip", reason: invalid, call };
		text = call.stdout;
		deps.cache.set(key, text);
	} else if (mode === "legacy") {
		return { kind: "error", text: legacyAdvisory(name, text), ext };
	}

	// A notebook is only converted whole; slicing starts at line 1.
	const slice = sliceLikePiRead(text, offset, limit, abs);
	if (slice.kind === "error") return { kind: "error", text: slice.message, ext, ...(call ? { call } : {}) };
	const notice = mode === "notebook" ? notebookNotice(slice, abs) : slice.notice;
	const page = `${slice.page}${notice}`;
	return {
		kind: "page",
		text: `${headerFor(name, ext)}\n${page}`,
		page,
		ext,
		lines: slice.lines,
		...(slice.truncation ? { truncation: slice.truncation } : {}),
		...(call ? { call } : {}),
	};
}
