/**
 * The `/boost-install` command.
 *
 * Installing Boost means running a script this package did not write, so it
 * happens only when the user asks for it and confirms the exact command first.
 * Nothing is installed at load time, no legal terms are accepted on the user's
 * behalf, and no other agent's configuration is touched.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BoostClient } from "./boost-client.ts";

export const COMMAND_NAME = "boost-install";
export const INSTALL_URL = "https://boost.jfrog.com/install.sh";
export const INSTALL_DOCS = "https://boost.jfrog.com/llms-install.txt";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | bash`;
const INSTALL_TIMEOUT_MS = 180_000;

const CONFIRM_BODY = [
	`This downloads and runs the official JFrog Boost installer:`,
	``,
	`    ${INSTALL_COMMAND}`,
	``,
	`It installs the boost binary under ~/.local/bin and nothing else — no hooks`,
	`are added to other agents, and no terms are accepted for you. Boost will ask`,
	`you to accept its Online Preview Agreement the first time it needs to.`,
	``,
	`Docs: ${INSTALL_DOCS}`,
].join("\n");

export interface InstallDeps {
	platform?: NodeJS.Platform;
}

export function registerInstallCommand(pi: ExtensionAPI, client: BoostClient, deps: InstallDeps = {}): void {
	const platform = deps.platform ?? process.platform;

	const handler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		client.refresh();
		const existing = client.binary();
		if (existing) {
			ctx.ui.notify(`JFrog Boost is already installed at ${existing}.`, "info");
			return;
		}

		// The installer is a POSIX shell script; there is no equivalent one-liner
		// we can vouch for on Windows, so point at the docs instead of guessing.
		if (platform === "win32") {
			ctx.ui.notify(`Install JFrog Boost for Windows following ${INSTALL_DOCS}, then restart pi.`, "info");
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify(`Run this yourself, then restart pi:\n    ${INSTALL_COMMAND}`, "info");
			return;
		}

		const confirmed = await ctx.ui.confirm("Install JFrog Boost?", CONFIRM_BODY);
		if (!confirmed) {
			ctx.ui.notify("Boost installation cancelled.", "info");
			return;
		}

		ctx.ui.notify("Installing JFrog Boost…", "info");
		const result = await pi.exec("sh", ["-c", INSTALL_COMMAND], {
			cwd: ctx.cwd,
			timeout: INSTALL_TIMEOUT_MS,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});

		client.refresh();
		const installed = client.binary();
		if (installed) {
			ctx.ui.notify(`JFrog Boost installed at ${installed}. It is active from the next tool call.`, "info");
			return;
		}
		const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n");
		ctx.ui.notify(
			`The installer exited ${result.code} without producing a boost binary.` +
				`${detail ? `\n${detail}` : ""}\nInstall manually: ${INSTALL_DOCS}`,
			"error",
		);
	};

	pi.registerCommand(COMMAND_NAME, {
		description: "Install the JFrog Boost CLI (asks first)",
		handler,
	});
}
