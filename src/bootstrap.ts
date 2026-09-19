/**
 * One-time bootstrap: make sure the JFrog Boost binary exists.
 *
 * pi awaits an async extension factory before the session starts, so a
 * missing Boost binary is installed here — using the official installer
 * exactly as documented at https://boost.jfrog.com/llms-install.txt:
 *
 *   curl -fsSL https://boost.jfrog.com/install.sh | bash
 *   boost init --accept-terms
 *
 * Opt out with PI_JFROG_BOOST_AUTOINSTALL=0 (or BOOST_AUTOINSTALL=0) —
 * then the extension simply fail-opens until Boost is installed manually.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { boostBinaryPath } from "./boost-client.js";

const INSTALL_SCRIPT_URL = "https://boost.jfrog.com/install.sh";
const INSTALL_TIMEOUT_MS = 180_000;
const PREFIX = "[pi-jfrog-boost]";

function log(message: string): void {
	console.error(`${PREFIX} ${message}`);
}

function autoInstallDisabled(): boolean {
	return (
		process.env.PI_JFROG_BOOST_AUTOINSTALL === "0" ||
		process.env.BOOST_AUTOINSTALL === "0"
	);
}

/** Run a shell command, capturing combined output. Never throws. */
function sh(command: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (d: Buffer) => (output += d.toString()));
		child.stderr.on("data", (d: Buffer) => (output += d.toString()));
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: null, output });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

/** Editor flags for the non-interactive `boost init --accept-terms` call. */
function detectEditorFlags(): string[] {
	const home = process.env.HOME ?? "";
	const flags: string[] = [];
	if (existsSync(`${home}/.claude`)) flags.push("--claude");
	if (existsSync(`${home}/.cursor`)) flags.push("--cursor");
	if (existsSync(`${home}/.codex`)) flags.push("--codex");
	if (existsSync(`${home}/.config/opencode`)) flags.push("--opencode");
	return flags;
}

/**
 * Install Boost if the binary is missing. Returns true when Boost is
 * available afterwards. Idempotent; every failure is non-fatal (the
 * extension fail-opens without Boost).
 */
export async function ensureBoostInstalled(): Promise<boolean> {
	if (existsSync(boostBinaryPath())) return true;
	if (autoInstallDisabled()) {
		log(`Boost not found at ${boostBinaryPath()} and auto-install is disabled`);
		return false;
	}

	log(`Boost not found at ${boostBinaryPath()} — installing via the official installer…`);
	const install = await sh(`curl -fsSL ${INSTALL_SCRIPT_URL} | bash`, INSTALL_TIMEOUT_MS);
	if (!existsSync(boostBinaryPath())) {
		log(`Boost installation did not produce ${boostBinaryPath()} (exit ${install.code}). Install manually: https://boost.jfrog.com/llms-install.txt`);
		return false;
	}
	log("Boost installed.");

	// Record the Online Preview Agreement and wire detected editors.
	// boost init without target flags is interactive, so pass explicit flags;
	// with no detected editors, skip init — the binary works without it.
	const flags = detectEditorFlags();
	if (flags.length > 0) {
		const init = await sh(`"${boostBinaryPath()}" init --accept-terms ${flags.join(" ")}`, 60_000);
		if (init.code === 0) {
			log(`Boost initialized (${flags.join(" ")}) — terms accepted.`);
		} else {
			log(`boost init exited ${init.code}; run 'boost init --accept-terms' manually.`);
		}
	}
	return true;
}
