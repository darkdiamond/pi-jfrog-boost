import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import {
	atLeast,
	binaryStamp,
	compareVersions,
	FLAGS_MIN_VERSION,
	isExecutableFile,
	isSupportedVersion,
	MCP_MIN_VERSION,
	MIN_BOOST_VERSION,
	onPath,
	parseBoostVersion,
	resolveBoostBinary,
	VALIDATED_BOOST_VERSION,
} from "../src/boost-binary.ts";

const root = mkdtempSync(join(tmpdir(), "pi-jfrog-boost-bin-"));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * Pretend every path in `present` is an executable file and nothing else is.
 * Segments are joined the way the resolver joins them, so a fixture written as
 * ["/usr/bin", "boost"] matches on Windows too, where that is `\usr\bin\boost`.
 */
const onDisk = (...present: (string | string[])[]) => {
	const set = new Set(present.map((p) => (Array.isArray(p) ? join(...p) : p)));
	return (path: string) => set.has(path);
};

const localBin = (home: string, name = "boost") => join(home, ".local", "bin", name);

test("BOOST_BIN wins over every other candidate", () => {
	const custom = "/opt/boost/bin/boost";
	const resolved = resolveBoostBinary({
		env: { BOOST_BIN: custom, PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk(custom, localBin("/home/dev"), ["/usr/bin", "boost"]),
	});
	assert.equal(resolved, custom);
});

test("an unusable BOOST_BIN falls through instead of disabling Boost", () => {
	const resolved = resolveBoostBinary({
		env: { BOOST_BIN: "/opt/missing/boost", PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk(["/usr/bin", "boost"]),
	});
	assert.equal(resolved, join("/usr/bin", "boost"));
});

test("the default install location is preferred over PATH", () => {
	const resolved = resolveBoostBinary({
		env: { PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk(localBin("/home/dev"), ["/usr/bin", "boost"]),
	});
	assert.equal(resolved, localBin("/home/dev"));
});

test("PATH is searched in order when Boost is installed elsewhere", () => {
	const resolved = resolveBoostBinary({
		env: { PATH: ["/a", "/b"].join(delimiter) },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk(["/b", "boost"]),
	});
	assert.equal(resolved, join("/b", "boost"));
});

test("Windows finds boost.exe under LOCALAPPDATA", () => {
	const winHome = "C:\\Users\\dev";
	const appData = "C:\\Users\\dev\\AppData\\Local";
	const expected = join(appData, "boost", "bin", "boost.exe");
	const resolved = resolveBoostBinary({
		env: { LOCALAPPDATA: appData, PATH: "C:\\Windows" },
		platform: "win32",
		home: winHome,
		isExecutable: onDisk(expected),
	});
	assert.equal(resolved, expected);
});

test("no Boost anywhere resolves to undefined rather than a guessed path", () => {
	const resolved = resolveBoostBinary({
		env: { PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk(),
	});
	assert.equal(resolved, undefined);
});

test("an empty environment does not produce a bogus /.local/bin path", () => {
	const seen: string[] = [];
	resolveBoostBinary({
		env: {},
		platform: "linux",
		home: "/home/dev",
		isExecutable: (path) => {
			seen.push(path);
			return false;
		},
	});
	assert.ok(!seen.includes(localBin("")), seen.join(", "));
});

test("parseBoostVersion reads the `boost v0.13.24` banner", () => {
	assert.deepEqual(parseBoostVersion("boost v0.13.24 \n"), [0, 13, 24]);
	assert.equal(parseBoostVersion("not a version"), undefined);
});

test("isSupportedVersion gates on the release that added the hook protocol", () => {
	assert.equal(isSupportedVersion(MIN_BOOST_VERSION), true);
	assert.equal(isSupportedVersion([0, 13, 24]), true);
	assert.equal(isSupportedVersion([1, 0, 0]), true);
	assert.equal(isSupportedVersion([0, 14, 0]), true);
	assert.equal(isSupportedVersion([0, 13, 12]), false);
	assert.equal(isSupportedVersion([0, 12, 99]), false);
	assert.equal(isSupportedVersion(undefined), false);
});

test("BOOST_EXE is an alias that comes right after BOOST_BIN", () => {
	const exe = "/opt/alias/boost";
	const both = resolveBoostBinary({
		env: { BOOST_BIN: "/opt/primary/boost", BOOST_EXE: exe, PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk("/opt/primary/boost", exe, localBin("/home/dev")),
	});
	assert.equal(both, "/opt/primary/boost");
	const alias = resolveBoostBinary({
		env: { BOOST_EXE: exe, PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk(exe, localBin("/home/dev")),
	});
	assert.equal(alias, exe, "the alias beats the default install location");
});

test("on Windows a .exe anywhere beats an extensionless boost anywhere", () => {
	// Drive-less paths: PATH is split on the host's delimiter, and `C:` would
	// split on POSIX hosts.
	const script = join("/tools", "boost");
	const exe = join("/bin", "boost.exe");
	const resolved = resolveBoostBinary({
		env: { BOOST_BIN: script, PATH: "/bin" },
		platform: "win32",
		home: "C:\\Users\\dev",
		isExecutable: onDisk(script, exe),
	});
	assert.equal(resolved, exe);
	const onlyScript = resolveBoostBinary({
		env: { BOOST_BIN: script },
		platform: "win32",
		home: "C:\\Users\\dev",
		isExecutable: onDisk(script),
	});
	assert.equal(onlyScript, script, "with no .exe anywhere the script is still used");
});

test("a directory named boost is rejected, a regular executable file is accepted", () => {
	const home = join(root, "home");
	mkdirSync(join(home, ".local", "bin", "boost"), { recursive: true });
	assert.equal(isExecutableFile(join(home, ".local", "bin", "boost")), false);
	assert.equal(
		resolveBoostBinary({ env: { BOOST_BIN: join(home, ".local", "bin", "boost") }, platform: "linux", home }),
		undefined,
		"neither BOOST_BIN nor the default location may resolve to a directory",
	);
	const file = join(root, "boost-file");
	writeFileSync(file, "#!/bin/sh\n");
	chmodSync(file, 0o755);
	assert.equal(isExecutableFile(file), true);
});

test("a file without the execute bit is rejected", {
	skip: process.platform === "win32" && "no X_OK on Windows",
}, () => {
	const file = join(root, "not-executable");
	writeFileSync(file, "#!/bin/sh\n");
	chmodSync(file, 0o644);
	assert.equal(isExecutableFile(file), false);
});

test("onPath: true only when the first boost on PATH is this binary", () => {
	const name = process.platform === "win32" ? "boost.exe" : "boost";
	const a = join(root, "path-a");
	const b = join(root, "path-b");
	mkdirSync(a, { recursive: true });
	mkdirSync(b, { recursive: true });
	for (const dir of [a, b]) {
		writeFileSync(join(dir, name), "");
		chmodSync(join(dir, name), 0o755);
	}
	assert.equal(onPath(join(a, name), { PATH: [a, b].join(delimiter) }), true);
	assert.equal(onPath(join(b, name), { PATH: [a, b].join(delimiter) }), false, "shadowed by another boost");
	assert.equal(onPath(join(b, name), { PATH: [root].join(delimiter) }), false, "not on PATH at all");
	if (process.platform !== "win32") {
		const link = join(root, "path-link");
		mkdirSync(link, { recursive: true });
		symlinkSync(join(b, name), join(link, name));
		assert.equal(onPath(join(b, name), { PATH: link }), true, "a symlink to it counts");
	}
});

test("binaryStamp changes when the binary is replaced, and is undefined when it is gone", () => {
	const file = join(root, "stamped");
	writeFileSync(file, "v1");
	const first = binaryStamp(file);
	assert.ok(first);
	writeFileSync(file, "version 2");
	utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
	const second = binaryStamp(file);
	assert.notDeepEqual(second, first);
	rmSync(file);
	assert.equal(binaryStamp(file), undefined);
	assert.equal(binaryStamp(root), undefined, "a directory has no stamp");
});

test("the version constants and comparisons", () => {
	assert.deepEqual(VALIDATED_BOOST_VERSION, [0, 15, 4]);
	assert.deepEqual(FLAGS_MIN_VERSION, [0, 14, 6]);
	assert.deepEqual(MCP_MIN_VERSION, [0, 15, 3]);
	assert.ok(compareVersions([0, 15, 4], [0, 15, 3]) > 0);
	assert.ok(compareVersions([0, 9, 0], [0, 10, 0]) < 0);
	assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
	assert.equal(atLeast([0, 15, 3], MCP_MIN_VERSION), true);
	assert.equal(atLeast([0, 15, 2], MCP_MIN_VERSION), false);
	assert.equal(atLeast(undefined, MCP_MIN_VERSION), false);
});
