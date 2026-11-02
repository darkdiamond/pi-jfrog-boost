/**
 * `/boost install` (spec §11): get the Boost binary onto the machine, with the
 * user's consent and nothing else.
 *
 * 0.3.0 ran JFrog's install.sh after a confirm that said it "installs the
 * boost binary under ~/.local/bin and nothing else". That was not true: the
 * script may edit shell rc files and, when ~/.local/bin is already on PATH,
 * runs `boost init --accept-terms`, which accepts JFrog's Preview Agreement on
 * the user's behalf and installs Boost hooks into Claude Code, Cursor, Codex,
 * Copilot and OpenCode (NP7). So there are now two honest options:
 *
 *   1. Binary only (recommended), Node-native: look the release up on the
 *      GitHub API, download `boost-${os}-${arch}.tar.gz` (F4), check it against
 *      the SHA-256 GitHub publishes for the asset, extract the one `boost`
 *      file and rename it into ~/.local/bin. install.sh never runs, and no
 *      shell is involved at all: `pi.exec` has no `env` option and quoting a
 *      pipeline through `sh -c` is fragile, so the only child is `tar`.
 *   2. JFrog's installer, unchanged — described as what it is, and confirmed.
 *
 * Plus "show me the commands" and cancel. Windows and sessions without a UI
 * only ever get text: nothing runs without a dialog the user answered.
 *
 * After either option the extension re-resolves the binary and re-probes it
 * (`refresh()`), so Boost is in use from the next tool call without a restart.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { homedir, arch as osArch, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type BoostVersion, formatVersion, MIN_BOOST_VERSION, parseBoostVersion } from "./boost-binary.ts";
import { createProcessRunner, type RunResult } from "./boost-process.ts";
import { classifyProbe, type ReadinessState } from "./health.ts";

export const INSTALL_URL = "https://boost.jfrog.com/install.sh";
export const INSTALL_DOCS = "https://boost.jfrog.com/llms-install.txt";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | bash`;
/**
 * What the "Official installer" option actually runs: JFrog's install.sh,
 * unchanged, but downloaded in full before bash sees a byte of it. Piped
 * straight into bash, a transfer cut mid-stream runs a truncated script, and
 * a failed curl (DNS, TLS, 404) leaves bash an empty stdin that exits 0, so a
 * failure would be reported as an install. Here any failed step fails the
 * whole command, and the temp file is removed either way.
 */
export const OFFICIAL_SCRIPT = [
	"set -euo pipefail",
	'f="$(mktemp)"',
	"trap 'rm -f \"$f\"' EXIT",
	`curl -fsSL ${INSTALL_URL} -o "$f"`,
	'bash "$f"',
].join("; ");
export const RELEASES_API = "https://api.github.com/repos/jfrog/boost/releases/latest";
export const RELEASES_PAGE = "https://github.com/jfrog/boost/releases/latest";
/** Every asset URL must start with this; anything else falls back to the commands text. */
const DOWNLOAD_HOST = "github.com";
const DOWNLOAD_PATH = "/jfrog/boost/releases/download/";
export const TERMS_URL = "https://boost.jfrog.com/preview-agreement/";
export const WINDOWS_COMMAND = "irm https://raw.githubusercontent.com/jfrog/boost/main/install.ps1 | iex";

/** The GitHub API answers in well under a second; 15 s covers a slow link without hanging the command. */
export const LOOKUP_TIMEOUT_MS = 15_000;
/**
 * The spec's 120 s. The darwin/arm64 archive is ~41 MB (v0.15.4, measured;
 * the binary in it ~114 MB), so this needs ~2.7 Mbit/s sustained: ample on
 * broadband, tight on a slow or metered link. A timeout installs nothing and
 * says so, with the docs link; the commands text is the slow-link route.
 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const EXTRACT_TIMEOUT_MS = 30_000;
export const OFFICIAL_TIMEOUT_MS = 180_000;
export const VERIFY_TIMEOUT_MS = 8_000;
/**
 * The download is refused past this size. Boost's archives are ~41 MB
 * (v0.15.4 darwin/arm64, measured); a response several times that is not
 * the release asset, and must not be allowed to fill the user's temp disk
 * before the checksum could reject it. Generous on purpose: a release that
 * grows must not be refused.
 */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export type ReleaseOs = "darwin" | "linux";
