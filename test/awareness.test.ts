import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AwarenessInputs,
	type AwarenessView,
	awarenessView,
	buildAwareness,
	quoteCommand,
	visibleTools,
	withAwareness,
} from "../src/awareness.ts";

/** A binary-only install that is not on PATH, on macOS. */
const OFF_PATH = "'/Users/someone/.local/bin/boost'";
/**
 * Boost's Windows default (`%LOCALAPPDATA%\\boost\\bin\\boost.exe`) for a
 * long user name, padded to 100 characters: longer than the command the text
 * carries in practice, which is what the 1,200 budget is measured against.
 */
const LONG_WIN_PATH = `C:\\Users\\${"a".repeat(57)}\\AppData\\Local\\boost\\bin\\boost.exe`;

const view = (over: Partial<AwarenessView> = {}): AwarenessView => ({
	shellTools: [],
	extraTools: [],
	logs: false,
	mcp: false,
	documents: false,
	notebooks: false,
	boostCmd: "boost",
	onPath: true,
	callOperator: false,
	...over,
});

const inputs = (over: Partial<AwarenessInputs> = {}): AwarenessInputs => ({
	ready: true,
	awareness: true,
	shellOn: true,
	settings: { mcp: true, mcpExclude: [], documents: true, notebooks: true, readLogs: false, extraTools: [] },
	boostVersion: [0, 15, 4],
	mcpFlag: "unknown",
	termsAccepted: true,
	loadout: { selected: ["read", "bash", "edit", "write", "mcp__slack__slack_get_users"] },
	binary: "/usr/local/bin/boost",
	onPath: true,
	platform: "darwin",
	...over,
});

// ---------------------------------------------------------------------------
// The text (spec §12)

const SHELL_ONLY = `JFrog Boost shortens some tool output before you see it: \`bash\` output. Everything else (\`read\` of text files, \`edit\`, \`write\`, …) is exact.
- Shortened output is intentional and usually enough; prefer it.
- If a result ends with \`[… boost retrieve 147]\` and you need a dropped detail, run \`boost retrieve <id> --query "<term>"\` (or \`--lines 40-80\`) rather than re-running the tool. Retrieve narrowly: repeated retrieves turn that filter off for every agent on this machine.
- Prefix a command with \`DISABLE_BOOST=1\` for its exact output (e.g. raw HTML from curl/wget, which may arrive as readable text). Never pipe into \`boost\` yourself.
- Boost's secret redaction is best effort, not a security boundary.`;

test("the shell-only text, exactly", () => {
	assert.equal(buildAwareness(view({ shellTools: ["bash"] })), SHELL_ONLY);
});

const EVERYTHING_OFF_PATH = `JFrog Boost shortens some tool output before you see it: \`bash\`, \`powershell\`, and \`fetch\` output, whole \`read\`s of *.log/*.out, MCP tool results (\`mcp__*\`), and PDF and Office files you \`read\`. Everything else (other \`read\`s, \`edit\`, \`write\`, …) is exact.
- Shortened output is intentional and usually enough; prefer it.
- If a result ends with \`[… boost retrieve 147]\` and you need a dropped detail, run \`${OFF_PATH} retrieve <id> --query "<term>"\` (or \`--lines 40-80\`) rather than re-running the tool. Retrieve narrowly: repeated retrieves turn that filter off for every agent on this machine.
- Prefix a command with \`DISABLE_BOOST=1\` for its exact output (e.g. raw HTML from curl/wget, which may arrive as readable text). Never pipe into \`boost\` yourself.
- Documents, and notebooks read whole, arrive as converted text, paged like any read. Line numbers are not file lines; never \`edit\` from them. offset=1 gives a notebook's raw JSON.
- \`boost\` is not on PATH; use the full path above.
- Boost's secret redaction is best effort, not a security boundary.`;

test("everything active, off PATH: the full text, exactly", () => {
	const text = buildAwareness(
		view({
			shellTools: ["bash", "powershell"],
			extraTools: ["fetch"],
			logs: true,
			mcp: true,
			documents: true,
			notebooks: true,
			boostCmd: OFF_PATH,
			onPath: false,
		}),
	);
	assert.equal(text, EVERYTHING_OFF_PATH);
});

test("a 100-character Windows install path with every surface stays under 1,200 characters", () => {
	assert.equal(LONG_WIN_PATH.length, 100);
	const visible = ["read", "bash", "powershell", "fetch", "mcp__slack__slack_get_users"];
	for (const loadout of [visible, visible.filter((t) => t !== "bash")]) {
		const v = awarenessView(
			inputs({
				onPath: false,
				binary: LONG_WIN_PATH,
				platform: "win32",
				loadout: { selected: loadout },
				settings: { ...inputs().settings, readLogs: true, extraTools: ["fetch"] },
			}),
		);
		const text = buildAwareness(v);
		assert.ok(text, loadout.join());
		assert.ok(text.length < 1200, `${loadout.join()}: ${text.length} characters`);
	}
});

