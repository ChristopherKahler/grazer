#!/usr/bin/env node
/**
 * Run the vendored harness's own real-browser e2e suite against Grazer.
 *
 *   node test/support/harness-runner.mjs                     # every case
 *   node test/support/harness-runner.mjs --only "nodejs bridge smoke"
 *
 * This is a tool, not a `node --test` suite: it starts a headless Grazer
 * browser on a throwaway GRAZER_HOME, puts bin/ first on PATH so the harness's
 * `spawn("grazer", ...)` resolves grazer.exe, runs the suite, prints the case
 * table, and stops the browser. Exit code is the suite's own.
 *
 * The suite is the closest thing Grazer has to a conformance test, so this
 * reports what it finds. Cases that fail because a capability has not landed
 * yet are printed as failures, not filtered out.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { findChromium } from "./chromium.mjs";
import { ensureHarnessBundle, PACKAGE_ROOT } from "./harness-bundle.mjs";
import { withSuiteLock } from "./suite-lock.mjs";

const BIN_DIR = join(PACKAGE_ROOT, "bin");
const GRAZER_EXE = join(BIN_DIR, "grazer.exe");
const HARNESS_DIR = join(PACKAGE_ROOT, "packages", "harness");
const SUITE = join("scripts", "run-real-browser-e2e.mjs");

/**
 * Run a command and resolve when the PROCESS exits, not when its pipes close.
 * `grazer browser start` hands its inherited stdout to a detached browser, so
 * waiting for stream EOF never returns even though the command itself is done.
 */
function run(command, args, { cwd = PACKAGE_ROOT, env, echo = false, timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (echo) process.stderr.write(chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, spawnError: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // The process is gone; give its pipes a moment to deliver what is left.
      setTimeout(() => resolvePromise({ code, stdout, stderr, timedOut: false }), 150);
    });
  });
}

const isAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Last resort after `browser stop`: kill the browser's whole process tree.
 * Chrome's renderers and GPU process are children, so killing the parent alone
 * leaves them behind on Windows.
 */
async function killIfAlive(pid) {
  if (!isAlive(pid)) return;
  process.stdout.write(`[harness-runner] browser pid ${pid} survived stop; killing the tree\n`);
  await new Promise((done) => {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        .once("exit", done)
        .once("error", done);
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      done();
    }
  });
}

/** The last few non-empty lines, for reporting a death without a wall of text. */
function lastLines(text, count) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .map((line) => `    ${line}`)
    .join("\n");
}

/** Pull the runner's own case table out of its output. */
export function parseCaseTable(output) {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "Cases:");
  if (start === -1) return [];
  const cases = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s{4}(.+?)\s{2,}\S*\s*(?:(\d+) assertions|-)\s+(PASS|FAIL|SKIP)\s*$/.exec(line);
    if (!match) {
      if (line.trim() === "") continue;
      break;
    }
    cases.push({
      name: match[1].trim(),
      assertions: match[2] ? Number(match[2]) : null,
      status: match[3],
    });
  }
  return cases;
}

