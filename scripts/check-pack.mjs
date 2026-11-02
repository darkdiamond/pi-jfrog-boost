#!/usr/bin/env node
/**
 * `npm run check:pack`: asserts what the published tarball contains.
 *
 * The package ships TypeScript sources that pi loads directly, so whatever is
 * in the tarball runs inside every user's pi. This keeps it to exactly:
 *   src/**, skills/**, settings.schema.json, README.md, LICENSE, CHANGELOG.md
 *   and package.json
 * — no tests, fixtures, scripts or stray files — and checks the manifest
 * keeps the promises SECURITY.md makes: no runtime dependencies and no
 * lifecycle scripts that would run on install (only `prepublishOnly`, which
 * runs on the maintainer's side).
 *
 * Uses `npm pack --dry-run --json`, which builds the file list without
 * writing a tarball.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const problems = [];

/** Top-level files that must ship; settings.schema.json only once `files` lists it. */
const REQUIRED = ["package.json", "README.md", "LICENSE", "CHANGELOG.md"];
if (manifest.files?.includes("settings.schema.json")) REQUIRED.push("settings.schema.json");
const ALLOWED_FILES = new Set([...REQUIRED, "settings.schema.json"]);
const ALLOWED_DIRS = ["src/", "skills/"];

/** npm lifecycle scripts that run on someone else's machine or during pack/publish. */
const LIFECYCLE = [
	"preinstall",
	"install",
	"postinstall",
	"prepare",
	"preprepare",
	"postprepare",
	"prepack",
	"postpack",
	"prepublish",
	"publish",
	"postpublish",
	"preuninstall",
	"uninstall",
	"postuninstall",
	"dependencies",
];

const output = execFileSync(
	process.platform === "win32" ? "npm.cmd" : "npm",
	["pack", "--dry-run", "--json"],
	{
		cwd: repo,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: ["ignore", "pipe", "inherit"],
	},
);
const [pack] = JSON.parse(output);
const files = pack.files.map((file) => file.path.replace(/\\/g, "/")).sort();

for (const file of files) {
	const allowed = ALLOWED_FILES.has(file) || ALLOWED_DIRS.some((dir) => file.startsWith(dir));
	if (!allowed) problems.push(`unexpected file in the tarball: ${file}`);
	if (/\.test\.ts$|(^|\/)fixtures\//.test(file)) problems.push(`test material in the tarball: ${file}`);
}
for (const file of REQUIRED) {
	if (!files.includes(file)) problems.push(`missing from the tarball: ${file}`);
}
if (!files.some((file) => file.startsWith("src/") && file.endsWith(".ts"))) {
	problems.push("no TypeScript sources under src/ in the tarball");
}
for (const entry of manifest.pi?.extensions ?? []) {
	const path = entry.replace(/^\.\//, "");
	if (!files.includes(path)) problems.push(`pi.extensions entry ${entry} is not in the tarball`);
}

for (const name of LIFECYCLE) {
	if (manifest.scripts?.[name] !== undefined) problems.push(`lifecycle script "${name}" is not allowed`);
}
for (const field of ["dependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
	const value = manifest[field];
	if (value && (Array.isArray(value) ? value.length : Object.keys(value).length)) {
		problems.push(`"${field}" must stay empty: this package has no runtime dependencies`);
	}
}

if (problems.length > 0) {
	process.stderr.write(`check-pack: ${problems.length} problem(s):\n  ${problems.join("\n  ")}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`check-pack: ok — ${files.length} files, ${pack.size} bytes packed\n`);
}
