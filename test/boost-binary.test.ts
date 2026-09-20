import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
	isSupportedVersion,
	MIN_BOOST_VERSION,
	parseBoostVersion,
	resolveBoostBinary,
} from "../src/boost-binary.ts";

/** Pretend every path in `present` is an executable file and nothing else is. */
const onDisk = (...present: string[]) => {
	const set = new Set(present);
	return (path: string) => set.has(path);
};

test("BOOST_BIN wins over every other candidate", () => {
	const custom = "/opt/boost/bin/boost";
	const resolved = resolveBoostBinary({
		env: { BOOST_BIN: custom, PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk(custom, "/home/dev/.local/bin/boost", "/usr/bin/boost"),
	});
	assert.equal(resolved, custom);
});

test("an unusable BOOST_BIN falls through instead of disabling Boost", () => {
	const resolved = resolveBoostBinary({
		env: { BOOST_BIN: "/opt/missing/boost", PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk("/usr/bin/boost"),
	});
	assert.equal(resolved, "/usr/bin/boost");
});

test("the default install location is preferred over PATH", () => {
	const resolved = resolveBoostBinary({
		env: { PATH: "/usr/bin" },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk("/home/dev/.local/bin/boost", "/usr/bin/boost"),
	});
	assert.equal(resolved, join("/home/dev", ".local", "bin", "boost"));
});

test("PATH is searched in order when Boost is installed elsewhere", () => {
	const resolved = resolveBoostBinary({
		env: { PATH: ["/a", "/b"].join(delimiter) },
		platform: "linux",
		home: "/home/dev",
		isExecutable: onDisk("/b/boost"),
	});
	assert.equal(resolved, "/b/boost");
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
	assert.ok(!seen.includes("/.local/bin/boost"), seen.join(", "));
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
