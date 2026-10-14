/**
 * End-to-end: the Grazer CLI driving a real Chromium through the real harness
 * bundle.
 *
 * Everything here goes through `bin/grazer.mjs` rather than the library, because
 * the CLI is what an agent actually runs — the exit codes, the stdin heredoc,
 * and the detached browser surviving between invocations are the product.
 *
 * Skips cleanly when there is no Chromium or no built bundle.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { before } from "node:test";

import {
  findChromium,
  makeProfileDir,
  removeProfileDir,
  waitFor,
} from "./support/chromium.mjs";
import { ensureHarnessBundle, PACKAGE_ROOT } from "./support/harness-bundle.mjs";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

const CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");

/** Run the Grazer CLI, optionally piping a heredoc into it. */
function runCli(args, { input, env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut: false });
    });
    child.stdin.end(input ?? "");
  });
}

/** A tiny fixture site, so the test never depends on the network. */
function startFixtureServer() {
  return new Promise((resolvePromise) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>grazer fixture</title></head><body><h1 id="t">grazer fixture</h1></body></html>`,
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const executable = findChromium();
const bundlePath = executable ? await ensureHarnessBundle() : null;
const skipReason = !executable
  ? "no Chromium found (set GRAZER_BROWSER)"
  : !bundlePath
    ? "harness bundle not built (npm run harness:build)"
    : false;

/**
 * Law 11: one browser-launching suite at a time, machine-wide.
 *
 * Held for the whole FILE rather than per test — releasing between this file's
 * own tests would let another suite interleave, which is exactly what the lock
 * exists to prevent.
 */
let suiteLock;
before(async () => {
  if (skipReason) return;
  suiteLock = await acquireSuiteLock("harness-e2e");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


test(
  "grazer CLI drives a real Chromium through the harness bundle",
  { skip: skipReason },
  async (t) => {
    const grazerHome = await makeProfileDir("grazer-e2e-home-");
    const env = { GRAZER_HOME: grazerHome, GRAZER_BROWSER: executable };
    let fixture;
    let startedPid = null;

    t.after(async () => {
      await fixture?.close().catch(() => {});
      await runCli(["browser", "stop"], { env }).catch(() => {});
      await removeProfileDir(grazerHome);
    });

    // ---- AC-4: no browser yet, and it must fail fast --------------------
    const startedAt = Date.now();
    const noBrowser = await runCli(["nodejs"], {
      input: 'console.log("never")\n',
      env,
      timeoutMs: 10_000,
    });
    assert.equal(noBrowser.code, 3, `expected exit 3, got ${noBrowser.code}`);
    assert.match(noBrowser.stderr, /browser is not running/i);
    assert.match(noBrowser.stderr, /grazer browser start/);
    assert.ok(
      Date.now() - startedAt < 5000,
      `AC-4 must fail within 5s, took ${Date.now() - startedAt}ms`,
    );

    // ---- AC-1: browser start / status ------------------------------------
    const start = await runCli(["browser", "start", "--headless"], { env });
    assert.equal(start.code, 0, `browser start failed: ${start.stderr}`);

    const statePath = join(grazerHome, "browser.json");
    assert.ok(existsSync(statePath), "browser.json was written");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    for (const key of [
      "port",
      "wsUrl",
      "pid",
      "startedAt",
      "profileDir",
      "executable",
    ]) {
      assert.ok(state[key] !== undefined, `browser.json is missing ${key}`);
    }
    startedPid = state.pid;
    assert.ok(pidAlive(startedPid), "the browser process is alive");

    const status = await runCli(["browser", "status"], { env });
    assert.equal(status.code, 0);
    assert.match(status.stdout, /^(Chrome|HeadlessChrome|Brave)\//);

    // ---- AC-2: the harness's own bridge smoke, verbatim -------------------
    const marker = `GRAZER_NODEJS_BRIDGE_SMOKE_${Date.now()}`;
    const smokeSource = `
      console.log(${JSON.stringify(marker)});
      console.log(JSON.stringify({
        grazerType: typeof globalThis.grazer,
        hasSendCDPMessage: typeof globalThis.grazer?.sendCDPMessage,
        processVersion: process.version,
        helperCount: Object.keys(globalThis.grazer?.helpers || {}).length
      }));
    `;
    const smoke = await runCli(["nodejs", "--sdk-path", bundlePath], {
      input: smokeSource,
      env,
    });
    assert.equal(smoke.code, 0, `smoke failed: ${smoke.stderr}`);
    assert.ok(smoke.stdout.includes(marker), "the marker line round-tripped");

    const probeLine = smoke.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("{"));
    assert.ok(probeLine, `no JSON line in smoke stdout: ${smoke.stdout}`);
    const probe = JSON.parse(probeLine);
    assert.equal(probe.grazerType, "object");
    assert.equal(probe.hasSendCDPMessage, "function");
    assert.equal(typeof probe.processVersion, "string");
    // helperCount > 0 is the real proof installGrazerSdk ran on our host: it
    // sets grazer.helpers and the console.log override in the same call.
    assert.ok(probe.helperCount > 0, `helperCount was ${probe.helperCount}`);

    // ---- AC-3a: evaluate through the harness's own helper -----------------
    const evaluated = await runCli(["nodejs"], {
      input: 'console.log(await page.evaluate("1+1"))\n',
      env,
    });
    assert.equal(evaluated.code, 0, `evaluate failed: ${evaluated.stderr}`);
    assert.equal(evaluated.stdout.trim(), "2");

    // ---- AC-3b: navigate a fixture, read the h1, list the tabs ------------
    fixture = await startFixtureServer();
    const navigated = await runCli(["nodejs"], {
      input: [
        `await page.goto(${JSON.stringify(fixture.url)})`,
        'console.log(await page.locator("#t").textContent())',
        "console.log(JSON.stringify(await browser.listTabs()))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(navigated.code, 0, `navigate failed: ${navigated.stderr}`);
    assert.match(navigated.stdout, /grazer fixture/);

    const tabsLine = navigated.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("["));
    assert.ok(tabsLine, `no tabs JSON in stdout: ${navigated.stdout}`);
    const tabs = JSON.parse(tabsLine);
    const activeTabs = tabs.filter((tab) => tab.active);
    assert.equal(activeTabs.length, 1, "exactly one tab is active");
    assert.equal(activeTabs[0].url, fixture.url);
    assert.equal(typeof activeTabs[0].targetId, "string");
    assert.equal(typeof activeTabs[0].index, "number");

    // ---- AC-3c: a throwing heredoc ---------------------------------------
    const threw = await runCli(["nodejs"], {
      input: 'throw new Error("boom")\n',
      env,
    });
    assert.equal(threw.code, 1, `expected exit 1, got ${threw.code}`);
    assert.match(threw.stderr, /boom/);

    // ---- usage: an empty heredoc -----------------------------------------
    const empty = await runCli(["nodejs"], { input: "   \n", env });
    assert.equal(empty.code, 2, `expected exit 2, got ${empty.code}`);

    // ---- AC-4 again: a stale descriptor is an environment error ----------
    const stopped = await runCli(["browser", "stop"], { env });
    assert.equal(stopped.code, 0, `browser stop failed: ${stopped.stderr}`);
    await waitFor(() => !pidAlive(startedPid), {
      label: "the browser process to exit",
      timeoutMs: 15_000,
    });
    assert.ok(!existsSync(statePath), "browser.json was removed on stop");

    const afterStop = await runCli(["browser", "status"], { env });
    assert.equal(afterStop.code, 1);
    assert.match(afterStop.stderr, /not running/i);
  },
);