export type ReleaseArch = "amd64" | "arm64";

/**
 * Boost's release platform for this machine (F4), or undefined when it ships
 * none: os is `darwin` or `linux`, and Node's `x64`/`arm64` are Go's
 * `amd64`/`arm64`. Windows is handled separately (install.ps1).
 */
export function releasePlatform(
	platform: NodeJS.Platform,
	arch: string,
): { os: ReleaseOs; arch: ReleaseArch } | undefined {
	if (platform !== "darwin" && platform !== "linux") return undefined;
	if (arch === "x64") return { os: platform, arch: "amd64" };
	if (arch === "arm64") return { os: platform, arch: "arm64" };
	return undefined;
}

export const assetName = (os: string, arch: string) => `boost-${os}-${arch}.tar.gz`;

// ---------------------------------------------------------------------------
// Texts

/**
 * `~/…` for a path under `home`, for messages. Separator-aware through
 * `path.relative` (a Windows path has backslashes, and `C:\Users\me2` is not
 * under `C:\Users\me`); the shortened form always uses `/`, as `~` does.
 */
export function tildePath(path: string, home: string): string {
	if (!home) return path;
	const rel = relative(home, path);
	if (rel === "") return "~";
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
	return `~/${rel.split(sep).join("/")}`;
}

/** `14.2 MB`: the asset's size as the confirm shows it. */
export function formatSize(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
	return `${bytes} B`;
}

export interface ConfirmView {
	tag: string;
	os: string;
	arch: string;
	asset: string;
	size: number;
	/** The destination, as shown (already `~`-shortened). */
	dest: string;
}

/**
 * The binary-only confirm, exactly as spec §11 words it (golden-tested). The
 * first line is the dialog's title, the rest its message. Every "does not" is
 * a promise this module keeps, so the text is only ever changed together with
 * the code it describes.
 */
export function confirmText(view: ConfirmView): { title: string; message: string } {
	return {
		title: `Install JFrog Boost ${view.tag} for ${view.os}/${view.arch}?`,
		message: [
			`pi-jfrog-boost will download ${view.asset} (${formatSize(view.size)}) from github.com/jfrog/boost,`,
			"check it against the SHA-256 GitHub publishes for it,",
			`and place the boost binary at ${view.dest}. That is all it does:`,
			"  • it does not run JFrog's install.sh",
			"  • it does not change your shell startup files or PATH",
			"  • it does not run `boost init`, so no hooks are added to other agents",
			"  • it does not accept JFrog's Preview Agreement for you",
			"",
			"MCP results are compacted (Boost ≥ 0.15.3) only for tools pi calls directly",
			"or loads with tool_search; calls made inside codemode scripts (pi 1.x's",
			"default MCP exposure) are not. Shell-output compaction is off by default in",
			"Boost; turn it on for pi with /boost settings → Shell output.",
			"PDF/Office conversion and boost retrieve (recovering what was dropped) need",
			"the agreement: in a terminal run `boost init --dry-run`, then `boost init`.",
			`Terms: ${TERMS_URL}`,
		].join("\n"),
	};
}

/** What JFrog's installer does, said before it runs (NP7). */
export const OFFICIAL_CONFIRM_MESSAGE = [
	"This runs JFrog's official installer, unchanged, in your real environment.",
	"pi-jfrog-boost downloads it in full, then runs it with bash:",
	"",
	`    curl -fsSL ${INSTALL_URL} -o <temp file> && bash <temp file>`,
	"",
	"It installs the boost binary into ~/.local/bin and may add ~/.local/bin to your",
	"shell rc files. If ~/.local/bin is already on your PATH, it also runs",
	"`boost init --accept-terms`, which accepts JFrog's Preview Agreement on your",
	"behalf and installs Boost hooks for Claude Code, Cursor, Codex, Copilot and",
	"OpenCode.",
	"",
	`Terms: ${TERMS_URL}`,
	`Docs: ${INSTALL_DOCS}`,
].join("\n");

export const WINDOWS_TEXT = `In PowerShell: ${WINDOWS_COMMAND} — JFrog's script; it may also run \`boost init\`, which accepts the Preview Agreement and adds hooks to other agents. Then /boost status.`;

