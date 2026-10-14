/**
 * Downloads inside a task space.
 *
 * The harness conformance case `download helpers` reported
 * `Download canceled: sample-download.txt`. These tests use the harness's own
 * download path (`page.waitForEvent("download")`, which sets
 * `Browser.setDownloadBehavior` and waits for `Page.downloadWillBegin` then a
 * terminal `Page.downloadProgress`) and run it twice: once in the default
 * browser context and once inside a task space.
 *
 * The A/B is the diagnosis. `Browser.setDownloadBehavior` applies to the
 * default browser context when `browserContextId` is omitted, and a task space
 * is its own context — so if the default-context download completes and the
 * task-space one cancels, the scope is the cause.
 *
 * Skips cleanly without a Chromium or a built dist.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { findChromium } from "./support/chromium.mjs";
import { ensureHarnessBundle, PACKAGE_ROOT } from "./support/harness-bundle.mjs";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

const CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");
const HOST = join(PACKAGE_ROOT, "dist", "host", "host.js");
const FILE_BODY = "grazer download probe\n";
const FILE_NAME = "sample-download.txt";

/** Run the Grazer CLI. Resolves on process exit, never on pipe EOF. */
function runCli(args, { input, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_ROOT,
      env,
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
      setTimeout(() => resolvePromise({ code, stdout, stderr }), 150);
    });
    child.stdin.end(input ?? "");
  });
}

function startDownloadSite() {
  const server = createServer((req, res) => {
    if (req.url.startsWith("/file")) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${FILE_NAME}"`,
        "content-length": Buffer.byteLength(FILE_BODY),
      });
      res.end(FILE_BODY);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body><a id="dl" href="/file" download>get</a></body></html>');
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The harness's own download path, optionally inside a task space. */
function downloadScript(origin, { inTaskSpace }) {
  return `
    ${inTaskSpace ? 'await taskSpaces.useOrCreate("download-probe-" + Date.now());' : ""}
    await page.goto(${JSON.stringify(origin + "/")});

    const targets = await cdp("Target.getTargets", {});
    const contexts = [...new Set((targets.targetInfos || [])
      .filter((t) => t.type === "page")
      .map((t) => t.browserContextId)
      .filter(Boolean))];
    console.log("GRZ_CONTEXTS " + JSON.stringify(contexts));

    let outcome;
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 15000 }),
        page.locator("#dl").click(),
      ]);
      outcome = "completed:" + download.suggestedFilename();
    } catch (error) {
      outcome = "failed:" + (error && error.message ? error.message : String(error));
    }
    console.log("GRZ_OUTCOME " + outcome);
  `;
}

const executable = findChromium();
const bundle = executable ? await ensureHarnessBundle() : null;
const skipReason = !executable
  ? "no Chromium found (set GRAZER_BROWSER)"
  : !existsSync(HOST)
    ? "dist/host/host.js is not built — run npm run build"
    : !bundle
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
  suiteLock = await acquireSuiteLock("downloads.live");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


/** Start a browser, run both probes against it, tear everything down. */
async function withBrowser(body) {
  const home = await mkdtemp(join(tmpdir(), "grazer-downloads-"));
  const site = await startDownloadSite();
  const env = { ...process.env, GRAZER_HOME: home, GRAZER_BROWSER: executable };
  const started = await runCli(["browser", "start", "--headless"], { env });
  assert.equal(started.code, 0, `browser start failed: ${started.stderr}`);
  const pid = Number(/\(pid (\d+)\)/.exec(started.stdout)?.[1]) || null;
  try {
    return await body({ env, site });
  } finally {
    await runCli(["browser", "stop"], { env });
    if (pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
    await site.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

const read = (stdout, key) => new RegExp(`GRZ_${key} (.*)`).exec(stdout)?.[1]?.trim();

test("a download in a task space completes, exactly as one in the default context does", async (t) => {
  if (skipReason) return t.skip(skipReason);

  await withBrowser(async ({ env, site }) => {
    const control = await runCli(["nodejs"], {
      env,
      input: downloadScript(site.origin, { inTaskSpace: false }),
    });
    assert.equal(control.code, 0, `control probe failed to run: ${control.stderr}`);
    const controlOutcome = read(control.stdout, "OUTCOME");
    t.diagnostic(`default context: ${controlOutcome}`);
    t.diagnostic(`default context page contexts: ${read(control.stdout, "CONTEXTS")}`);

    const spaced = await runCli(["nodejs"], {
      env,
      input: downloadScript(site.origin, { inTaskSpace: true }),
    });
    assert.equal(spaced.code, 0, `task-space probe failed to run: ${spaced.stderr}`);
    const spacedOutcome = read(spaced.stdout, "OUTCOME");
    t.diagnostic(`task space: ${spacedOutcome}`);
    t.diagnostic(`task space page contexts: ${read(spaced.stdout, "CONTEXTS")}`);

    assert.ok(
      controlOutcome?.startsWith("completed:"),
      `the control download should complete in the default context, got ${controlOutcome}`,
    );
    assert.ok(
      spacedOutcome?.startsWith("completed:"),
      `a download inside a task space should complete too, got ${spacedOutcome}`,
    );
    assert.equal(spacedOutcome, `completed:${FILE_NAME}`);
  });
});
