#!/usr/bin/env node
/**
 * A stand-in for the `boost` binary, scripted entirely through the environment.
 *
 * Unit tests run it as `node fake-boost.mjs <boost args>` through
 * `BoostClientDeps.launcher`, so the same real-process tests run on Linux,
 * macOS and Windows. The earlier `#!/bin/sh` stand-ins could not run on
 * Windows, which left the process layer — timeouts, early exits, EPIPE, oversized
 * replies — untested on the platform where spawning differs most.
 *
 * It is plain JavaScript (not TypeScript) so it starts as fast as node can and
 * does not depend on type stripping being available in the child.
 *
 * Environment (all optional):
 *   FAKE_BOOST_VERSION   banner `boost version` prints (default `boost v0.15.4`);
 *                        `none` makes `version` exit 1 with no output
 *   FAKE_BOOST_VERSION_SLEEP_MS  wait this long before answering `version`
 *                        (a Boost stalled on a flag refresh, spec F2)
 *   FAKE_BOOST_MODE      what every other invocation does:
 *                          echo          print stdin back unchanged (default)
 *                          compact-to    print FAKE_BOOST_OUTPUT
 *                          silent        print nothing
 *                          hang          never exit (until killed)
 *                          huge-output   print FAKE_BOOST_BYTES bytes of `x`
 *                          read-advisory for `read`, print Boost's legacy-Office
 *                                        `[boost] …` advisory and exit 1
 *                          hook-reply    for `hook …`, print FAKE_BOOST_REPLY
 *                          crash         die from SIGKILL sent to itself (not by the parent)
 *   FAKE_BOOST_OUTPUT    text for compact-to (and for `read` in any mode)
 *   FAKE_BOOST_REPLY     JSON text for hook-reply (default `{}`)
 *   FAKE_BOOST_BYTES     size for huge-output (default 5 MiB)
 *   FAKE_BOOST_SLEEP_MS  wait this long before replying (not for `version`)
 *   FAKE_BOOST_EXIT      exit code after replying (default 0)
 *   FAKE_BOOST_NO_STDIN  `1`: exit at once without reading stdin, which is what
 *                        makes the parent's stdin write fail with EPIPE
 *   FAKE_BOOST_LOG       append one JSON line per invocation:
 *                        {argv, stdin, cwd, pid, env: every BOOST_* variable}
 */
import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const env = process.env;
const argv = process.argv.slice(2);
const sub = argv[0];
const mode = env.FAKE_BOOST_MODE ?? "echo";
const exitCode = Number(env.FAKE_BOOST_EXIT ?? "0");

function log(stdin) {
	if (!env.FAKE_BOOST_LOG) return;
	const boostEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("BOOST_")));
	appendFileSync(
		env.FAKE_BOOST_LOG,
		`${JSON.stringify({ argv, stdin, cwd: process.cwd(), pid: process.pid, env: boostEnv })}\n`,
	);
}

/** Write, then exit only once stdout has drained, so large replies are not cut short. */
function reply(text, code = exitCode) {
	if (!text) process.exit(code);
	process.stdout.write(text, () => process.exit(code));
}

function readStdin() {
	return new Promise((resolve) => {
		const chunks = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	if (sub === "version") {
		log("");
		const stall = Number(env.FAKE_BOOST_VERSION_SLEEP_MS ?? "0");
		if (stall > 0) await sleep(stall);
		const banner = env.FAKE_BOOST_VERSION ?? "boost v0.15.4";
		if (banner === "none") return reply("", 1);
		return reply(`${banner}\n`, 0);
	}

	if (env.FAKE_BOOST_NO_STDIN === "1") {
		log(null);
		process.exit(exitCode);
	}

	const stdin = await readStdin();
	log(stdin);

	if (mode === "crash") {
		process.kill(process.pid, "SIGKILL");
		return;
	}

	if (mode === "hang") {
		// Keep the event loop alive forever; only a kill ends this.
		setInterval(() => {}, 1 << 30);
		return;
	}

	const delay = Number(env.FAKE_BOOST_SLEEP_MS ?? "0");
	if (delay > 0) await sleep(delay);

	if (sub === "read") {
		if (mode === "read-advisory") {
			const file = basename(argv[argv.length - 1] ?? "file");
			return reply(`[boost] ${file}: legacy binary Office formats are not supported\n`, 1);
		}
		return reply(env.FAKE_BOOST_OUTPUT ?? "");
	}

	if (sub === "hook" && mode === "hook-reply") return reply(env.FAKE_BOOST_REPLY ?? "{}");

	switch (mode) {
		case "compact-to":
			return reply(env.FAKE_BOOST_OUTPUT ?? "");
		case "silent":
			return reply("");
		case "huge-output":
			return reply("x".repeat(Number(env.FAKE_BOOST_BYTES ?? String(5 * 1024 * 1024))));
		default:
			return reply(stdin);
	}
}

void main();
