/**
 * Self-tests for the hermetic e2e harness. Everything here runs against a
 * fake "real home" in a temp directory: the point is to prove the tripwire
 * fires and the environment is sealed, without the real Boost or real HOME.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import {
	createHermetic,
	createTripwire,
	REFUSED_PROXY,
	synthesizeConfig,
	termsAccepted,
	termsLinesFrom,
} from "./helpers/hermetic.ts";

const root = mkdtempSync(join(tmpdir(), "pi-boost-hermetic-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let homes = 0;
/** A fake real home with a Boost config, a macOS-style history DB and nothing else. */
function fakeRealHome(
	config = `accept_terms = "yes"\naccept_terms_at = "2026-10-01T00:00:00Z"\nterms_version = "preview-1"\n\n[filters]\ndisabled = ["git"]\n`,
) {
	const home = join(root, `real-${homes++}`);
	mkdirSync(join(home, ".boost"), { recursive: true });
	writeFileSync(join(home, ".boost", "config.toml"), config);
	const support = join(home, "Library", "Application Support", "boost");
	mkdirSync(support, { recursive: true });
	writeFileSync(join(support, "history.db"), "db");
	return home;
}

const FAKE_BIN = join(root, "bin", "boost");
mkdirSync(dirname(FAKE_BIN), { recursive: true });
writeFileSync(FAKE_BIN, "");

function hermeticFor(realHome: string, env: NodeJS.ProcessEnv = {}) {
	const work = join(root, `cwd-${homes}`);
	mkdirSync(work, { recursive: true });
	return createHermetic({
		env: { PATH: "/usr/bin", BOOST_BIN: FAKE_BIN, ...env },
		realHome,
		platform: "linux",
		now: new Date("2026-10-13T00:00:00Z"),
		parent: root,
		cwd: work,
	});
}

test("the tripwire fires when real Boost state is touched", () => {
	const real = fakeRealHome();
	const config = join(real, ".boost", "config.toml");
	const wire = createTripwire([config, join(real, ".boost")]);
	assert.deepEqual(wire.changes(), []);
	wire.assertUnchanged();

	writeFileSync(config, `${readFileSync(config, "utf8")}\n[feature_flags._metadata]\n`);
	// Once for the file, once as a file inside the watched directory.
	assert.equal(wire.changes().length, 2);
	assert.throws(() => wire.assertUnchanged(), /real Boost state changed[\s\S]*config\.toml/);
});

test("the tripwire notices a file appearing, like Boost's install_id", () => {
	const real = fakeRealHome();
	const support = join(real, "Library", "Application Support", "boost");
	const wire = createTripwire([support, join(support, "install_id")]);
	writeFileSync(join(support, "install_id"), "id");
	const changes = wire.changes();
	assert.equal(changes.length, 2, changes.join("\n"));
	assert.match(changes.join("\n"), /absent → file/);
});

test("the tripwire notices a rewrite with identical size", () => {
	const real = fakeRealHome();
	const db = join(real, "Library", "Application Support", "boost", "history.db");
	const wire = createTripwire([db]);
	writeFileSync(db, "DB");
	assert.equal(statSync(db).size, 2);
	assert.equal(wire.changes().length, 1);
});

test("the tripwire notices a rewrite of a file it does not name, like unused-hint", () => {
	const real = fakeRealHome();
	const support = join(real, "Library", "Application Support", "boost");
	writeFileSync(join(support, "unused-hint"), "2026-10-01");
	writeFileSync(join(support, "history.retention.lock"), "");
	mkdirSync(join(support, "cache"));
	writeFileSync(join(support, "cache", "state"), "a");
	const wire = createTripwire([support]);
	assert.deepEqual(wire.changes(), []);

	writeFileSync(join(support, "unused-hint"), "2026-10-13");
	writeFileSync(join(support, "cache", "state"), "b");
	const changes = wire.changes();
	assert.equal(changes.length, 2, changes.join("\n"));
	assert.match(changes.join("\n"), /unused-hint: file 10 B/);
	assert.match(changes.join("\n"), /cache\/state: file 1 B/);
});

