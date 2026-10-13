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
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReadinessState } from "../src/health.ts";
import {
	commandsText,
	confirmText,
	createInstaller,
	findAsset,
	INSTALL_COMMAND,
	INSTALL_OPTIONS,
	type InstallHost,
	OFFICIAL_TIMEOUT_MS,
	releasePlatform,
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
	state?: ReadinessState;
	binary?: string;
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

	const stub = createPiStub({
		hasUI: options.hasUI ?? true,
		...(options.ui ? { ui: options.ui } : {}),
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
	const fakeFetch = (async (url: string | URL) => {
		fetched.push(String(url));
		if (String(url).includes("api.github.com")) {
			return typeof api === "function" ? (api as () => Response)() : Response.json(api);
		}
		return new Response(new Uint8Array(options.body ?? ARCHIVE));
	}) as typeof fetch;

	const host: InstallHost = {
		binary: () => installed,
		state: () => options.state ?? { kind: "missing" },
		async refresh() {
			refreshed++;
			if (existsSync(dest)) installed = dest;
			return installed ? { kind: "ready", version: [0, 15, 4] } : { kind: "missing" };
		},
		onPath: () => false,
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
		verify: async () => call("boost v0.15.4 (abc)\n"),
		print: (_ctx, text) => printed.push(text),
	});
	const run = (args = "") => install(args, stub.ctx() as ExtensionCommandContext);
	return {
		stub,
		run,
		dest,
		work,
		fetched,
		printed,
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