export async function runHarnessSuite({ only = "", keep = false } = {}) {
  const executable = findChromium();
  if (!executable) {
    return { ok: false, reason: "no Chromium found (set GRAZER_BROWSER)", cases: [] };
  }
  const bundle = await ensureHarnessBundle();
  if (!bundle) {
    return { ok: false, reason: "harness bundle not built (npm run harness:build)", cases: [] };
  }

  const home = await mkdtemp(join(tmpdir(), "grazer-harness-"));
  const separator = process.platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    GRAZER_HOME: home,
    GRAZER_BROWSER: executable,
    // bin/ first so the harness's spawn("grazer", ...) finds grazer.exe.
    PATH: [BIN_DIR, process.env.PATH ?? ""].filter(Boolean).join(separator),
    GRAZER_REAL_E2E_ONLY: only,
  };

  let browserStarted = false;
  let browserPid = null;

  /**
   * Stop the browser, then make sure it is actually gone.
   *
   * `grazer browser stop` is the polite path, but it can fail — it once printed
   * nothing at all after the suite died mid-run — and a browser left alive
   * holds its profile directory open and keeps eight chrome.exe processes on
   * the machine until someone notices. So the pid from `browser start` is kept
   * and the process tree is killed if it survives the stop.
   */
  const stopBrowser = async () => {
    if (!browserStarted) return;
    browserStarted = false;
    const stopped = await run(GRAZER_EXE, ["browser", "stop"], { env, timeoutMs: 60_000 });
    const said = (stopped.stdout || stopped.stderr).trim() || "(no output)";
    process.stdout.write(`\n[harness-runner] browser stop: ${said} (exit ${stopped.code})\n`);
    await killIfAlive(browserPid);
  };

  /**
   * Delete the throwaway home, and never let that failure become the result.
   * Windows holds the browser's profile files open for a moment after the
   * process dies, so an unlink here can hit EBUSY — which is worth a line of
   * output and nothing more. Throwing would replace the suite's real verdict
   * with an unrelated crash.
   */
  const cleanUpHome = async () => {
    if (keep) {
      process.stdout.write(`[harness-runner] kept ${home}\n`);
      return;
    }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await rm(home, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 5) {
          process.stdout.write(`[harness-runner] could not remove ${home}: ${error.code ?? error.message}\n`);
          return;
        }
        await new Promise((wait) => setTimeout(wait, 300 * attempt));
      }
    }
  };
  // A killed wrapper must not leave a browser behind.
  const onSignal = () => { void stopBrowser().finally(() => process.exit(130)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const started = await run(GRAZER_EXE, ["browser", "start", "--headless"], { env, timeoutMs: 120_000 });
    if (started.code !== 0) {
      return { ok: false, reason: `browser start failed: ${(started.stderr || started.stdout).trim()}`, cases: [] };
    }
    browserStarted = true;
    // "started Chrome/152... on port 51827 (pid 65424)" — keep the pid so
    // teardown can confirm the browser really died.
    browserPid = Number(/\(pid (\d+)\)/.exec(started.stdout)?.[1]) || null;
    process.stdout.write(`[harness-runner] ${started.stdout.trim()}\n`);
    process.stdout.write(`[harness-runner] GRAZER_HOME=${home}\n`);
    process.stdout.write(`[harness-runner] running ${only ? `only: ${only}` : "every case"}\n\n`);

    const suite = await run(process.execPath, [SUITE], { cwd: HARNESS_DIR, env, echo: true });
    const cases = parseCaseTable(suite.stdout);
    // No table at all means the suite died before it ran a case — its own
    // build step, usually. Say so with the tail of what it printed, rather
    // than reporting a blank list that reads like "nothing was wrong".
    const diedEarly = cases.length === 0 && suite.code !== 0;
    return {
      ok: suite.code === 0 && !suite.timedOut,
      code: suite.code,
      timedOut: suite.timedOut === true,
      reason: suite.timedOut
        ? "the suite timed out"
        : diedEarly
          ? `the suite exited ${suite.code} before running a case:\n${lastLines(suite.stdout + suite.stderr, 6)}`
          : null,
      cases,
      home,
    };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await stopBrowser();
    await cleanUpHome();
  }
}

function parseArgs(argv) {
  const args = { only: "", keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") args.only = argv[++i] ?? "";
    else if (argv[i].startsWith("--only=")) args.only = argv[i].slice("--only=".length);
    else if (argv[i] === "--keep") args.keep = true;
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return args;
}

// pathToFileURL, not string surgery: on Windows import.meta.url is
// file:///C:/... with three slashes, so a hand-built file://C:/... never matches
// and the tool would silently do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  // Law 11: this tool starts a full browser, so it queues behind any suite that
  // is already running rather than piling onto the same CPU.
  const result = await withSuiteLock("harness-runner", () => runHarnessSuite(args));

  process.stdout.write("\n[harness-runner] summary\n");
  if (result.reason) process.stdout.write(`  ${result.reason}\n`);
  for (const entry of result.cases) {
    process.stdout.write(`  ${entry.status.padEnd(4)}  ${entry.name}\n`);
  }
  const failed = result.cases.filter((entry) => entry.status === "FAIL");
  if (failed.length > 0) {
    process.stdout.write(`  ${failed.length} of ${result.cases.length} cases failed\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