test("the SQLite -shm index counts by presence, not by its bytes", () => {
	const real = fakeRealHome();
	const support = join(real, "Library", "Application Support", "boost");
	writeFileSync(join(support, "history.db-shm"), "index-1");
	const wire = createTripwire([support]);
	// Rewritten by any process that only reads the DB: not a state change.
	writeFileSync(join(support, "history.db-shm"), "index-2");
	assert.deepEqual(wire.changes(), []);
	rmSync(join(support, "history.db-shm"));
	assert.match(wire.changes().join("\n"), /history\.db-shm: entry-only → absent/);
});

test("a custom BOOST_DB_PATH in the real environment is watched too", () => {
	const real = fakeRealHome();
	const db = join(root, `custom-${homes}.db`);
	writeFileSync(db, "db");
	const hermetic = hermeticFor(real, { BOOST_DB_PATH: db });
	try {
		assert.ok(hermetic.tripwire.paths.includes(db));
		assert.ok(hermetic.tripwire.paths.includes(`${db}-wal`));
		assert.notEqual(hermetic.env.BOOST_DB_PATH, db, "the child env never points at it");
		writeFileSync(`${db}-wal`, "wal");
		assert.throws(() => hermetic.tripwire.assertUnchanged(), /custom-\d+\.db-wal/);
	} finally {
		hermetic.dispose();
	}
});

test("a hermetic run fingerprints the real home and never writes it", () => {
	const real = fakeRealHome();
	const before = readFileSync(join(real, ".boost", "config.toml"), "utf8");
	const hermetic = hermeticFor(real);
	try {
		assert.ok(hermetic.tripwire.paths.includes(join(real, ".boost", "config.toml")));
		assert.ok(
			hermetic.tripwire.paths.includes(join(real, "Library", "Application Support", "boost", "install_id")),
		);
		assert.ok(!hermetic.home.startsWith(real), "the temp HOME is not inside the real home");
		hermetic.tripwire.assertUnchanged();
		assert.equal(readFileSync(join(real, ".boost", "config.toml"), "utf8"), before);
	} finally {
		hermetic.dispose();
	}
});

test("deliberately touching the fake real home after setup fails the tripwire", () => {
	const real = fakeRealHome();
	const hermetic = hermeticFor(real);
	try {
		mkdirSync(join(real, ".local", "share", "boost"), { recursive: true });
		assert.throws(() => hermetic.tripwire.assertUnchanged(), /\.local[/\\]share[/\\]boost/);
	} finally {
		hermetic.dispose();
	}
});

test("only the terms lines are copied, and the rest of the config is synthesized", () => {
	const real = fakeRealHome();
	const hermetic = hermeticFor(real);
	try {
		const config = readFileSync(join(hermetic.home, ".boost", "config.toml"), "utf8");
		assert.match(config, /^accept_terms = "yes"$/m);
		assert.match(config, /^terms_version = "preview-1"$/m);
		assert.doesNotMatch(config, /filters|disabled/, "nothing but the terms lines comes from the real config");
		assert.match(config, /\[feature_flags\._metadata\]\nlast_updated_at = "2026-10-13T00:00:00\.000Z"/);
		assert.match(config, /\[feature_flags\."boost-cli-filtering"\]\nuser = true/);
		assert.equal(hermetic.termsAvailable, true);
	} finally {
		hermetic.dispose();
	}
});

test("a real home with no config at all says so, and may still skip", () => {
	const real = fakeRealHome();
	rmSync(join(real, ".boost", "config.toml"));
	const hermetic = hermeticFor(real);
	try {
		assert.equal(hermetic.termsAvailable, false);
		assert.equal(hermetic.termsRequired, false);
		assert.match(hermetic.termsMissingReason ?? "", /config\.toml not found/);
	} finally {
		hermetic.dispose();
	}
});

test("an explicit BOOST_E2E_TERMS_FROM that does not exist is required, not skipped", () => {
	const missing = join(root, "no-such-dir", "config.toml");
	const hermetic = hermeticFor(fakeRealHome(), { BOOST_E2E_TERMS_FROM: missing });
	try {
		assert.equal(hermetic.termsSource, missing);
		assert.equal(hermetic.termsAvailable, false, "the real home's terms are not a fallback");
		assert.equal(hermetic.termsRequired, true);
		assert.match(hermetic.termsMissingReason ?? "", /not found/);
		assert.doesNotMatch(hermetic.termsMissingReason ?? "", /no accepted Boost Preview Agreement/);
		assert.match(hermetic.termsMissingReason ?? "", /BOOST_E2E_TERMS_FROM is set/);
	} finally {
		hermetic.dispose();
	}
});