/** Option 3, the no-UI answer and every fallback: what to run, by hand. */
export function commandsText(release: { os: string; arch: string } | undefined, dest: string): string {
	const asset = release ? assetName(release.os, release.arch) : "boost-<os>-<arch>.tar.gz";
	const lines = [
		"To install JFrog Boost yourself, binary only:",
		`  1. Download ${asset} from ${RELEASES_PAGE}${release ? "" : " (os: darwin or linux; arch: amd64 or arm64)"}`,
		`  2. Compare \`shasum -a 256 ${asset}\` with the sha256 digest shown for it on that page`,
		`  3. tar -xzf ${asset} boost && mkdir -p ${dirname(dest)} && mv boost ${dest} && chmod 0755 ${dest}`,
		`  4. ${dest} version`,
		"Or JFrog's official installer (it may edit your shell rc files and, when ~/.local/bin is on PATH,",
		"run `boost init --accept-terms`, which accepts the Preview Agreement for you and adds hooks to other agents):",
		`  ${INSTALL_COMMAND}`,
		`Then /boost status. Docs: ${INSTALL_DOCS}`,
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The release lookup

export interface ReleaseAsset {
	tag: string;
	url: string;
	size: number;
	/** Lower-case hex SHA-256 GitHub publishes for the asset (`digest: "sha256:<hex>"`). */
	sha256: string;
}

/**
 * The asset named `name` in a GitHub "latest release" answer, or why not.
 * Defensive about every field: this is network input.
 */
export function findAsset(release: unknown, name: string): ReleaseAsset | string {
	if (typeof release !== "object" || release === null) return "the release answer was not JSON";
	const r = release as { tag_name?: unknown; assets?: unknown };
	const tag = typeof r.tag_name === "string" ? r.tag_name : "";
	if (!/^v?\d+\.\d+\.\d+[\w.+-]*$/.test(tag)) return "the release has no version tag";
	const assets = Array.isArray(r.assets) ? (r.assets as unknown[]) : [];
	const asset = assets.find(
		(a): a is Record<string, unknown> =>
			typeof a === "object" && a !== null && (a as Record<string, unknown>).name === name,
	);
	if (!asset) return `release ${tag} has no ${name}`;
	const url = downloadUrl(asset.browser_download_url);
	if (!url) return `${name} has no download URL`;
	const size = typeof asset.size === "number" && asset.size > 0 ? asset.size : 0;
	if (size === 0 || size > MAX_DOWNLOAD_BYTES) return `${name} has no plausible size`;
	// An unverifiable binary is never installed: without a published digest
	// the caller falls back to showing the manual steps.
	const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null;
	if (!digest) return `GitHub publishes no SHA-256 for ${name}, so it cannot be verified`;
	return { tag, url, size, sha256: (digest[1] as string).toLowerCase() };
}

/**
 * Only JFrog's own release downloads. Checked on the parsed URL, not the raw
 * string: a prefix match lets `…/download/../../../other/repo/…` through,
 * which fetch normalises to someone else's release. Returns the normalised
 * href, so what is checked is exactly what is fetched. A redirect elsewhere is
 * fetch's to follow; the starting point is never taken from anywhere else.
 */
export function downloadUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" || u.host !== DOWNLOAD_HOST || u.username || u.password) return undefined;
	if (!u.pathname.startsWith(DOWNLOAD_PATH)) return undefined;
	return u.href;
}

// ---------------------------------------------------------------------------
// The command

/** What the install flow needs from the rest of the extension. */
export interface InstallHost {
	/**
	 * The binary in use now, resolved afresh — the way every Boost call
	 * resolves it, so BOOST_BIN/BOOST_EXE win over ~/.local/bin.
	 */
	binary(): string | undefined;
	/**
	 * Readiness as probed, once a probe in flight has settled (a bounded
	 * wait) — not the footer's view, which says `disabled` while the session
	 * is off whatever the binary is. `disabled`, `probing` and `missing` are
	 * "no verdict on this binary"; the flow then asks the binary itself.
	 */
	current(): Promise<ReadinessState>;
	/**
	 * Re-resolve the binary, re-probe it, re-read Boost's config and repaint
	 * `ctx`'s footer (§11 "After either option"; the footer must not keep
	 * saying "not installed" next to "Installed …"). Resolves with the state
	 * the probe settled on, as `current()` reports it.
	 */
	refresh(ctx: ExtensionCommandContext): Promise<ReadinessState>;
	/** Whether `boost` typed in a shell finds this binary. */
	onPath(binary: string): boolean;
	/**
	 * The shell-off notice when shell compaction is off by Boost's flag or
	 * default (not by the user's setting); undefined when it is not.
	 */
	shellOffNotice(): string | undefined;
	termsAccepted(): boolean;
}

/** Everything the flow touches outside itself, injectable by tests. */
export interface InstallDeps {
	platform?: NodeJS.Platform;
	/** `os.arch()`. */
	arch?: string;
	/** `globalThis.fetch`. */
	fetch?: typeof fetch;
	home?: string;
	/**
	 * Where the binary goes. Default `~/.local/bin/boost`; tests and the
	 * sandbox check point it at a temp directory.
	 */
	dest?: string;
	/** Parent of the per-install temp directory; default `os.tmpdir()`. */
	tmpdir?: string;
	/** `boost version` with flag fetching disabled, on the installed file. */
	verify?: (binary: string) => Promise<RunResult>;
	lookupTimeoutMs?: number;
	downloadTimeoutMs?: number;
	/** Print a line for a session without a UI. */
	print?: (ctx: ExtensionCommandContext, text: string) => void;
}

/** Where `boost` goes: the directory Boost's own installer and resolver use. */
export const defaultDest = (home: string) => join(home, ".local", "bin", "boost");

/**
 * `boost version` on a binary, offline (FLAGS_DISABLE: without flag metadata
 * every call would otherwise stall ~5 s, F2) and capped. Exported for its test.
 */
export async function defaultVerify(binary: string): Promise<RunResult> {
	return createProcessRunner().run(binary, ["version"], {
		cwd: tmpdir(),
		env: { ...process.env, BOOST_FEATURE_FLAGS_DISABLE: "1" },
		timeoutMs: VERIFY_TIMEOUT_MS,
		maxStdout: 64 * 1024,
	});
}

/** A step that failed, with the output worth showing. */
class StepError extends Error {
	readonly step: string;
	readonly output: string;
	constructor(step: string, message: string, output = "") {
		super(message);
		this.step = step;
		this.output = output;
	}
}

const lastLines = (text: string, n: number) =>
	text
		.trimEnd()
		.split("\n")
		.filter((l) => l.trim() !== "")
		.slice(-n)
		.join("\n");

/**
 * What is wrong with a binary that is not `ready`, completing "JFrog Boost at
 * X …" — for a state that is a verdict on the binary (§11 calls only a ready
 * one "current").
 */
function problemText(state: ReadinessState): string {
	switch (state.kind) {
		case "too-old":
			return `is v${formatVersion(state.version)}, older than v${formatVersion(MIN_BOOST_VERSION)}`;
		case "not-responding":
			return "does not answer `boost version`";
		case "unknown-version":
			return "prints a version pi-jfrog-boost cannot read";
		default:
			return "is not usable";
	}
}

/** Whether two paths name the same file, symlinks resolved; plain equality when either cannot be resolved. */
async function samePath(a: string, b: string): Promise<boolean> {
	if (a === b) return true;
	try {
		return (await realpath(a)) === (await realpath(b));
	} catch {
		return false;
	}
}

function failureText(step: string, message: string, output: string): string {
	const tail = lastLines(output, 3);
	return `JFrog Boost was not installed: ${step} failed (${message}).${tail ? `\n${tail}` : ""}\nDocs: ${INSTALL_DOCS}`;
}

const OPTION_BINARY = "Binary only (recommended): the boost binary into ~/.local/bin, nothing else";
const OPTION_OFFICIAL =
	"Official installer, unchanged: JFrog's install.sh (may edit rc files, accept terms, add hooks)";
const OPTION_COMMANDS = "Show the commands; I'll run them myself";
const OPTION_CANCEL = "Cancel";
export const INSTALL_OPTIONS = [OPTION_BINARY, OPTION_OFFICIAL, OPTION_COMMANDS, OPTION_CANCEL] as const;

/**
 * Create the `/boost install` handler. `args` may carry `--force`, which
 * offers a reinstall over a working Boost.
 */
export function createInstaller(pi: ExtensionAPI, host: InstallHost, deps: InstallDeps = {}) {
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? osArch();
	const home = deps.home ?? homedir();
	const fetchFn = deps.fetch ?? globalThis.fetch;
	const dest = deps.dest ?? defaultDest(home);
	const shownDest = tildePath(dest, home);
	const verify = deps.verify ?? defaultVerify;
	const lookupTimeoutMs = deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
	const downloadTimeoutMs = deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
	const release = releasePlatform(platform, arch);

	const say = (ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else deps.print?.(ctx, text);
	};

	/** A signal that aborts with the user's (ctx.signal) or after `ms`. */
	const deadline = (ctx: ExtensionCommandContext, ms: number): AbortSignal => {
		const timeout = AbortSignal.timeout(ms);
		return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
	};

	/**
	 * The verdict on `binary`: the host's, when it has one for it, otherwise
	 * `boost version` asked directly (the session is off, the first probe has
	 * not settled, or readiness has not seen this binary yet). Only a `ready`
	 * answer counts as installed and current.
	 */
	async function verdict(binary: string, state: ReadinessState): Promise<ReadinessState> {
		if (
			state.kind === "ready" ||
			state.kind === "too-old" ||
			state.kind === "unknown-version" ||
			state.kind === "not-responding"
		) {
			return state;
		}
		try {
			return classifyProbe(await verify(binary));
		} catch {
			return { kind: "not-responding" };
		}
	}

	async function lookup(ctx: ExtensionCommandContext, name: string): Promise<ReleaseAsset | string> {
		try {
			const response = await fetchFn(RELEASES_API, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-jfrog-boost" },
				signal: deadline(ctx, lookupTimeoutMs),
			});
			if (!response.ok) return `GitHub answered ${response.status}`;
			return findAsset(await response.json(), name);
		} catch (error) {
			return (error as Error).name === "TimeoutError"
				? "GitHub did not answer in time"
				: (error as Error).message;
		}
	}

	/** Stream the asset into `file`, hashing as it goes. Returns the hex SHA-256. */
	async function download(ctx: ExtensionCommandContext, asset: ReleaseAsset, file: string): Promise<string> {
		let response: Response;
		const signal = deadline(ctx, downloadTimeoutMs);
		try {
			response = await fetchFn(asset.url, { headers: { "User-Agent": "pi-jfrog-boost" }, signal });
		} catch (error) {
			throw new StepError("download", (error as Error).message);
		}
		if (!response.ok || !response.body) throw new StepError("download", `HTTP ${response.status}`);
		const hash = createHash("sha256");
		let bytes = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, done) {
				bytes += chunk.length;
				if (bytes > MAX_DOWNLOAD_BYTES) {
					done(new Error(`larger than ${formatSize(MAX_DOWNLOAD_BYTES)}`));
					return;
				}
				hash.update(chunk);
				done(null, chunk);
			},
		});
		try {
			await pipeline(
				Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
				meter,
				createWriteStream(file, { mode: 0o600 }),
				{ signal },
			);
		} catch (error) {
			throw new StepError(
				"download",
				(error as Error).name === "AbortError" && !ctx.signal?.aborted
					? "timed out"
					: (error as Error).message,
			);
		}
		if (bytes !== asset.size) {
			throw new StepError("download", `got ${bytes} bytes, GitHub lists ${asset.size}`);
		}
		return hash.digest("hex");
	}

	/** Binary only (spec §11 steps 1–8). Returns the version `boost version` reported for it. */
	async function binaryOnly(
		ctx: ExtensionCommandContext,
		asset: ReleaseAsset,
		name: string,
	): Promise<BoostVersion> {
		const work = await mkdtemp(join(deps.tmpdir ?? tmpdir(), "pi-jfrog-boost-install-"));
		try {
			const archive = join(work, name);
			const sha = await download(ctx, asset, archive);
			if (sha !== asset.sha256) {
				throw new StepError("checksum", `SHA-256 ${sha} does not match GitHub's ${asset.sha256}`);
			}
			// Only the one member, into the private temp directory: whatever else
			// the archive holds is never written anywhere.
			const tar = await pi.exec("tar", ["-xzf", archive, "-C", work, "boost"], {
				timeout: EXTRACT_TIMEOUT_MS,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
			if (tar.code !== 0) {
				throw new StepError("extract", `tar exited ${tar.code}`, `${tar.stdout}\n${tar.stderr}`);
			}
			const extracted = join(work, "boost");
			// lstat, not stat: a symlink in the archive must not become the binary.
			const info = await lstat(extracted).catch(() => undefined);
			if (!info?.isFile()) throw new StepError("extract", "the archive has no regular file named boost");
			await chmod(extracted, 0o755);
			// Copied next to the destination first, then renamed over it: a rename
			// is atomic only within one filesystem, and the temp directory is often
			// on another. A Boost running from the old file keeps its inode.
			const staged = `${dest}.tmp-${process.pid}`;
			let placed = false;
			try {
				try {
					await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
					await copyFile(extracted, staged);
					await chmod(staged, 0o755);
				} catch (error) {
					throw new StepError("install", (error as Error).message);
				}
				// Verified while still staged, so "was not installed" stays true
				// when it fails: a binary that cannot even print its version must
				// not replace one that works (even a too-old one). Staged next to
				// the destination rather than run from the temp directory, which
				// may be mounted noexec.
				const run = await verify(staged);
				const version = parseBoostVersion(run.stdout);
				if (run.code !== 0 || !version) {
					throw new StepError(
						"verify",
						run.timedOut ? "`boost version` timed out" : `\`boost version\` exited ${run.code}`,
						run.stdout,
					);
				}
				try {
					await rename(staged, dest);
				} catch (error) {
					throw new StepError("install", (error as Error).message);
				}
				placed = true;
				return version;
			} finally {
				if (!placed) await rm(staged, { force: true }).catch(() => {});
			}
		} finally {
			await rm(work, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * The report after either option (spec §11 "After either option").
	 * `placed` is what the binary-only flow wrote and verified; the official
	 * installer leaves it undefined and is judged by what pi finds afterwards.
	 *
	 * The path and version reported are those of the binary pi actually uses,
	 * re-resolved after the refresh. BOOST_BIN/BOOST_EXE (or an earlier hit)
	 * win over ~/.local/bin, so "Installed v0.15.5 at /opt/old/boost" while pi
	 * keeps running an old build there would be a false success: that case
	 * says where the new file went and what pi uses instead.
	 */
	async function afterInstall(
		ctx: ExtensionCommandContext,
		placed?: { path: string; version: BoostVersion },
	): Promise<void> {
		const state = await host.refresh(ctx);
		const binary = host.binary();
		if (!binary) {
			if (placed) {
				say(
					ctx,
					`Placed JFrog Boost v${formatVersion(placed.version)} at ${placed.path}, but pi-jfrog-boost does not find it there. /boost status for details.`,
					"warning",
				);
			} else {
				say(ctx, failureText("install", "no boost binary was found afterwards", ""), "error");
			}
			return;
		}
		const inUse = await verdict(binary, state);
		const ready = inUse.kind === "ready";
		const usedVersion = "version" in inUse ? inUse.version : undefined;
		const lines: string[] = [];
		const elsewhere = placed !== undefined && !(await samePath(binary, placed.path));
		if (placed && elsewhere) {
			lines.push(
				`Placed JFrog Boost v${formatVersion(placed.version)} at ${placed.path}, but pi uses ${binary}${usedVersion ? ` (v${formatVersion(usedVersion)})` : ""}: BOOST_BIN or BOOST_EXE points there, or it is found first. Unset it, or point it at ${placed.path}.`,
			);
		} else {
			const version = usedVersion ?? placed?.version;
			lines.push(`Installed JFrog Boost ${version ? `v${formatVersion(version)} ` : ""}at ${binary}.`);
		}
		if (!ready) {
			lines.push(`pi-jfrog-boost can't use it yet: it ${problemText(inUse)}. /boost status for details.`);
		}
		let onPathNow = true;
		try {
			onPathNow = host.onPath(binary);
		} catch {
			/* say nothing rather than something wrong */
		}
		if (!onPathNow) {
			// The directory the binary in use lives in, not always ~/.local/bin.
			lines.push(
				`${tildePath(dirname(binary), home)} isn't on your PATH; pi still finds Boost and gives the model the full path.`,
			);
		}
		const shellOff = ready ? host.shellOffNotice() : undefined;
		if (shellOff) lines.push(shellOff);
		if (ready && !host.termsAccepted()) {
			lines.push(
				"PDF/Office conversion and `boost retrieve` need Boost's Preview Agreement: in a terminal run `boost init --dry-run`, then `boost init`.",
			);
		}
		say(ctx, lines.join("\n"), ready && !elsewhere ? "info" : "warning");
	}

	async function runBinaryOnly(ctx: ExtensionCommandContext): Promise<void> {
		if (!release) {
			say(ctx, commandsText(undefined, shownDest));
			return;
		}
		const name = assetName(release.os, release.arch);
		const asset = await lookup(ctx, name);
		if (typeof asset === "string") {
			say(ctx, `Not installing automatically: ${asset}.\n${commandsText(release, shownDest)}`, "warning");
			return;
		}
		const { title, message } = confirmText({
			tag: asset.tag,
			os: release.os,
			arch: release.arch,
			asset: name,
			size: asset.size,
			dest: shownDest,
		});
		if (!(await ctx.ui.confirm(title, message))) {
			say(ctx, "Boost installation cancelled.");
			return;
		}
		say(ctx, `Downloading ${name}…`);
		let version: BoostVersion;
		try {
			version = await binaryOnly(ctx, asset, name);
		} catch (error) {
			const step = error instanceof StepError ? error.step : "install";
			const output = error instanceof StepError ? error.output : "";
			say(ctx, failureText(step, (error as Error).message, output), "error");
			return;
		}
		await afterInstall(ctx, { path: dest, version });
	}

	async function runOfficial(ctx: ExtensionCommandContext): Promise<void> {
		if (!(await ctx.ui.confirm("Run JFrog's official installer?", OFFICIAL_CONFIRM_MESSAGE))) {
			say(ctx, "Boost installation cancelled.");
			return;
		}
		say(ctx, "Running JFrog's installer…");
		const result = await pi.exec("bash", ["-c", OFFICIAL_SCRIPT], {
			timeout: OFFICIAL_TIMEOUT_MS,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (result.code !== 0) {
			say(
				ctx,
				failureText("the official installer", `exited ${result.code}`, `${result.stdout}\n${result.stderr}`),
				"error",
			);
			return;
		}
		await afterInstall(ctx);
	}

	return async function install(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const force = args.split(/\s+/).includes("--force");
		const existing = host.binary();
		// Decided on a settled, unmasked verdict: right at startup the probe may
		// still be running, and with the session off the UI state says nothing
		// about the binary — either way a too-old Boost would pass for current.
		const state: ReadinessState = existing
			? await verdict(existing, await host.current())
			: { kind: "missing" };
		if (existing && state.kind === "ready" && !force) {
			say(
				ctx,
				`JFrog Boost v${formatVersion(state.version)} is installed at ${existing}. /boost install --force reinstalls it.`,
			);
			return;
		}
		const problem = existing && state.kind !== "ready" ? problemText(state) : undefined;
		if (platform === "win32") {
			say(ctx, problem ? `JFrog Boost at ${existing} ${problem}.\n${WINDOWS_TEXT}` : WINDOWS_TEXT);
			return;
		}
		if (!ctx.hasUI) {
			const commands = commandsText(release, shownDest);
			say(ctx, problem ? `JFrog Boost at ${existing} ${problem}.\n${commands}` : commands);
			return;
		}
		const title =
			state.kind === "too-old"
				? "Update JFrog Boost"
				: problem
					? `Reinstall JFrog Boost — the one at ${existing} ${problem}`
					: "Install JFrog Boost";
		const choice = await ctx.ui.select(title, [...INSTALL_OPTIONS]);
		if (choice === OPTION_BINARY) await runBinaryOnly(ctx);
		else if (choice === OPTION_OFFICIAL) await runOfficial(ctx);
		else if (choice === OPTION_COMMANDS) say(ctx, commandsText(release, shownDest));
		else say(ctx, "Boost installation cancelled.");
	};
}
