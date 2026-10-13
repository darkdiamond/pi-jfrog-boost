/**
 * `/boost install` (spec §11), driven end to end with a fake GitHub (an
 * injected `fetch`), a fake `tar` (the pi stub's `exec`) and a fake
 * `boost version`, against real temp directories — so the checksum, the
 * atomic placement and the clean-up are the real code paths.
 *
 * What must never happen is held as tightly as what should: the binary-only
 * option never runs install.sh, curl, bash or sh; Windows and print mode
 * never run anything; a checksum mismatch never leaves a binary behind.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunResult } from "../src/boost-process.ts";
import type { ReadinessState } from "../src/health.ts";
import {
	commandsText,
	confirmText,
	createInstaller,
	defaultVerify,
	findAsset,
	INSTALL_COMMAND,
	INSTALL_OPTIONS,
	type InstallHost,
	OFFICIAL_TIMEOUT_MS,
	releasePlatform,
	tildePath,
	WINDOWS_TEXT,
} from "../src/install.ts";
import { createPiStub, type PiStubOptions } from "./helpers/harness.ts";
import { call } from "./helpers/runtime.ts";

const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-install-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const GOLDEN = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "fixtures", "install-confirm.golden.txt"),
	"utf8",
).replace(/\r\n/g, "\n");

const ARCHIVE = Buffer.from("not really a tarball, the fake tar ignores it");
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const ASSET_URL = "https://github.com/jfrog/boost/releases/download/v0.15.4/boost-darwin-arm64.tar.gz";

function release(asset: Partial<Record<string, unknown>> = {}) {
	return {
		tag_name: "v0.15.4",
		assets: [
			{
				name: "boost-linux-amd64.tar.gz",
				browser_download_url: ASSET_URL.replace("darwin-arm64", "linux-amd64"),
			},
			{
				name: "boost-darwin-arm64.tar.gz",
				browser_download_url: ASSET_URL,
				size: ARCHIVE.length,
				digest: `sha256:${SHA}`,
				...asset,
			},
		],
	};
}

interface Setup {
	ui?: PiStubOptions["ui"];
	hasUI?: boolean;
	platform?: NodeJS.Platform;
	arch?: string;
	/** What the GitHub API answers; a function may throw. */
	api?: unknown | (() => Response);
	/** Bytes the download serves. */
	body?: Buffer;
	/** What the fake tar does: write a regular file (default), fail, a symlink, or nothing. */
	tar?: "ok" | "fail" | "symlink" | "empty";
	/** What the host's settled readiness says (default: missing). */
	state?: ReadinessState;
	binary?: string;
	/**
	 * After the refresh, pi resolves this binary in that state instead of the
	 * new file — BOOST_BIN/BOOST_EXE pointing at an older build.
	 */
	inUse?: { binary: string; state: ReadinessState };
	/** What `boost version` answers, per binary (default: v0.15.4). */
	verify?: (binary: string) => Promise<RunResult>;
	/** Serves the asset download instead of the in-memory archive. */
	download?: (init: RequestInit | undefined) => Response | Promise<Response>;
	downloadTimeoutMs?: number;
	lookupTimeoutMs?: number;
	signal?: AbortSignal;
	onPath?: boolean;
}

