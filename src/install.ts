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
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, arch as osArch, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type BoostVersion, formatVersion, parseBoostVersion } from "./boost-binary.ts";
import { createProcessRunner, type RunResult } from "./boost-process.ts";
import type { ReadinessState } from "./health.ts";

export const INSTALL_URL = "https://boost.jfrog.com/install.sh";
export const INSTALL_DOCS = "https://boost.jfrog.com/llms-install.txt";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | bash`;
export const RELEASES_API = "https://api.github.com/repos/jfrog/boost/releases/latest";
export const RELEASES_PAGE = "https://github.com/jfrog/boost/releases/latest";
/** Every asset URL must start with this; anything else falls back to the commands text. */
const DOWNLOAD_PREFIX = "https://github.com/jfrog/boost/releases/download/";
export const TERMS_URL = "https://boost.jfrog.com/preview-agreement/";
export const WINDOWS_COMMAND = "irm https://raw.githubusercontent.com/jfrog/boost/main/install.ps1 | iex";

/** The GitHub API answers in well under a second; 15 s covers a slow link without hanging the command. */
export const LOOKUP_TIMEOUT_MS = 15_000;
/** The archive is ~10–20 MB. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const EXTRACT_TIMEOUT_MS = 30_000;
export const OFFICIAL_TIMEOUT_MS = 180_000;
export const VERIFY_TIMEOUT_MS = 8_000;
/**
 * The download is refused past this size. Boost's archives are ~15 MB; a
 * response many times that is not the release asset, and must not be allowed
 * to fill the user's temp disk before the checksum could reject it.
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

/** `~/…` for a path under `home`, for messages. */
export function tildePath(path: string, home: string): string {
	if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
	return path;
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
	/** Whether GitHub publishes a SHA-256 digest for the asset. */
	verified: boolean;
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
	const check = view.verified
		? "check it against the SHA-256 GitHub publishes for it"
		: "NOTE: GitHub publishes no checksum for this asset, so it cannot be verified";
	return {
		title: `Install JFrog Boost ${view.tag} for ${view.os}/${view.arch}?`,
		message: [
			`pi-jfrog-boost will download ${view.asset} (${formatSize(view.size)}) from github.com/jfrog/boost,`,
			`${check},`,
			`and place the boost binary at ${view.dest}. That is all it does:`,
			"  • it does not run JFrog's install.sh",
			"  • it does not change your shell startup files or PATH",
			"  • it does not run `boost init`, so no hooks are added to other agents",
			"  • it does not accept JFrog's Preview Agreement for you",
			"",
			"Shell and MCP compaction work right away. PDF/Office conversion needs the",
			"agreement: in a terminal run `boost init --dry-run`, then `boost init`.",
			`Terms: ${TERMS_URL}`,
		].join("\n"),
	};
}

/** What JFrog's installer does, said before it runs (NP7). */
export const OFFICIAL_CONFIRM_MESSAGE = [
	"This runs JFrog's official installer, unchanged, in your real environment:",
	"",
	`    ${INSTALL_COMMAND}`,
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
		`  3. tar -xzf ${asset} boost && mkdir -p ${dirnameOf(dest)} && mv boost ${dest} && chmod 0755 ${dest}`,
		`  4. ${dest} version`,
		"Or JFrog's official installer (it may edit your shell rc files and, when ~/.local/bin is on PATH,",
		"run `boost init --accept-terms`, which accepts the Preview Agreement for you and adds hooks to other agents):",
		`  ${INSTALL_COMMAND}`,
		`Then /boost status. Docs: ${INSTALL_DOCS}`,
	];
	return lines.join("\n");
}

function dirnameOf(path: string): string {
	const at = path.lastIndexOf("/");
	return at > 0 ? path.slice(0, at) : path;
}

// ---------------------------------------------------------------------------
// The release lookup

export interface ReleaseAsset {
	tag: string;
	url: string;
	size: number;
	/** Lower-case hex SHA-256, when GitHub publishes one (`digest: "sha256:<hex>"`). */
	sha256?: string;
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
	const url = asset.browser_download_url;
	// Only JFrog's own release downloads: a redirect elsewhere is fetch's to
	// follow, but the starting point is never taken from anywhere else.
	if (typeof url !== "string" || !url.startsWith(DOWNLOAD_PREFIX)) return `${name} has no download URL`;
	const size = typeof asset.size === "number" && asset.size > 0 ? asset.size : 0;
	if (size === 0 || size > MAX_DOWNLOAD_BYTES) return `${name} has no plausible size`;
	const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null;
	return { tag, url, size, ...(digest ? { sha256: (digest[1] as string).toLowerCase() } : {}) };
}

// ---------------------------------------------------------------------------
// The command

/** What the install flow needs from the rest of the extension. */
export interface InstallHost {
	/** The binary in use now, resolved afresh. */
	binary(): string | undefined;
	/** Readiness as the UI reports it (the version, too old, …). */
	state(): ReadinessState;
	/**
	 * Re-resolve the binary, re-probe it, re-read Boost's config and repaint
	 * the footer; resolves with the state the probe settled on.
	 */
	refresh(): Promise<ReadinessState>;
	/** Whether `boost` typed in a shell finds this binary. */
	onPath(binary: string): boolean;
	/** Whether shell compaction is off by Boost's flag or default (not by the user's setting). */
	shellOffByBoost(): boolean;
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

/** `boost version` on the installed file, offline (FLAGS_DISABLE) and capped. */
async function defaultVerify(binary: string): Promise<RunResult> {
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

	/** Binary only (spec §11 steps 1–8). Returns the installed version, if `boost version` gave one. */
	async function binaryOnly(
		ctx: ExtensionCommandContext,
		asset: ReleaseAsset,
		name: string,
	): Promise<BoostVersion | undefined> {
		const work = await mkdtemp(join(deps.tmpdir ?? tmpdir(), "pi-jfrog-boost-install-"));
		try {
			const archive = join(work, name);
			const sha = await download(ctx, asset, archive);
			if (asset.sha256 && sha !== asset.sha256) {
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
			try {
				await mkdir(dirnameOf(dest), { recursive: true, mode: 0o755 });
				await copyFile(extracted, staged);
				await chmod(staged, 0o755);
				await rename(staged, dest);
			} catch (error) {
				await rm(staged, { force: true }).catch(() => {});
				throw new StepError("install", (error as Error).message);
			}
			const run = await verify(dest);
			const version = parseBoostVersion(run.stdout);
			if (run.code !== 0 || !version) {
				throw new StepError(
					"verify",
					run.timedOut ? "`boost version` timed out" : `\`boost version\` exited ${run.code}`,
					run.stdout,
				);
			}
			return version;
		} finally {
			await rm(work, { recursive: true, force: true }).catch(() => {});
		}
	}

	/** The report after either option (spec §11 "After either option"). */
	async function afterInstall(ctx: ExtensionCommandContext, installedVersion?: BoostVersion): Promise<void> {
		const state = await host.refresh();
		const binary = host.binary();
		if (!binary) {
			say(ctx, failureText("install", "no boost binary was found afterwards", ""), "error");
			return;
		}
		const version =
			installedVersion ?? ("version" in state ? (state as { version: BoostVersion }).version : undefined);
		const lines = [`Installed JFrog Boost ${version ? `v${formatVersion(version)} ` : ""}at ${binary}.`];
		let onPathNow = true;
		try {
			onPathNow = host.onPath(binary);
		} catch {
			/* say nothing rather than something wrong */
		}
		if (!onPathNow) {
			lines.push("~/.local/bin isn't on your PATH; pi still finds Boost and gives the model the full path.");
		}
		if (host.shellOffByBoost()) {
			lines.push(
				"Boost's shell-output compaction is off (Boost's default since v0.14.6). Documents and MCP results are still handled. To turn it on for pi: /boost settings → Shell output.",
			);
		}
		if (!host.termsAccepted()) {
			lines.push(
				"PDF/Office conversion needs Boost's Preview Agreement: in a terminal run `boost init --dry-run`, then `boost init`.",
			);
		}
		say(ctx, lines.join("\n"), "info");
	}

	async function runBinaryOnly(ctx: ExtensionCommandContext): Promise<void> {
		if (!release) {
			say(ctx, commandsText(undefined, shownDest));
			return;
		}
		const name = assetName(release.os, release.arch);
		const asset = await lookup(ctx, name);
		if (typeof asset === "string") {
			say(
				ctx,
				`Could not look up the Boost release (${asset}).\n${commandsText(release, shownDest)}`,
				"warning",
			);
			return;
		}
		const { title, message } = confirmText({
			tag: asset.tag,
			os: release.os,
			arch: release.arch,
			asset: name,
			size: asset.size,
			verified: asset.sha256 !== undefined,
			dest: shownDest,
		});
		if (!(await ctx.ui.confirm(title, message))) {
			say(ctx, "Boost installation cancelled.");
			return;
		}
		say(ctx, `Downloading ${name}…`);
		let version: BoostVersion | undefined;
		try {
			version = await binaryOnly(ctx, asset, name);
		} catch (error) {
			const step = error instanceof StepError ? error.step : "install";
			const output = error instanceof StepError ? error.output : "";
			say(ctx, failureText(step, (error as Error).message, output), "error");
			return;
		}
		await afterInstall(ctx, version);
	}

	async function runOfficial(ctx: ExtensionCommandContext): Promise<void> {
		if (!(await ctx.ui.confirm("Run JFrog's official installer?", OFFICIAL_CONFIRM_MESSAGE))) {
			say(ctx, "Boost installation cancelled.");
			return;
		}
		say(ctx, "Running JFrog's installer…");
		const result = await pi.exec("bash", ["-c", INSTALL_COMMAND], {
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
		const state = host.state();
		const tooOld = state.kind === "too-old";
		if (existing && !tooOld && !force) {
			const version = "version" in state ? ` v${formatVersion(state.version)}` : "";
			say(ctx, `JFrog Boost${version} is installed at ${existing}. /boost install --force reinstalls it.`);
			return;
		}
		if (platform === "win32") {
			say(ctx, WINDOWS_TEXT);
			return;
		}
		if (!ctx.hasUI) {
			say(ctx, commandsText(release, shownDest));
			return;
		}
		const title = tooOld ? "Update JFrog Boost" : "Install JFrog Boost";
		const choice = await ctx.ui.select(title, [...INSTALL_OPTIONS]);
		if (choice === OPTION_BINARY) await runBinaryOnly(ctx);
		else if (choice === OPTION_OFFICIAL) await runOfficial(ctx);
		else if (choice === OPTION_COMMANDS) say(ctx, commandsText(release, shownDest));
		else say(ctx, "Boost installation cancelled.");
	};
}
