#!/usr/bin/env node
// Build the Windows release package: release/grazer-windows.zip.
//
//   npm run package                 from a clean, committed tree
//   npm run package -- --allow-dirty   while iterating (still packages HEAD only)
//
// The package is built from `git archive HEAD` in a temporary folder, never
// from this working copy, so nothing uncommitted, ignored or personal (build
// worktrees, planning notes, local test homes) can reach a release.
//
// Output, in release/:
//   grazer-windows.zip         grazer/ folder: built code, extension, skill, installers
//   grazer-windows.zip.sha256  its checksum
//   install.ps1                the installer, also published on its own for the one-liner

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "release");
const WINDOWS_TAR = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** What ships, relative to the built tree. Everything else stays out. */
const SHIP = [
  "package.json",
  "LICENSE",
  "README.md",
  "install.ps1",
  "uninstall.ps1",
  "bin/grazer.mjs",
  "bin/grazer.exe",
  "bin/grazer-sync.mjs",
  "bin/grazer-replay.mjs",
  "bin/grazer-native-host.cmd",
  "dist",
  "packages/harness/dist/out",
  "packages/harness/LICENSE",
  "extension",
  "skills/grazer",
];

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit", shell: command === NPM });
}

function main() {
  const allowDirty = process.argv.includes("--allow-dirty");
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (status && !allowDirty) {
    console.error("The working tree has uncommitted changes. Commit them, or pass --allow-dirty to package HEAD anyway.");
    process.exit(1);
  }
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

  const work = mkdtempSync(join(tmpdir(), "grazer-package-"));
  try {
    const tree = join(work, "tree");
    mkdirSync(tree);
    const tarball = join(work, "head.tar");
    run("git", ["archive", "--format=tar", "-o", tarball, "HEAD"], ROOT);
    run(WINDOWS_TAR, ["-xf", tarball, "-C", tree], ROOT);

    run(NPM, ["ci", "--no-audit", "--no-fund"], tree);
    run(NPM, ["run", "build"], tree);
    run(NPM, ["run", "harness:build"], tree);

    const version = JSON.parse(readFileSync(join(tree, "package.json"), "utf8")).version;
    const stage = join(work, "stage");
    const packageDir = join(stage, "grazer");
    for (const relative of SHIP) {
      const from = join(tree, relative);
      if (!existsSync(from)) throw new Error(`missing from the build: ${relative}`);
      cpSync(from, join(packageDir, relative), {
        recursive: true,
        filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts"),
      });
    }

    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const zip = join(OUT, "grazer-windows.zip");
    run(WINDOWS_TAR, ["-a", "-cf", zip, "-C", stage, "grazer"], ROOT);
    cpSync(join(tree, "install.ps1"), join(OUT, "install.ps1"));

    const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
    writeFileSync(join(OUT, "grazer-windows.zip.sha256"), `${sha}  grazer-windows.zip\n`);
    console.log(`\nGrazer ${version} (${head}) packaged:\n  ${zip}\n  sha256 ${sha}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