function setup(options: Setup = {}) {
	const dir = join(root, `case-${++n}`);
	const home = join(dir, "home");
	const work = join(dir, "tmp");
	mkdirSync(home, { recursive: true });
	mkdirSync(work, { recursive: true });
	const dest = join(home, ".local", "bin", "boost");
	const fetched: string[] = [];
	const printed: string[] = [];
	let refreshed = 0;
	let installed: string | undefined = options.binary;
	let refreshedState: ReadinessState | undefined;
	const verified: string[] = [];

	const stub = createPiStub({
		hasUI: options.hasUI ?? true,
		...(options.ui ? { ui: options.ui } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		exec: async (command, args) => {
			if (command !== "tar") return { stdout: "", stderr: "", code: 0, killed: false };
			const into = args[args.indexOf("-C") + 1] as string;
			const mode = options.tar ?? "ok";
			if (mode === "fail") {
				return {
					stdout: "",
					stderr: "tar: zero\ntar: one\ntar: two\ntar: Error is not recoverable\n",
					code: 2,
					killed: false,
				};
			}
			if (mode === "symlink") symlinkSync("/bin/sh", join(into, "boost"));
			if (mode === "ok") writeFileSync(join(into, "boost"), "#!/bin/sh\necho boost v0.15.4\n");
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	});

	const api = options.api === undefined ? release() : options.api;
	const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
		fetched.push(String(url));
		if (String(url).includes("api.github.com")) {
			return typeof api === "function"
				? (api as (init?: RequestInit) => Response | Promise<Response>)(init)
				: Response.json(api);
		}
		if (options.download) return options.download(init);
		return new Response(new Uint8Array(options.body ?? ARCHIVE));
	}) as typeof fetch;

	const host: InstallHost = {
		binary: () => installed,
		current: async () => refreshedState ?? options.state ?? { kind: "missing" },
		async refresh(ctx) {
			assert.ok(ctx, "refresh gets the context whose footer it repaints");
			refreshed++;
			if (options.inUse) {
				installed = options.inUse.binary;
				refreshedState = options.inUse.state;
			} else {
				if (existsSync(dest)) installed = dest;
				refreshedState = installed ? { kind: "ready", version: [0, 15, 4] } : { kind: "missing" };
			}
			return refreshedState;
		},
		onPath: () => options.onPath ?? false,
		shellOffByBoost: () => true,
		termsAccepted: () => false,
	};

	const install = createInstaller(stub.pi, host, {
		platform: options.platform ?? "darwin",
		arch: options.arch ?? "arm64",
		fetch: fakeFetch,
		home,
		dest,
		tmpdir: work,
		verify: async (binary) => {
			verified.push(binary);
			return options.verify ? options.verify(binary) : call("boost v0.15.4 (abc)\n");
		},
		print: (_ctx, text) => printed.push(text),
		...(options.downloadTimeoutMs ? { downloadTimeoutMs: options.downloadTimeoutMs } : {}),
		...(options.lookupTimeoutMs ? { lookupTimeoutMs: options.lookupTimeoutMs } : {}),
	});
	const run = (args = "") => install(args, stub.ctx() as ExtensionCommandContext);
	return {
		stub,
		run,
		dest,
		work,
		fetched,
		printed,
		verified,
		refreshes: () => refreshed,
		notices: () => stub.ui.notices.map((x) => x.message),
	};
}

const BINARY = INSTALL_OPTIONS[0];
const OFFICIAL = INSTALL_OPTIONS[1];
const COMMANDS = INSTALL_OPTIONS[2];

/** Nothing the binary-only flow runs may be a shell or JFrog's script. */
function assertNoShell(execCalls: { command: string; args: string[] }[]) {
	for (const c of execCalls) {
		assert.ok(!["bash", "sh", "curl", "zsh"].includes(c.command), `ran ${c.command}`);
		assert.ok(!c.args.join(" ").includes("install.sh"), `ran ${c.command} ${c.args.join(" ")}`);
	}
}

test("platforms map to Boost's release assets; others have none", () => {
	assert.deepEqual(releasePlatform("darwin", "arm64"), { os: "darwin", arch: "arm64" });
	assert.deepEqual(releasePlatform("darwin", "x64"), { os: "darwin", arch: "amd64" });
	assert.deepEqual(releasePlatform("linux", "x64"), { os: "linux", arch: "amd64" });
	assert.deepEqual(releasePlatform("linux", "arm64"), { os: "linux", arch: "arm64" });
	assert.equal(releasePlatform("linux", "ia32"), undefined);
	assert.equal(releasePlatform("freebsd", "x64"), undefined);
	assert.equal(releasePlatform("win32", "x64"), undefined);
});