/** Every combination of surfaces, on and off PATH. */
function* combinations(): Generator<[string, AwarenessView]> {
	const shells: (readonly string[])[] = [[], ["bash"], ["powershell"], ["bash", "powershell"]];
	for (const shellTools of shells) {
		for (const [extraTools, logs] of [
			[[], false],
			[["fetch"], false],
			[[], true],
			[["fetch"], true],
		] as const) {
			for (const mcp of [false, true]) {
				for (const [documents, notebooks] of [
					[false, false],
					[true, false],
					[true, true],
				] as const) {
					for (const [onPath, boostCmd, callOperator] of [
						[true, "boost", false],
						[false, OFF_PATH, false],
						[false, `"${LONG_WIN_PATH}"`, true],
						[false, `& "${LONG_WIN_PATH}"`, false],
					] as const) {
						const v = view({
							shellTools,
							extraTools,
							logs,
							mcp,
							documents,
							notebooks,
							onPath,
							boostCmd,
							callOperator,
						});
						yield [JSON.stringify(v), v];
					}
				}
			}
		}
	}
}

test("every surface combination is under 1,200 characters and deterministic", () => {
	for (const [label, v] of combinations()) {
		const text = buildAwareness(v);
		const none = v.shellTools.length === 0 && v.extraTools.length === 0 && !v.logs && !v.mcp && !v.documents;
		if (none) {
			assert.equal(text, undefined, label);
			continue;
		}
		assert.ok(text, label);
		assert.ok(text.length < 1200, `${label}: ${text.length} characters`);
		assert.equal(buildAwareness(structuredClone(v)), text, `${label}: byte-identical for the same view`);
	}
});

test("each conditional line appears exactly when its surface is active", () => {
	for (const [label, v] of combinations()) {
		const text = buildAwareness(v);
		if (!text) continue;
		assert.equal(text.includes("DISABLE_BOOST=1"), v.shellTools.length > 0, label);
		assert.equal(text.includes("MCP tool results (`mcp__*`)"), v.mcp, label);
		assert.equal(text.includes("`fetch`"), v.extraTools.length > 0, label);
		assert.equal(text.includes("*.log/*.out"), v.logs, label);
		assert.equal(text.includes("`read` of text files"), !v.logs, label);
		assert.equal(text.includes("after `&`"), v.callOperator && !v.onPath, label);
		assert.equal(text.includes("arrive as converted text"), v.documents, label);
		assert.equal(text.includes("notebooks read whole"), v.notebooks, label);
		assert.equal(text.includes("offset=1"), v.notebooks, label);
		assert.equal(text.includes("not on PATH"), !v.onPath, label);
		assert.ok(text.includes(`\`${v.boostCmd} retrieve <id>`), label);
	}
});

test("surfaces are joined as one, two or three items", () => {
	const first = (v: AwarenessView) => buildAwareness(v)?.split("\n")[0];
	assert.match(first(view({ mcp: true })) ?? "", /see it: MCP tool results \(`mcp__\*`\)\. /);
	assert.match(first(view({ shellTools: ["powershell"] })) ?? "", /see it: `powershell` output\. /);
	assert.match(
		first(view({ shellTools: ["bash"], documents: true })) ?? "",
		/see it: `bash` output and PDF and Office files you `read`\. /,
	);
	assert.match(
		first(view({ mcp: true, documents: true })) ?? "",
		/see it: MCP tool results \(`mcp__\*`\) and PDF and Office files you `read`\. /,
	);
	assert.match(
		first(view({ shellTools: ["bash", "powershell"], mcp: true, documents: true })) ?? "",
		/see it: `bash` and `powershell` output, MCP tool results \(`mcp__\*`\), and PDF and Office files you `read`\. /,
	);
});

test("no claim that read, grep, find or ls output is compacted", () => {
	for (const [label, v] of combinations()) {
		const text = buildAwareness(v);
		if (!text) continue;
		assert.doesNotMatch(text, /`(grep|find|ls)`/, label);
		// `read` is named only as exact, or for documents.
		for (const line of text.split("\n")) {
			if (!line.includes("`read`")) continue;
			assert.match(
				line,
				/`read` of text files|files you `read`|`read`s of \*\.log\/\*\.out|other `read`s/,
				label,
			);
		}
	}
});

test("no view, no text", () => {
	assert.equal(buildAwareness(undefined), undefined);
});

