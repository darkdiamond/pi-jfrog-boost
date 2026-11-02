/**
 * The settings model (spec §9): file location, per-key validation, env
 * overrides, kill switches, precedence, atomic save, and the published
 * schema staying in step with the code.
 */
import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
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
import { join, win32 } from "node:path";
import { after, test } from "node:test";
import {
	agentDir,
	createSettingsStore,
	DEFAULT_SETTINGS,
	envKillSwitch,
	envOverrides,
	flagIsOn,
	parseEnvBoolean,
	parseSettings,
	restoreSessionToggle,
	SESSION_TOGGLE_ENTRY,
	SETTINGS_KEYS,
	SETTINGS_SCHEMA_URL,
	settingsPath,
} from "../src/settings.ts";
import { memoryFs, memorySettings } from "./helpers/runtime.ts";

const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-settings-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const home = join(root, "home");

test("the file is $PI_JFROG_BOOST_SETTINGS, else <agentDir>/jfrog-boost.json", () => {
	assert.equal(settingsPath({}, home), join(home, ".pi", "agent", "jfrog-boost.json"));
	assert.equal(
		settingsPath({ PI_CODING_AGENT_DIR: "/agents/pi" }, home),
		join("/agents/pi", "jfrog-boost.json"),
	);
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/custom" }, home), join(home, "custom"), "tilde-expanded");
	assert.equal(
		settingsPath({ PI_JFROG_BOOST_SETTINGS: "~/boost.json", PI_CODING_AGENT_DIR: "/x" }, home),
		join(home, "boost.json"),
	);
});

test("configured paths are normalised as pi's getAgentDir() does: Windows shell drives, file:// URLs", () => {
	const winHome = "C:\\Users\\me";
	for (const dir of [
		"/c/Users/me/.pi-agent",
		"/mnt/c/Users/me/.pi-agent",
		"/cygdrive/c/Users/me/.pi-agent",
	]) {
		assert.equal(agentDir({ PI_CODING_AGENT_DIR: dir }, winHome, "win32"), "C:\\Users\\me\\.pi-agent", dir);
	}
	assert.equal(
		settingsPath({ PI_CODING_AGENT_DIR: "/c/Users/me/.pi-agent" }, winHome, "win32"),
		win32.join("C:\\Users\\me\\.pi-agent", "jfrog-boost.json"),
	);
	assert.equal(
		settingsPath({ PI_JFROG_BOOST_SETTINGS: "/d/dotfiles/boost.json" }, winHome, "win32"),
		"D:\\dotfiles\\boost.json",
	);
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~\\agent" }, winHome, "win32"), "C:\\Users\\me\\agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "file:///C:/pi/agent" }, winHome, "win32"), "C:\\pi\\agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "//server/share/pi" }, winHome, "win32"), "//server/share/pi");
	// Elsewhere a drive-like path is just a path; a file:// URL is still one.
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/c/agents" }, home, "linux"), "/c/agents");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "file:///opt/pi%20agent" }, home, "linux"), "/opt/pi agent");
	assert.equal(
		settingsPath({ PI_JFROG_BOOST_SETTINGS: "file:///etc/boost.json" }, home, "darwin"),
		"/etc/boost.json",
	);
});

test("a UTF-8 byte order mark does not make the file unreadable", () => {
	const path = join("/fake/home", ".pi", "agent", "jfrog-boost.json");
	const fs = memoryFs(new Map([[path, '\ufeff{"sync":false,"mcp":false}']]));
	const store = createSettingsStore({ env: {}, home: () => "/fake/home", fs });
	assert.deepEqual(store.load(), [], "no 'could not read' warning");
	assert.equal(store.effective().sync, false, "the privacy opt-outs apply");
	assert.equal(store.effective().mcp, false);
	store.save({ footer: false });
	assert.deepEqual(JSON.parse(fs.files.get(path) ?? "{}"), {
		$schema: SETTINGS_SCHEMA_URL,
		sync: false,
		mcp: false,
		footer: false,
	});
});

test("no file: every default", () => {
	const store = memorySettings();
	assert.deepEqual(store.load(), [], "a missing file is not worth a warning");
	assert.deepEqual(store.effective(), DEFAULT_SETTINGS);
	assert.equal(store.off(), undefined);
});

