#!/usr/bin/env node
/**
 * `npm run test:clean` — kill browsers left over from test profiles and remove
 * the directories.
 *
 * Only touches processes whose command line names a profile THIS repo's tests
 * registered. The developer's own Chrome is never a candidate: matching on the
 * registry rather than on the executable is the whole safety property.
 *
 * Removal retries with backoff because Chrome holds file locks in its profile
 * past process exit — the reason these directories accumulate at all.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readRegistry, writeRegistry } from "./profile-registry.mjs";

/** Processes whose command line mentions one of `paths`. Windows-only. */
async function findProcesses(paths) {
  if (process.platform !== "win32" || paths.length === 0) return [];
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='brave.exe'\" | " +
    "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const json = await new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("error", () => resolve(""));
    child.once("exit", () => resolve(out));
  });
  let rows;
  try {
    const parsed = JSON.parse(json || "[]");
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  return rows
    .filter((row) => row?.CommandLine && paths.some((path) => row.CommandLine.includes(path)))
    .map((row) => ({ pid: row.ProcessId, path: paths.find((p) => row.CommandLine.includes(p)) }));
}

/** Kill a process tree. Chrome's children outlive a kill of the parent alone. */
function killTree(pid) {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Remove a directory, retrying while Chrome still holds its locks. */
async function removeWithBackoff(dir, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      if (!existsSync(dir)) return true;
    } catch {
      // Fall through to the wait; a locked directory is the expected case.
    }
    await sleep(200 * 2 ** i);
  }
  return !existsSync(dir);
}

/**
 * Every `grazer-*` DIRECTORY under the temp dir.
 *
 * The registry only sees profiles created through `makeProfileDir`; a suite
 * that mkdtemps its own `GRAZER_HOME` leaves a directory nothing recorded.
 * Sweeping the temp dir catches those, and is safe because the product keeps
 * its home under %LOCALAPPDATA%\\Grazer — a `grazer-*` directory in tmpdir is
 * always test-created.
 *
 * Processes are NOT killed on this basis. Killing stays keyed to the registry,
 * so nothing here can reach a browser this repo did not start.
 */
function sweepTempDirs() {
  try {
    return readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("grazer-"))
      .map((entry) => join(tmpdir(), entry.name));
  } catch {
    return [];
  }
}

export async function cleanProfiles({ log = console.log } = {}) {
  const registered = readRegistry();
  const swept = sweepTempDirs();
  if (registered.length === 0 && swept.length === 0) {
    log("test:clean — nothing registered and no temp profiles, nothing to do");
    return { killed: 0, removed: 0, remaining: [] };
  }

  const live = [...new Set([...registered, ...swept])].filter((dir) => existsSync(dir));
  const processes = await findProcesses(live);
  let killed = 0;
  for (const proc of processes) {
    if (await killTree(proc.pid)) {
      killed += 1;
      log(`test:clean — killed pid ${proc.pid} (${proc.path})`);
    }
  }
  if (killed > 0) await sleep(1_000);

  let removed = 0;
  const remaining = [];
  for (const dir of live) {
    if (await removeWithBackoff(dir)) removed += 1;
    else remaining.push(dir);
  }

  // Keep only registry rows that are still on disk, so a later run can retry
  // them; a swept directory was never a registry row and must not become one.
  await writeRegistry(remaining.filter((dir) => registered.includes(dir)));
  const stale = registered.filter((dir) => !existsSync(dir)).length;
  log(
    `test:clean — ${killed} browser(s) killed, ${removed} profile(s) removed, ` +
      `${remaining.length} still locked, ${stale} stale registry entry(ies) pruned`,
  );
  for (const dir of remaining) log(`  still locked: ${dir}`);
  return { killed, removed, remaining };
}

// Run when invoked directly; stay importable for the unit test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await cleanProfiles();
}
