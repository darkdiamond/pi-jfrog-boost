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

/** A binary-only install that is not on PATH: the longest command the text carries in practice. */
const OFF_PATH = "'/Users/someone/.local/bin/boost'";

const view = (over: Partial<AwarenessView> = {}): AwarenessView => ({
	shellTools: [],
	mcp: false,
	documents: false,
	notebooks: false,
	boostCmd: "boost",
	onPath: true,
	...over,
});

const inputs = (over: Partial<AwarenessInputs> = {}): AwarenessInputs => ({
	ready: true,
	awareness: true,
	shellOn: true,
	settings: { mcp: true, mcpExclude: [], documents: true, notebooks: true },
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

const SHELL_ONLY = `JFrog Boost shortens some tool output before you see it: \`bash\` output. Everything else, including \`read\` of text files, \`edit\` and \`write\`, is exact.
- Shortened output is intentional and usually enough; prefer it.
- If a shortened result ends with \`[Boost compressed ~85%. … boost retrieve 147]\` and you need a dropped detail, run \`boost retrieve <id> --query "<term>"\` (or \`--lines 40-80\`) instead of re-running the tool. Retrieve narrowly: repeated retrieves switch that filter off on this machine for every agent.
- For one command's exact output, prefix it with \`DISABLE_BOOST=1\`. Never pipe commands into \`boost\` yourself. curl/wget pages may arrive as readable text; \`DISABLE_BOOST=1 curl …\` gives raw HTML.
- Boost's secret redaction is best effort, not a security boundary.`;

test("the shell-only text, exactly", () => {
	assert.equal(buildAwareness(view({ shellTools: ["bash"] })), SHELL_ONLY);
});

const EVERYTHING_OFF_PATH = `JFrog Boost shortens some tool output before you see it: \`bash\` and \`powershell\` output, MCP tool results (\`mcp__*\`), and PDF and Office files you \`read\`. Everything else, including \`read\` of text files, \`edit\` and \`write\`, is exact.
- Shortened output is intentional and usually enough; prefer it.
- If a shortened result ends with \`[Boost compressed ~85%. … boost retrieve 147]\` and you need a dropped detail, run \`${OFF_PATH} retrieve <id> --query "<term>"\` (or \`--lines 40-80\`) instead of re-running the tool. Retrieve narrowly: repeated retrieves switch that filter off on this machine for every agent.
- For one command's exact output, prefix it with \`DISABLE_BOOST=1\`. Never pipe commands into \`boost\` yourself. curl/wget pages may arrive as readable text; \`DISABLE_BOOST=1 curl …\` gives raw HTML.
- PDF and Office files, and notebooks read whole, that you \`read\` arrive as converted text, paged like any read (use offset to continue). Line numbers are not file lines; never \`edit\` from them. Read a notebook with offset=1 for its raw JSON.
- \`boost\` is not on PATH; use the full path above.
- Boost's secret redaction is best effort, not a security boundary.`;

test("everything active, off PATH: the full text, exactly", () => {
	const text = buildAwareness(
		view({
			shellTools: ["bash", "powershell"],
			mcp: true,
			documents: true,
			notebooks: true,
			boostCmd: OFF_PATH,
			onPath: false,
		}),
	);
	assert.equal(text, EVERYTHING_OFF_PATH);
});

/** Every combination of surfaces, on and off PATH. */
function* combinations(): Generator<[string, AwarenessView]> {
	const shells: (readonly string[])[] = [[], ["bash"], ["powershell"], ["bash", "powershell"]];
	for (const shellTools of shells) {
		for (const mcp of [false, true]) {
			for (const [documents, notebooks] of [
				[false, false],
				[true, false],
				[true, true],
			] as const) {
				for (const onPath of [true, false]) {
					const v = view({
						shellTools,
						mcp,
						documents,
						notebooks,
						onPath,
						boostCmd: onPath ? "boost" : OFF_PATH,
					});
					yield [JSON.stringify(v), v];
				}
			}
		}
	}
}

test("every surface combination is under 1,200 characters and deterministic", () => {
	for (const [label, v] of combinations()) {
		const text = buildAwareness(v);
		const none = v.shellTools.length === 0 && !v.mcp && !v.documents;
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
				/`read` of text files|files you `read`|that you `read` arrive as converted text/,
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