test("the confirm text is the golden text, verified and unverified", () => {
	const base = {
		tag: "v0.15.4",
		os: "darwin",
		arch: "arm64",
		asset: "boost-darwin-arm64.tar.gz",
		size: 14_234_567,
		dest: "~/.local/bin/boost",
	};
	const render = (verified: boolean) => {
		const t = confirmText({ ...base, verified });
		return `${t.title}\n\n${t.message}\n`;
	};
	assert.equal(`# verified\n${render(true)}# unverified\n${render(false)}`, GOLDEN);
});

test("the asset lookup reads tag, URL, size and digest, defensively", () => {
	const found = findAsset(release(), "boost-darwin-arm64.tar.gz");
	assert.deepEqual(found, { tag: "v0.15.4", url: ASSET_URL, size: ARCHIVE.length, sha256: SHA });
	const noDigest = findAsset(release({ digest: undefined }), "boost-darwin-arm64.tar.gz");
	assert.equal(typeof noDigest === "object" && noDigest.sha256, undefined);
	assert.equal(typeof findAsset(release(), "boost-linux-arm64.tar.gz"), "string", "missing asset");
	assert.equal(
		typeof findAsset(
			release({ browser_download_url: "https://evil.example/boost.tar.gz" }),
			"boost-darwin-arm64.tar.gz",
		),
		"string",
		"only JFrog's release downloads",
	);
	assert.equal(typeof findAsset({ tag_name: "latest", assets: [] }, "x"), "string");
	assert.equal(typeof findAsset(null, "x"), "string");
});