test("each key is validated on its own; an invalid one falls back to its default", () => {
	const parsed = parseSettings({
		$schema: SETTINGS_SCHEMA_URL,
		shell: "sometimes",
		minBytes: 4096,
		mcp: "yes",
		mcpExclude: ["mcp__secrets__*"],
		extraTools: ["fetch", ""],
		futureKey: 1,
	});
	assert.deepEqual(parsed.values, { minBytes: 4096, mcpExclude: ["mcp__secrets__*"] });
	assert.deepEqual(parsed.invalid.sort(), ["extraTools", "mcp", "shell"]);
	assert.deepEqual(parsed.unknown, ["futureKey"]);
	for (const bad of [-1, 1.5, 2 * 1024 * 1024, "2048"]) {
		assert.deepEqual(parseSettings({ minBytes: bad }).invalid, ["minBytes"], String(bad));
	}
	assert.equal(parseSettings([]).error, "not a JSON object");
});

test("an invalid key warns once per process, naming the key, the file and the default", () => {
	const path = join(root, "warn-once.json");
	const env = { PI_JFROG_BOOST_SETTINGS: path };
	const fs = memoryFs(new Map([[path, JSON.stringify({ shell: "loud", footer: false })]]));
	const first = createSettingsStore({ env, fs, home: () => home });
	assert.deepEqual(first.load(), [`pi-jfrog-boost: ignored invalid "shell" in ${path} (using "auto").`]);
	assert.deepEqual(first.load(), [], "not again on the next session");
	const second = createSettingsStore({ env, fs, home: () => home });
	assert.deepEqual(second.load(), [], "not again after /reload either");
	assert.equal(second.effective().shell, "auto");
	assert.equal(second.effective().footer, false, "the valid key in the same file still applies");
});

test("the once-per-process memory survives the module being evaluated afresh, as pi's loader does", async () => {
	// pi loads extensions with jiti's module cache off, so every /new,
	// /resume, /fork and /reload evaluates settings.ts again. A query string
	// gets a second, independent instance of the module here, the same way.
	const url = new URL("../src/settings.ts?reloaded=1", import.meta.url).href;
	const reloaded = (await import(url)) as typeof import("../src/settings.ts");
	assert.notEqual(reloaded.createSettingsStore, createSettingsStore, "a separate module instance");
	const path = join(root, "warn-once-reloaded.json");
	const env = { PI_JFROG_BOOST_SETTINGS: path };
	const fs = memoryFs(new Map([[path, JSON.stringify({ minBytes: -1 })]]));
	const first = createSettingsStore({ env, fs, home: () => home });
	assert.equal(first.load().length, 1);
	const second = reloaded.createSettingsStore({ env, fs, home: () => home });
	assert.deepEqual(second.load(), [], "the re-evaluated module remembers the warning");
});

test("an unreadable file means all defaults plus one warning", () => {
	const path = join(root, "corrupt.json");
	const fs = memoryFs(new Map([[path, "{ not json"]]));
	const store = createSettingsStore({ env: { PI_JFROG_BOOST_SETTINGS: path }, fs, home: () => home });
	const warnings = store.load();
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /could not read .*corrupt\.json/);
	assert.deepEqual(store.effective(), DEFAULT_SETTINGS);
});

test("env overrides: PI_BOOST_SHELL and the boolean switches", () => {
	assert.deepEqual(
		envOverrides({
			PI_BOOST_SHELL: "ON",
			PI_BOOST_DOCUMENTS: "no",
			PI_BOOST_MCP: "0",
			PI_BOOST_SYNC: "false",
			PI_BOOST_OBSERVE: "1",
		}),
		{ shell: "on", documents: false, mcp: false, sync: false, observe: true },
	);
	assert.deepEqual(
		envOverrides({ PI_BOOST_SHELL: "maybe", PI_BOOST_MCP: "perhaps" }),
		{},
		"invalid: ignored",
	);
	for (const [value, expected] of [
		["1", true],
		["TRUE", true],
		["yes", true],
		["0", false],
		["False", false],
		["no", false],
		["", undefined],
		["2", undefined],
	] as const) {
		assert.equal(parseEnvBoolean(value), expected, value);
	}
});