// ---------------------------------------------------------------------------
// The view: which surfaces are active (spec §12)

test("nothing active means no view: not ready, awareness off, no binary, or no surface", () => {
	assert.ok(awarenessView(inputs()));
	assert.equal(awarenessView(inputs({ ready: false })), undefined);
	assert.equal(awarenessView(inputs({ awareness: false })), undefined);
	assert.equal(awarenessView(inputs({ binary: undefined })), undefined);
	assert.equal(
		awarenessView(
			inputs({
				shellOn: false,
				termsAccepted: false,
				loadout: { selected: ["read", "bash"] },
			}),
		),
		undefined,
		"shell gate off, no MCP tool, no terms: no section at all",
	);
});

test("the shell surface needs the gate and a visible shell tool", () => {
	assert.deepEqual(awarenessView(inputs())?.shellTools, ["bash"]);
	assert.deepEqual(awarenessView(inputs({ shellOn: false }))?.shellTools, []);
	assert.deepEqual(
		awarenessView(inputs({ loadout: { selected: ["powershell", "bash", "read"] } }))?.shellTools,
		["bash", "powershell"],
		"in a fixed order, whatever the loadout's",
	);
	assert.deepEqual(
		awarenessView(inputs({ loadout: { selected: ["bash", "read"], hidden: ["bash"] } }))?.shellTools,
		[],
		"a hidden tool is not visible",
	);
});

test("without a loadout, pi's default tools are assumed: bash and read, no MCP", () => {
	assert.deepEqual(visibleTools({}), ["read", "bash", "edit", "write"]);
	assert.deepEqual(visibleTools({ hidden: ["bash"] }), ["read", "edit", "write"]);
	const v = awarenessView(inputs({ loadout: {} }));
	assert.deepEqual(v?.shellTools, ["bash"]);
	assert.equal(v?.documents, true);
	assert.equal(v?.mcp, false);
});

test("MCP needs a visible, non-excluded mcp__ tool and a route that can run", () => {
	assert.equal(awarenessView(inputs())?.mcp, true);
	assert.equal(awarenessView(inputs({ loadout: { selected: ["bash"] } }))?.mcp, false);
	const s = inputs().settings;
	assert.equal(awarenessView(inputs({ settings: { ...s, mcp: false } }))?.mcp, false);
	assert.equal(awarenessView(inputs({ settings: { ...s, mcpExclude: ["mcp__slack__*"] } }))?.mcp, false);
	assert.equal(awarenessView(inputs({ mcpFlag: false }))?.mcp, false);
	assert.equal(awarenessView(inputs({ mcpFlag: true }))?.mcp, true);
	assert.equal(awarenessView(inputs({ boostVersion: [0, 15, 2] }))?.mcp, false);
});

test("documents need read visible, the setting and the terms; notebooks need documents", () => {
	const s = inputs().settings;
	assert.equal(awarenessView(inputs())?.documents, true);
	assert.equal(awarenessView(inputs())?.notebooks, true);
	assert.equal(awarenessView(inputs({ termsAccepted: false }))?.documents, false);
	assert.equal(awarenessView(inputs({ termsAccepted: false }))?.notebooks, false);
	assert.equal(awarenessView(inputs({ settings: { ...s, documents: false } }))?.documents, false);
	assert.equal(awarenessView(inputs({ settings: { ...s, notebooks: false } }))?.notebooks, false);
	assert.equal(
		awarenessView(inputs({ loadout: { selected: ["bash", "read"], hidden: ["read"] } }))?.documents,
		false,
	);
});

test("off PATH, the model is given the quoted absolute path", () => {
	assert.equal(awarenessView(inputs())?.boostCmd, "boost");
	assert.equal(awarenessView(inputs({ onPath: false }))?.boostCmd, "'/usr/local/bin/boost'");
	assert.equal(
		awarenessView(
			inputs({ onPath: false, binary: "C:\\Users\\me\\boost\\bin\\boost.exe", platform: "win32" }),
		)?.boostCmd,
		'"C:\\Users\\me\\boost\\bin\\boost.exe"',
	);
	const text = buildAwareness(awarenessView(inputs({ onPath: false })));
	assert.ok(text?.includes("`'/usr/local/bin/boost' retrieve <id> --query"));
	assert.ok(text?.includes("not on PATH"));
});