test("an explicit BOOST_E2E_TERMS_FROM without accepted terms is required, not skipped", () => {
	const source = join(root, "unaccepted.toml");
	writeFileSync(source, "[measurement]\n");
	const hermetic = hermeticFor(fakeRealHome(), { BOOST_E2E_TERMS_FROM: source });
	try {
		assert.equal(hermetic.termsAvailable, false);
		assert.equal(hermetic.termsRequired, true);
		assert.match(hermetic.termsMissingReason ?? "", /no accepted Boost Preview Agreement/);
	} finally {
		hermetic.dispose();
	}
});

test("an explicit BOOST_E2E_HOME without a config is required, not skipped", () => {
	const empty = join(root, "empty-home");
	mkdirSync(empty, { recursive: true });
	const hermetic = hermeticFor(fakeRealHome(), { BOOST_E2E_HOME: empty });
	try {
		assert.equal(hermetic.termsAvailable, false);
		assert.equal(hermetic.termsRequired, true);
		assert.match(hermetic.termsMissingReason ?? "", /not found; BOOST_E2E_HOME is set/);
	} finally {
		hermetic.dispose();
	}
});

test("BOOST_E2E_TERMS_FROM overrides where the terms come from", () => {
	const real = fakeRealHome("[measurement]\n");
	const source = join(root, "terms.toml");
	writeFileSync(source, `accept_terms = "yes"\nterms_version = "preview-9"\n`);
	const hermetic = hermeticFor(real, { BOOST_E2E_TERMS_FROM: source });
	try {
		assert.equal(hermetic.termsSource, source);
		assert.deepEqual(hermetic.terms, ['accept_terms = "yes"', 'terms_version = "preview-9"']);
		assert.equal(hermetic.termsRequired, true);
		assert.equal(hermetic.termsMissingReason, undefined);
	} finally {
		hermetic.dispose();
	}
});

test("without accepted terms, document cases get a reason to skip", () => {
	const hermetic = hermeticFor(fakeRealHome("[measurement]\n"));
	try {
		assert.equal(hermetic.termsAvailable, false);
		assert.equal(hermetic.termsRequired, false, "the implicit default may skip");
		assert.match(hermetic.termsMissingReason ?? "", /no accepted Boost Preview Agreement/);
		assert.match(hermetic.termsMissingReason ?? "", /BOOST_E2E_TERMS_FROM/);
		const config = readFileSync(join(hermetic.home, ".boost", "config.toml"), "utf8");
		assert.doesNotMatch(config, /accept_terms/);
	} finally {
		hermetic.dispose();
	}
});

test("the environment points everything Boost can find into the temp HOME", () => {
	const hermetic = hermeticFor(fakeRealHome(), {
		HOME: "/real",
		XDG_DATA_HOME: "/real/.local/share",
		DISABLE_BOOST: "1",
		PI_BOOST_SHELL: "on",
		BOOST_FEATURE_FLAGS_FORCE_ENABLED: "x",
		NO_PROXY: "*",
		NODE_TEST_CONTEXT: "child-v8",
		BASH_ENV: "/real/.bashrc",
		ENV: "/real/.shrc",
	});
	try {
		const { env, home } = hermetic;
		assert.equal(env.HOME, home);
		assert.equal(env.USERPROFILE, home);
		assert.equal(env.BOOST_DB_PATH, join(home, "history.db"));
		for (const key of ["TMPDIR", "TEMP", "TMP"]) assert.equal(env[key], join(home, "tmp"));
		for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
			assert.ok(env[key]?.startsWith(home), key);
		}
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
			assert.equal(env[key], REFUSED_PROXY, key);
		}
		assert.equal(env.BOOST_FEATURE_FLAGS_TTL, "24h");
		assert.equal(env.PI_BOOST_SYNC, "0");
		assert.equal(env.BOOST_BIN, FAKE_BIN);
		assert.equal(env.PATH?.split(delimiter)[0], dirname(FAKE_BIN));
		assert.ok(env.PI_CODING_AGENT_DIR?.startsWith(home));
		for (const key of [
			"DISABLE_BOOST",
			"PI_BOOST_SHELL",
			"BOOST_FEATURE_FLAGS_FORCE_ENABLED",
			"NO_PROXY",
			"NODE_TEST_CONTEXT",
			"BASH_ENV",
			"ENV",
		]) {
			assert.equal(env[key], undefined, key);
		}
	} finally {
		hermetic.dispose();
	}
});