test("precedence: env kill switch, --no-boost, session, per-key env, file, defaults", () => {
	const env: NodeJS.ProcessEnv = {};
	let flag: unknown = false;
	const store = memorySettings({ env, file: { enabled: false, shell: "off", mcp: false }, flag: () => flag });
	store.load();

	// 5 over 6: the file over the defaults.
	assert.equal(store.effective().shell, "off");
	assert.equal(store.sources().shell, "file");
	assert.equal(store.sources().footer, "default");
	assert.deepEqual(store.off(), { by: "settings" }, "the persisted master switch");

	// 4 over 5: per-key env over the file.
	env.PI_BOOST_SHELL = "on";
	assert.equal(store.effective().shell, "on");
	assert.equal(store.sources().shell, "env");

	// 3 over 5: the session toggle over the persisted switch.
	store.setSession(true);
	assert.equal(store.off(), undefined, "/boost on overrides enabled:false for this session");
	store.setSession(false);
	assert.deepEqual(store.off(), { by: "session" });
	store.setSession(true);

	// 2 over 3: --no-boost over the session toggle.
	flag = "true";
	assert.deepEqual(store.off(), { by: "flag" }, "/boost on cannot override --no-boost");

	// 1 over everything: the env kill switch, read live.
	env.BOOST_DISABLED = "1";
	assert.deepEqual(store.off(), { by: "env", name: "BOOST_DISABLED" });
	env.DISABLE_BOOST = "true";
	assert.deepEqual(store.off(), { by: "env", name: "DISABLE_BOOST" });
	delete env.DISABLE_BOOST;
	delete env.BOOST_DISABLED;
	assert.deepEqual(store.off(), { by: "flag" });
});

test("kill switch and flag values", () => {
	assert.equal(envKillSwitch({ DISABLE_BOOST: "1" }), "DISABLE_BOOST");
	assert.equal(envKillSwitch({ BOOST_DISABLED: "True" }), "BOOST_DISABLED");
	assert.equal(envKillSwitch({ DISABLE_BOOST: "0", BOOST_DISABLED: "" }), undefined);
	assert.equal(envKillSwitch({ DISABLE_BOOST: "yes" }), undefined, "only 1 or true");
	assert.equal(flagIsOn(true), true);
	assert.equal(flagIsOn("true"), true);
	for (const value of [false, "false", undefined, "", "1"])
		assert.equal(flagIsOn(value), false, String(value));
});

test("effective() hands out copies: callers cannot change the settings by mutating them", () => {
	const store = memorySettings({ file: { mcpExclude: ["a"] } });
	store.load();
	store.effective().mcpExclude.push("b");
	assert.deepEqual(store.effective().mcpExclude, ["a"]);
	assert.deepEqual(store.unknownKeys(), []);
});

test("save is atomic, keeps unknown keys and the $schema, and rejects invalid values", () => {
	const path = join(root, "agent", "jfrog-boost.json");
	const store = createSettingsStore({ env: { PI_JFROG_BOOST_SETTINGS: path }, home: () => home });
	store.load();
	store.save({ shell: "on", minBytes: 4096 });
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(saved, { $schema: SETTINGS_SCHEMA_URL, shell: "on", minBytes: 4096 });
	assert.deepEqual(readdirSync(join(root, "agent")), ["jfrog-boost.json"], "no temp file left behind");

	// A key edited by hand since load(), and one this version does not know, survive a save.
	writeFileSync(path, JSON.stringify({ ...saved, footer: false, fromTheFuture: { x: 1 } }));
	store.save({ shell: "off" });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		$schema: SETTINGS_SCHEMA_URL,
		shell: "off",
		minBytes: 4096,
		footer: false,
		fromTheFuture: { x: 1 },
	});
	assert.equal(store.effective().shell, "off", "the store reflects what it saved");

	assert.throws(() => store.save({ minBytes: -5 }), /invalid value for "minBytes"/);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).minBytes, 4096, "nothing written for an invalid save");
});

test("save writes through a symlinked file and keeps its permission bits", () => {
	const dotfiles = join(root, "dotfiles");
	const agent = join(root, "linked-agent");
	mkdirSync(dotfiles, { recursive: true });
	mkdirSync(agent, { recursive: true });
	const real = join(dotfiles, "jfrog-boost.json");
	const link = join(agent, "jfrog-boost.json");
	writeFileSync(real, JSON.stringify({ shell: "off" }), { mode: 0o600 });
	symlinkSync(real, link);
	const store = createSettingsStore({ env: { PI_JFROG_BOOST_SETTINGS: link }, home: () => home });
	store.load();
	store.save({ footer: false });
	assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
	assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), {
		$schema: SETTINGS_SCHEMA_URL,
		shell: "off",
		footer: false,
	});
	// Windows has no POSIX permission bits to keep.
	if (process.platform !== "win32")
		assert.equal(statSync(real).mode & 0o777, 0o600, "a 0600 file stays 0600");
	assert.deepEqual(readdirSync(dotfiles), ["jfrog-boost.json"], "no temp file left behind");
	assert.deepEqual(readdirSync(agent), ["jfrog-boost.json"]);
});