test("readLogs names whole log reads and stops calling text reads exact, behind the shell gate", () => {
	const s = { ...inputs().settings, readLogs: true };
	const v = awarenessView(inputs({ settings: s }));
	assert.equal(v?.logs, true);
	const first = buildAwareness(v)?.split("\n")[0] ?? "";
	assert.match(first, /whole `read`s of \*\.log\/\*\.out/);
	assert.match(first, /Everything else \(other `read`s,/);
	assert.doesNotMatch(first, /`read` of text files/);
	assert.equal(awarenessView(inputs({ settings: s, shellOn: false }))?.logs, false, "the gate is off");
	assert.equal(
		awarenessView(inputs({ settings: s, loadout: { selected: ["bash", "read"], hidden: ["read"] } }))?.logs,
		false,
		"read is not visible",
	);
	assert.equal(awarenessView(inputs())?.logs, false, "readLogs off");
	// Logs alone are a surface: a session with only `read` visible still gets the section.
	const only = awarenessView(
		inputs({ settings: s, termsAccepted: false, loadout: { selected: ["read", "edit", "write"] } }),
	);
	assert.deepEqual([only?.logs, only?.shellTools, only?.documents], [true, [], false]);
});

test("a visible extraTools tool is named like bash when the gate is on, and is a surface on its own", () => {
	const s = { ...inputs().settings, extraTools: ["fetch", "edit", "hidden_tool"] };
	const loadout = { selected: ["read", "bash", "fetch", "edit"] };
	const v = awarenessView(inputs({ settings: s, loadout }));
	assert.deepEqual(v?.extraTools, ["fetch"], "not edit (never routed), not an invisible tool");
	assert.match(buildAwareness(v) ?? "", /see it: `bash` and `fetch` output/);
	assert.deepEqual(awarenessView(inputs({ settings: s, loadout, shellOn: false }))?.extraTools ?? [], []);
	// Only fetch visible and nothing else active: still a section, but no DISABLE_BOOST line,
	// which is about shell commands.
	const only = awarenessView(
		inputs({ settings: s, termsAccepted: false, loadout: { selected: ["read", "fetch"] } }),
	);
	assert.deepEqual(only?.extraTools, ["fetch"]);
	const text = buildAwareness(only) ?? "";
	assert.match(text, /see it: `fetch` output\./);
	assert.doesNotMatch(text, /DISABLE_BOOST/);
});

test("on win32 off PATH, PowerShell gets the & call operator it needs", () => {
	const win = { onPath: false, binary: "C:\\b\\boost.exe", platform: "win32" as const };
	const ps = awarenessView(inputs({ ...win, loadout: { selected: ["read", "powershell"] } }));
	assert.equal(ps?.boostCmd, '& "C:\\b\\boost.exe"');
	assert.equal(ps?.callOperator, false);
	assert.ok(buildAwareness(ps)?.includes('`& "C:\\b\\boost.exe" retrieve <id>'));
	// bash and powershell: `&` would break bash, so the line names it instead.
	const both = awarenessView(inputs({ ...win, loadout: { selected: ["read", "bash", "powershell"] } }));
	assert.equal(both?.boostCmd, '"C:\\b\\boost.exe"');
	assert.equal(both?.callOperator, true);
	assert.match(
		buildAwareness(both) ?? "",
		/not on PATH; use the full path above \(in `powershell`, after `&`\)\./,
	);
	// bash only, POSIX, or on PATH: no operator.
	assert.equal(awarenessView(inputs(win))?.boostCmd, '"C:\\b\\boost.exe"');
	assert.equal(awarenessView(inputs(win))?.callOperator, false);
	const posix = awarenessView(inputs({ onPath: false, loadout: { selected: ["powershell"] } }));
	assert.equal(posix?.boostCmd, "'/usr/local/bin/boost'");
	assert.equal(
		awarenessView(inputs({ ...win, onPath: true, loadout: { selected: ["powershell"] } }))?.boostCmd,
		"boost",
	);
	// Visible shells count whether or not the gate is on: retrieve runs in whatever shell there is.
	assert.equal(
		awarenessView(inputs({ ...win, shellOn: false, loadout: { selected: ["powershell", "mcp__a__b"] } }))
			?.boostCmd,
		'& "C:\\b\\boost.exe"',
	);
});

test("POSIX quoting survives a quote and a space in the path", () => {
	assert.equal(quoteCommand("/home/o'brien/my bin/boost", "linux"), "'/home/o'\\''brien/my bin/boost'");
});

// ---------------------------------------------------------------------------
// The fallback for a pi without structured sections

test("the fallback appends the block to the system prompt", () => {
	const result = withAwareness("You are pi.", SHELL_ONLY);
	assert.equal(result, `You are pi.\n\n<jfrog-boost>\n${SHELL_ONLY}\n</jfrog-boost>`);
});

test("it is not appended twice when handlers chain", () => {
	const once = withAwareness("You are pi.", SHELL_ONLY);
	assert.equal(withAwareness(once, SHELL_ONLY), once);
});