test("variant HOMEs carry the machine state their cases need", () => {
	const hermetic = hermeticFor(fakeRealHome());
	try {
		const read = (variant: Parameters<typeof hermetic.variantHome>[0]) =>
			readFileSync(join(hermetic.variantHome(variant), ".boost", "config.toml"), "utf8");
		assert.match(read("user-false"), /user = false/);
		assert.doesNotMatch(read("no-metadata"), /last_updated_at/);
		assert.match(read("no-metadata"), /user = true/);
		assert.doesNotMatch(read("no-terms"), /accept_terms/);
		assert.equal(hermetic.variantHome("no-terms"), hermetic.variantHome("no-terms"), "made once");
		const env = hermetic.envFor(hermetic.variantHome("user-false"));
		assert.equal(env.BOOST_DB_PATH, join(hermetic.variantHome("user-false"), "history.db"));
	} finally {
		hermetic.dispose();
	}
});

test("apply swaps process.env, assertIsolated guards it, and restore puts it back", () => {
	const real = fakeRealHome();
	const hermetic = hermeticFor(real);
	const original = process.env.HOME;
	try {
		const restore = hermetic.apply();
		try {
			assert.equal(process.env.HOME, hermetic.home);
			hermetic.assertIsolated();
			process.env.HOME = real;
			assert.throws(() => hermetic.assertIsolated(), /real home/);
			process.env.HOME = join(root, "elsewhere");
			assert.throws(() => hermetic.assertIsolated(), /not a hermetic HOME/);
		} finally {
			restore();
		}
		assert.equal(process.env.HOME, original);
	} finally {
		hermetic.dispose();
	}
});

test("termsLinesFrom reads only top-level terms keys", () => {
	const lines = termsLinesFrom(
		`# c\naccept_terms = "yes"\nother = 1\nterms_version="p"\n[x]\naccept_terms_at = "late"\n`,
	);
	assert.deepEqual(lines, ['accept_terms = "yes"', 'terms_version="p"']);
	assert.equal(termsAccepted(lines), true);
	assert.equal(termsAccepted(['accept_terms = "no"']), false);
});

test("synthesizeConfig covers every variant", () => {
	const now = new Date("2026-01-01T00:00:00Z");
	const terms = ['accept_terms = "yes"'];
	assert.match(
		synthesizeConfig("default", terms, now),
		/accept_terms[\s\S]*last_updated_at[\s\S]*user = true/,
	);
	assert.match(synthesizeConfig("user-false", terms, now), /user = false/);
	// MCP filtering and the browser budget are on in every variant but one (e2e case 11)…
	for (const variant of ["default", "user-false", "no-metadata", "no-terms"] as const) {
		const config = synthesizeConfig(variant, terms, now);
		assert.match(config, /\[feature_flags\."boost-mcp-filtering"\]\nuser = true\n/, variant);
		assert.match(config, /\[feature_flags\."boost-mcp-browser-budget"\]\nuser = true\n/, variant);
	}
	// …which records no MCP flag, so Boost's own default applies; the rest is the default HOME's.
	const unset = synthesizeConfig("mcp-unset", terms, now);
	assert.doesNotMatch(unset, /boost-mcp-/);
	assert.match(unset, /accept_terms[\s\S]*last_updated_at[\s\S]*"boost-cli-filtering"\]\nuser = true/);
	assert.doesNotMatch(synthesizeConfig("no-metadata", terms, now), /_metadata/);
	assert.doesNotMatch(synthesizeConfig("no-terms", terms, now), /accept_terms/);
});