test("save refuses to overwrite a file it cannot parse, and leaves it untouched", () => {
	const path = join(root, "broken", "jfrog-boost.json");
	const broken = '{ "shell": "on", "minBytes": 4096, }';
	const fs = memoryFs(new Map([[path, broken]]));
	const store = createSettingsStore({ env: { PI_JFROG_BOOST_SETTINGS: path }, fs, home: () => home });
	assert.throws(() => store.save({ footer: false }), /cannot save: .*unreadable.*fix or remove it first/);
	assert.equal(fs.files.get(path), broken, "the hand-edited file is not replaced by the saved keys alone");
	assert.deepEqual([...fs.files.keys()], [path], "and no temp file is left behind");
	// A missing file is not an error: the first save creates it.
	const fresh = join(root, "fresh", "jfrog-boost.json");
	const freshFs = memoryFs(new Map());
	createSettingsStore({ env: { PI_JFROG_BOOST_SETTINGS: fresh }, fs: freshFs, home: () => home }).save({
		footer: false,
	});
	assert.equal(JSON.parse(freshFs.files.get(fresh) ?? "{}").footer, false);
});

test("a failed rename leaves the old file intact and no temp file behind", () => {
	const path = join(root, "fail", "jfrog-boost.json");
	const fs = memoryFs(new Map([[path, JSON.stringify({ shell: "off" })]]));
	fs.renameSync = () => {
		throw new Error("EXDEV");
	};
	const store = createSettingsStore({ env: { PI_JFROG_BOOST_SETTINGS: path }, fs, home: () => home });
	assert.throws(() => store.save({ shell: "on" }), /EXDEV/);
	assert.deepEqual([...fs.files.keys()], [path]);
	assert.equal(JSON.parse(fs.files.get(path) ?? "{}").shell, "off");
	assert.equal(existsSync(path), false, "and the real file system was never touched");
});

test("settings.schema.json mirrors the settings: same keys, same defaults", () => {
	const schema = JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "settings.schema.json"), "utf8"),
	) as {
		$id: string;
		properties: Record<string, { default?: unknown; enum?: unknown[] }>;
	};
	assert.equal(schema.$id, SETTINGS_SCHEMA_URL);
	const keys = Object.keys(schema.properties).filter((key) => key !== "$schema");
	assert.deepEqual(keys.sort(), [...SETTINGS_KEYS].sort());
	for (const key of SETTINGS_KEYS) {
		assert.deepEqual(schema.properties[key]?.default, DEFAULT_SETTINGS[key], key);
	}
	assert.deepEqual(schema.properties.shell?.enum, ["auto", "on", "off"]);
	// Every default passes the code's own validation.
	assert.deepEqual(parseSettings({ ...DEFAULT_SETTINGS }).invalid, []);
});

test("the session toggle is restored from the branch's last entry", () => {
	const toggle = (enabled: unknown) => ({
		type: "custom",
		customType: SESSION_TOGGLE_ENTRY,
		data: { enabled },
	});
	assert.equal(restoreSessionToggle(undefined), undefined);
	assert.equal(restoreSessionToggle({ getBranch: () => [] }), undefined, "a new session has none");
	assert.equal(restoreSessionToggle({ getBranch: () => [toggle(false), { type: "message" }] }), false);
	assert.equal(
		restoreSessionToggle({ getBranch: () => [toggle(false), toggle(true)] }),
		true,
		"the last wins",
	);
	assert.equal(
		restoreSessionToggle({ getBranch: () => [toggle(false), toggle("no")] }),
		false,
		"junk skipped",
	);
	assert.equal(
		restoreSessionToggle({ getBranch: () => [toggle(false), toggle(null)] }),
		undefined,
		"a cleared toggle hands the decision back to the settings",
	);
	assert.equal(restoreSessionToggle({ getBranch: () => [toggle(null), toggle(false)] }), false);
	assert.equal(
		restoreSessionToggle({ getBranch: () => [], getEntries: () => [toggle(false)] }),
		undefined,
		"a sibling branch's toggle does not leak in",
	);
	assert.equal(
		restoreSessionToggle({
			getBranch: () => {
				throw new Error("stale");
			},
			getEntries: () => [toggle(false)],
		}),
		false,
		"entries only when the branch cannot be read",
	);
});