test("binary only: confirmed, verified, placed atomically, refreshed, temp removed", async () => {
	const s = setup({ ui: { select: [BINARY], confirm: [true] } });
	await s.run();
	assert.deepEqual(s.stub.ui.selects[0]?.title, "Install JFrog Boost");
	const confirm = s.stub.ui.confirms[0];
	assert.equal(confirm?.title, "Install JFrog Boost v0.15.4 for darwin/arm64?");
	assert.match(confirm?.message ?? "", /check it against the SHA-256 GitHub publishes for it,/);
	assert.match(confirm?.message ?? "", /place the boost binary at ~\/\.local\/bin\/boost\./);
	assert.equal(readFileSync(s.dest, "utf8"), "#!/bin/sh\necho boost v0.15.4\n");
	if (process.platform !== "win32") assert.equal(statSync(s.dest).mode & 0o777, 0o755);
	assert.deepEqual(readdirSync(dirname(s.dest)), ["boost"], "no staging file left next to it");
	assert.deepEqual(readdirSync(s.work), [], "the temp directory is removed");
	assert.deepEqual(s.verified, [`${s.dest}.tmp-${process.pid}`], "verified while staged, before the rename");
	assert.equal(s.refreshes(), 1);
	assert.deepEqual(
		s.stub.execCalls.map((c) => c.command),
		["tar"],
	);
	const tar = s.stub.execCalls[0];
	assert.deepEqual(tar?.args.slice(0, 1), ["-xzf"]);
	assert.equal(tar?.args.at(-1), "boost", "only the one member is extracted");
	assert.equal((tar?.options as { timeout?: number } | undefined)?.timeout, 30_000);
	assertNoShell(s.stub.execCalls);
	assert.deepEqual(s.fetched, ["https://api.github.com/repos/jfrog/boost/releases/latest", ASSET_URL]);
	const done = s.notices().at(-1) ?? "";
	assert.match(
		done,
		new RegExp(`^Installed JFrog Boost v0\\.15\\.4 at ${s.dest.replace(/[\\.]/g, "\\$&")}\\.`),
	);
	assert.match(done, /~\/\.local\/bin isn't on your PATH; pi still finds Boost/);
	assert.match(done, /\/boost settings → Shell output/);
	assert.match(done, /boost init --dry-run/);
});

test("binary only without a published digest says so in the confirm", async () => {
	const s = setup({ ui: { select: [BINARY], confirm: [false] }, api: release({ digest: undefined }) });
	await s.run();
	assert.match(s.stub.ui.confirms[0]?.message ?? "", /NOTE: GitHub publishes no checksum for this asset/);
});

test("cancelling the confirm downloads and runs nothing", async () => {
	const s = setup({ ui: { select: [BINARY], confirm: [false] } });
	await s.run();
	assert.deepEqual(s.fetched, ["https://api.github.com/repos/jfrog/boost/releases/latest"]);
	assert.equal(s.stub.execCalls.length, 0);
	assert.equal(existsSync(s.dest), false);
	assert.equal(s.refreshes(), 0);
	assert.match(s.notices().at(-1) ?? "", /cancelled/);
});

test("cancel and escape at the menu run nothing", async () => {
	for (const answer of [INSTALL_OPTIONS[3], undefined]) {
		const s = setup({ ui: { select: [answer] } });
		await s.run();
		assert.equal(s.fetched.length, 0);
		assert.equal(s.stub.execCalls.length, 0);
	}
});

test("a checksum mismatch aborts before tar, leaves no binary and cleans up", async () => {
	const s = setup({ ui: { select: [BINARY], confirm: [true] }, body: Buffer.from(ARCHIVE).fill(0x41) });
	await s.run();
	assert.equal(s.stub.execCalls.length, 0, "tar never ran");
	assert.equal(existsSync(s.dest), false);
	assert.deepEqual(readdirSync(s.work), []);
	assert.equal(s.refreshes(), 0);
	const message = s.notices().at(-1) ?? "";
	assert.match(message, /checksum failed/);
	assert.match(message, /https:\/\/boost\.jfrog\.com\/llms-install\.txt/);
	assert.equal(s.stub.ui.notices.at(-1)?.level, "error");
});

test("a download of the wrong size is refused even without a digest", async () => {
	const s = setup({
		ui: { select: [BINARY], confirm: [true] },
		api: release({ digest: undefined }),
		body: Buffer.concat([ARCHIVE, Buffer.from("extra")]),
	});
	await s.run();
	assert.equal(existsSync(s.dest), false);
	assert.match(s.notices().at(-1) ?? "", /download failed/);
	assert.deepEqual(readdirSync(s.work), []);
});

test("a missing asset or a failed lookup falls back to the commands text", async () => {
	const missing = setup({ ui: { select: [BINARY] }, api: { tag_name: "v0.15.4", assets: [] } });
	await missing.run();
	assert.equal(missing.stub.ui.confirms.length, 0);
	assert.match(missing.notices().at(-1) ?? "", /has no boost-darwin-arm64\.tar\.gz/);
	assert.match(missing.notices().at(-1) ?? "", /To install JFrog Boost yourself/);

	const down = setup({
		ui: { select: [BINARY] },
		api: () => {
			throw new Error("getaddrinfo ENOTFOUND api.github.com");
		},
	});
	await down.run();
	assert.match(down.notices().at(-1) ?? "", /ENOTFOUND[\s\S]*To install JFrog Boost yourself/);

	const rateLimited = setup({ ui: { select: [BINARY] }, api: () => new Response("{}", { status: 403 }) });
	await rateLimited.run();
	assert.match(rateLimited.notices().at(-1) ?? "", /GitHub answered 403/);
	for (const s of [missing, down, rateLimited]) assert.equal(s.stub.execCalls.length, 0);
});

test("an architecture Boost does not ship falls back to the commands text", async () => {
	const s = setup({ ui: { select: [BINARY] }, arch: "ia32" });
	await s.run();
	assert.equal(s.fetched.length, 0);
	assert.match(s.notices().at(-1) ?? "", /boost-<os>-<arch>\.tar\.gz/);
});

test("a tar failure reports the step and its last lines, and cleans up", async () => {
	const s = setup({ ui: { select: [BINARY], confirm: [true] }, tar: "fail" });
	await s.run();
	const message = s.notices().at(-1) ?? "";
	assert.match(message, /extract failed \(tar exited 2\)/);
	assert.match(message, /tar: one\ntar: two\ntar: Error is not recoverable/);
	assert.doesNotMatch(message, /tar: zero/, "only the last 3 lines");
	assert.equal(existsSync(s.dest), false);
	assert.deepEqual(readdirSync(s.work), []);
});

test("an archive without a regular boost file is refused", async (t) => {
	if (process.platform === "win32") t.skip("symlinks need privileges on Windows");
	for (const tar of ["symlink", "empty"] as const) {
		const s = setup({ ui: { select: [BINARY], confirm: [true] }, tar });
		await s.run();
		assert.match(s.notices().at(-1) ?? "", /no regular file named boost/);
		assert.equal(existsSync(s.dest), false);
		assert.deepEqual(readdirSync(s.work), []);
	}
});

test("the official installer is confirmed with what it really does, then run as is", async () => {
	const s = setup({ ui: { select: [OFFICIAL], confirm: [true] } });
	await s.run();
	const confirm = s.stub.ui.confirms[0]?.message ?? "";
	assert.match(confirm, /boost init --accept-terms/);
	assert.match(confirm, /accepts JFrog's Preview Agreement on your\nbehalf/);
	assert.match(confirm, /Claude Code, Cursor, Codex, Copilot and\nOpenCode/);
	const run = s.stub.execCalls[0];
	assert.equal(run?.command, "bash");
	assert.deepEqual(run?.args, ["-c", INSTALL_COMMAND]);
	assert.equal((run?.options as { timeout?: number } | undefined)?.timeout, OFFICIAL_TIMEOUT_MS);
	assert.equal(s.fetched.length, 0, "no GitHub lookup for this option");
	assert.equal(s.refreshes(), 1);
});

test("declining the official installer's confirm runs nothing", async () => {
	const s = setup({ ui: { select: [OFFICIAL], confirm: [false] } });
	await s.run();
	assert.equal(s.stub.execCalls.length, 0);
});

test("show the commands prints them and runs nothing", async () => {
	const s = setup({ ui: { select: [COMMANDS] } });
	await s.run();
	assert.equal(s.stub.execCalls.length, 0);
	assert.equal(s.fetched.length, 0);
	assert.equal(s.notices().at(-1), commandsText({ os: "darwin", arch: "arm64" }, "~/.local/bin/boost"));
});

test("Windows only ever gets text", async () => {
	const s = setup({ platform: "win32", arch: "x64", ui: { select: [BINARY], confirm: [true] } });
	await s.run();
	assert.deepEqual(s.notices(), [WINDOWS_TEXT]);
	assert.equal(s.stub.ui.selects.length, 0);
	assert.equal(s.stub.execCalls.length, 0);
	assert.equal(s.fetched.length, 0);
});

test("without a UI the steps are printed and nothing runs", async () => {
	const s = setup({ hasUI: false });
	await s.run();
	assert.equal(s.stub.execCalls.length, 0);
	assert.equal(s.fetched.length, 0);
	assert.equal(s.printed.length, 1);
	assert.match(
		s.printed[0] ?? "",
		/boost-darwin-arm64\.tar\.gz[\s\S]*curl -fsSL https:\/\/boost\.jfrog\.com\/install\.sh \| bash/,
	);
});

test("an installed, working Boost is reported; --force offers a reinstall", async () => {
	const s = setup({
		binary: "/opt/boost",
		state: { kind: "ready", version: [0, 15, 4] },
		ui: { select: [undefined] },
	});
	await s.run();
	assert.equal(s.stub.ui.selects.length, 0);
	assert.match(
		s.notices()[0] ?? "",
		/JFrog Boost v0\.15\.4 is installed at \/opt\/boost\. \/boost install --force/,
	);
	await s.run("--force");
	assert.equal(s.stub.ui.selects[0]?.title, "Install JFrog Boost");
});

test("a Boost too old to use gets the menu titled Update", async () => {
	const s = setup({
		binary: "/opt/boost",
		state: { kind: "too-old", version: [0, 12, 1] },
		ui: { select: [undefined] },
	});
	await s.run();
	assert.equal(s.stub.ui.selects[0]?.title, "Update JFrog Boost");
});

test("paths are shortened to ~/… with the platform's separator, and only under home", () => {
	const home = join(root, "home-x");
	assert.equal(tildePath(join(home, ".local", "bin", "boost"), home), "~/.local/bin/boost");
	assert.equal(tildePath(home, home), "~");
	assert.equal(tildePath(`${home}2${sep}boost`, home), `${home}2${sep}boost`, "a sibling is not under home");
	assert.equal(tildePath(join(root, "elsewhere", "boost"), home), join(root, "elsewhere", "boost"));
	assert.equal(tildePath("/opt/boost", ""), "/opt/boost");
});

test("a binary that fails `boost version` is never placed, and an existing one is kept", async () => {
	const s = setup({
		binary: "/opt/boost",
		state: { kind: "too-old", version: [0, 12, 1] },
		ui: { select: [BINARY], confirm: [true] },
		verify: async (binary) =>
			binary.includes(".tmp-") ? call("dyld: Library not loaded\n", 1) : call("boost v0.12.1\n"),
	});
	mkdirSync(dirname(s.dest), { recursive: true });
	writeFileSync(s.dest, "the old one");
	await s.run();
	assert.equal(readFileSync(s.dest, "utf8"), "the old one", "not replaced");
	assert.deepEqual(readdirSync(dirname(s.dest)), ["boost"], "no staging file left");
	assert.deepEqual(readdirSync(s.work), []);
	assert.equal(s.refreshes(), 0);
	const message = s.notices().at(-1) ?? "";
	assert.match(message, /^JFrog Boost was not installed: verify failed \(`boost version` exited 1\)/);
	assert.match(message, /dyld: Library not loaded/);
});

test("when BOOST_BIN wins over the new file, the report says so instead of claiming success", async () => {
	const old: ReadinessState = { kind: "too-old", version: [0, 12, 1] };
	const s = setup({
		binary: "/opt/old/boost",
		state: old,
		inUse: { binary: "/opt/old/boost", state: old },
		ui: { select: [BINARY], confirm: [true] },
	});
	await s.run();
	assert.equal(s.stub.ui.selects[0]?.title, "Update JFrog Boost");
	assert.equal(readFileSync(s.dest, "utf8"), "#!/bin/sh\necho boost v0.15.4\n", "the new file is placed");
	const done = s.stub.ui.notices.at(-1);
	assert.equal(done?.level, "warning");
	const message = done?.message ?? "";
	assert.doesNotMatch(message, /^Installed/);
	assert.ok(
		message.startsWith(
			`Placed JFrog Boost v0.15.4 at ${s.dest}, but pi uses /opt/old/boost (v0.12.1): BOOST_BIN or BOOST_EXE points there, or it is found first. Unset it, or point it at ${s.dest}.`,
		),
		message,
	);
	assert.match(message, /can't use it yet: it is v0\.12\.1, older than v0\.13\.13/);
	assert.match(
		message,
		new RegExp(`^${dirname("/opt/old/boost").replace(/[\\/.]/g, "\\$&")} isn't on your PATH`, "m"),
	);
	assert.doesNotMatch(
		message,
		/~\/\.local\/bin isn't on your PATH/,
		"the hint names the binary's own directory",
	);
	assert.doesNotMatch(message, /Shell output|boost init/, "no hints for a Boost pi cannot use");
});

test("the installed-and-current check asks the binary when readiness has no verdict", async () => {
	for (const kind of ["disabled", "probing"] as const) {
		const old = setup({
			binary: "/opt/boost",
			state: { kind },
			ui: { select: [undefined] },
			verify: async () => call("boost v0.12.1\n"),
		});
		await old.run();
		assert.deepEqual(old.verified, ["/opt/boost"]);
		assert.equal(old.stub.ui.selects[0]?.title, "Update JFrog Boost", `${kind}: too old is not current`);

		const current = setup({ binary: "/opt/boost", state: { kind }, ui: { select: [undefined] } });
		await current.run();
		assert.equal(current.stub.ui.selects.length, 0);
		assert.match(current.notices()[0] ?? "", /JFrog Boost v0\.15\.4 is installed at \/opt\/boost/);
	}
});

test("a Boost that does not answer or prints no version is not called current", async () => {
	const silent = setup({
		binary: "/opt/boost",
		state: { kind: "not-responding" },
		ui: { select: [undefined] },
	});
	await silent.run();
	assert.equal(
		silent.stub.ui.selects[0]?.title,
		"Reinstall JFrog Boost — the one at /opt/boost does not answer `boost version`",
	);
	const odd = setup({ binary: "/opt/boost", state: { kind: "unknown-version" }, hasUI: false });
	await odd.run();
	assert.match(
		odd.printed[0] ?? "",
		/^JFrog Boost at \/opt\/boost prints a version pi-jfrog-boost cannot read\.\n/,
	);
});

test("a stalled download times out, installs nothing and cleans up", async () => {
	// AbortSignal.timeout is unref'd: something must keep the loop alive.
	const keep = setInterval(() => {}, 1_000);
	try {
		const s = setup({
			ui: { select: [BINARY], confirm: [true] },
			downloadTimeoutMs: 100,
			download: () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
		});
		await s.run();
		assert.match(s.notices().at(-1) ?? "", /download failed \(timed out\)/);
		assert.equal(existsSync(s.dest), false);
		assert.deepEqual(readdirSync(s.work), []);
		assert.equal(s.stub.execCalls.length, 0);
	} finally {
		clearInterval(keep);
	}
});

test("an aborted command (ctx.signal) stops the download and cleans up", async () => {
	const s = setup({ ui: { select: [BINARY], confirm: [true] }, signal: AbortSignal.abort() });
	await s.run();
	const message = s.notices().at(-1) ?? "";
	assert.match(message, /download failed/);
	assert.doesNotMatch(message, /timed out/, "the user's abort is not reported as a timeout");
	assert.equal(existsSync(s.dest), false);
	assert.deepEqual(readdirSync(s.work), []);
	assert.equal(s.stub.execCalls.length, 0);
});

test("a GitHub lookup that never answers times out to the commands text", async () => {
	const keep = setInterval(() => {}, 1_000);
	try {
		const s = setup({
			ui: { select: [BINARY] },
			lookupTimeoutMs: 50,
			api: (init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		});
		await s.run();
		const message = s.notices().at(-1) ?? "";
		assert.match(message, /^Could not look up the Boost release \(GitHub did not answer in time\)/);
		assert.match(message, /To install JFrog Boost yourself/);
		assert.equal(s.stub.ui.confirms.length, 0);
	} finally {
		clearInterval(keep);
	}
});

test("the default verify runs `<binary> version` with flag fetching disabled", async (t) => {
	if (process.platform === "win32") t.skip("a shell script stands in for boost");
	const dir = join(root, `verify-${++n}`);
	mkdirSync(dir);
	const script = join(dir, "boost");
	writeFileSync(script, '#!/bin/sh\necho "boost v0.15.4 args=$* flags=$BOOST_FEATURE_FLAGS_DISABLE"\n', {
		mode: 0o755,
	});
	const result = await defaultVerify(script);
	assert.equal(result.code, 0);
	assert.equal(result.stdout.trim(), "boost v0.15.4 args=version flags=1");
});
