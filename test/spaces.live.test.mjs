/**
 * Task spaces end to end: the Grazer CLI, a real Chromium, and the real harness
 * bundle driving `taskSpaces.*` through heredocs.
 *
 * Everything runs through `bin/grazer.mjs` because the one-process-per-heredoc
 * model IS the thing under test — a space that only survives inside one Node
 * invocation would pass a library-level test and fail the product.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { findChromium, removeProfileDir } from "./support/chromium.mjs";
import { ensureHarnessBundle, PACKAGE_ROOT } from "./support/harness-bundle.mjs";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

const CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");

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
      resolvePromise({ code, stdout, stderr, timedOut: false, all: `${stdout}\n${stderr}` });
    });
    child.stdin.end(input ?? "");
  });
}

/** `/set` issues a cookie; everything else is a plain page. */
function startFixtureServer() {
  return new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      const headers = { "content-type": "text/html; charset=utf-8" };
      if (request.url === "/set") {
        headers["set-cookie"] = "grazer=isolated; Path=/";
      }
      response.writeHead(200, headers);
      response.end(
        `<!doctype html><html><head><title>grazer fixture</title></head><body><h1 id="t">grazer fixture</h1></body></html>`,
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** The last line of stdout that parses as JSON — heredocs print one per run. */
function lastJson(result) {
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Not the JSON line; keep looking backwards.
    }
  }
  throw new Error(`no JSON line in stdout:\n${result.stdout}\n${result.stderr}`);
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
  suiteLock = await acquireSuiteLock("spaces.live");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


test(
  "task spaces through the harness against a real browser",
  { skip: skipReason },
  async (t) => {
    const grazerHome = await mkdtemp(join(tmpdir(), "grazer-spaces-live-"));
    const env = { GRAZER_HOME: grazerHome, GRAZER_BROWSER: executable };
    let fixture;

    t.after(async () => {
      await fixture?.close().catch(() => {});
      await runCli(["browser", "stop"], { env }).catch(() => {});
      await removeProfileDir(grazerHome);
    });

    const started = await runCli(["browser", "start", "--headless"], { env });
    assert.equal(started.code, 0, `browser start failed: ${started.stderr}`);
    fixture = await startFixtureServer();

    // ---- AC-1: lifecycle through the harness's own helpers ---------------
    const created = await runCli(["nodejs"], {
      input: [
        'const t = await taskSpaces.useOrCreate("e2e")',
        "console.log(JSON.stringify(t))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(created.code, 0, `useOrCreate failed: ${created.stderr}`);
    const space = lastJson(created);
    assert.equal(typeof space.id, "number", "the harness requires a numeric id");
    assert.equal(space.taskId, String(space.id));
    assert.equal(space.name, "e2e");
    assert.equal(space.ownership, "agent");

    // A SECOND process must reuse it: spaces outlive one heredoc, which is the
    // whole point of persisting them.
    const reused = await runCli(["nodejs"], {
      input: [
        'const t = await taskSpaces.useOrCreate("e2e")',
        "const list = await taskSpaces.list()",
        "console.log(JSON.stringify({ reusedId: t.id, list }))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(reused.code, 0, `reuse failed: ${reused.stderr}`);
    const reuseResult = lastJson(reused);
    assert.equal(reuseResult.reusedId, space.id, "same id from a new process");
    const listed = reuseResult.list.find((row) => row.name === "e2e");
    assert.ok(listed, "list contains the space");
    assert.ok(Array.isArray(listed.recentTabTitles), "recentTabTitles is an array");

    // switch by id, by name, and by numeric string — all three shapes the
    // harness's findMatchingTaskSpace accepts.
    const switched = await runCli(["nodejs"], {
      input: [
        `const a = await taskSpaces.switch(${space.id})`,
        'const b = await taskSpaces.switch("e2e")',
        `const c = await taskSpaces.switch("${space.id}")`,
        "console.log(JSON.stringify([a.id, b.id, c.id]))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(switched.code, 0, `switch failed: ${switched.stderr}`);
    assert.deepEqual(lastJson(switched), [space.id, space.id, space.id]);

    // new + complete{keep:false}, then the same complete must report not found.
    const scratch = await runCli(["nodejs"], {
      input: [
        'const s = await taskSpaces.new("e2e scratch")',
        "const closed = await taskSpaces.complete(s.id, { keep: false })",
        "let second = null",
        "try { await taskSpaces.complete(s.id, { keep: false }) }",
        "catch (error) { second = error.message }",
        "console.log(JSON.stringify({ id: s.id, closed, second }))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(scratch.code, 0, `scratch lifecycle failed: ${scratch.stderr}`);
    const scratchResult = lastJson(scratch);
    assert.deepEqual(scratchResult.closed, { done: true });
    assert.match(scratchResult.second, /task space not found/i);
    assert.notEqual(scratchResult.id, space.id, "ids are not reused");

    // ---- AC-2: spaces are isolated --------------------------------------
    const setCookie = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.useOrCreate("A")',
        `await page.goto(${JSON.stringify(`${fixture.origin}/set`)})`,
        'console.log(JSON.stringify({ cookie: await page.evaluate("document.cookie") }))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(setCookie.code, 0, `space A failed: ${setCookie.stderr}`);
    assert.match(lastJson(setCookie).cookie, /grazer=isolated/);

    const otherSpace = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.useOrCreate("B")',
        `await page.goto(${JSON.stringify(`${fixture.origin}/`)})`,
        'console.log(JSON.stringify({ cookie: await page.evaluate("document.cookie") }))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(otherSpace.code, 0, `space B failed: ${otherSpace.stderr}`);
    assert.equal(
      lastJson(otherSpace).cookie,
      "",
      "space B must not see space A's cookie",
    );

    // ---- AC-5: tab scoping ----------------------------------------------
    const scoped = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.useOrCreate("B")',
        `await browser.openOrReuseTab(${JSON.stringify(`${fixture.origin}/set`)})`,
        "const tabs = await browser.listTabs()",
        "console.log(JSON.stringify(tabs))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(scoped.code, 0, `scoping failed: ${scoped.stderr}`);
    const bTabs = lastJson(scoped);
    assert.equal(bTabs.length, 2, "space B has exactly its own two tabs");
    assert.equal(bTabs.filter((tab) => tab.active).length, 1);

    const aScoped = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.useOrCreate("A")',
        "console.log(JSON.stringify(await browser.listTabs()))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(aScoped.code, 0, `space A scoping failed: ${aScoped.stderr}`);
    const aTabs = lastJson(aScoped);
    assert.equal(aTabs.length, 1, "space A still sees only its own tab");
    assert.equal(aTabs[0].active, true);
    assert.match(aTabs[0].url, /\/set$/);

    // The new tab really landed in A's context, not the default one.
    const storeRows = JSON.parse(
      readFileSync(join(grazerHome, "spaces.json"), "utf8"),
    ).spaces;
    const contexts = new Set(storeRows.map((row) => row.browserContextId));
    assert.equal(contexts.size, storeRows.length, "every space has its own context");

    // ---- AC-3: control gating -------------------------------------------
    const handedOff = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.useOrCreate("e2e")',
        "await taskSpaces.handOff()",
        "console.log(JSON.stringify(await taskSpaces.list()))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(handedOff.code, 0, `handOff failed: ${handedOff.stderr}`);
    assert.equal(
      lastJson(handedOff).find((row) => row.name === "e2e").ownership,
      "agentDelegatedToUser",
    );

    // A NEW process may still SELECT a handed-off space (it is agent-owned),
    // but the send gate stops the page command with the harness's own guidance.
    const blocked = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.switch("e2e")',
        `await page.goto(${JSON.stringify(`${fixture.origin}/`)})`,
        'console.log("SHOULD NOT REACH")',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(blocked.code, 1, "a handed-off space must refuse page commands");
    assert.match(blocked.all, /taken control/i, "the harness's owned guidance");
    assert.doesNotMatch(blocked.stdout, /SHOULD NOT REACH/);

    const takenBack = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.takeOver("e2e")',
        `await page.goto(${JSON.stringify(`${fixture.origin}/`)})`,
        "const list = await taskSpaces.list()",
        'console.log(JSON.stringify({ ownership: list.find((r) => r.name === "e2e").ownership }))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(takenBack.code, 0, `takeOver failed: ${takenBack.stderr}`);
    assert.equal(lastJson(takenBack).ownership, "agent");

    // ---- AC-3: `grazer space end` -> INACTIVE ---------------------------
    const spaceId = lastJson(handedOff).find((row) => row.name === "e2e").id;
    const ended = await runCli(["space", "end", String(spaceId)], { env });
    assert.equal(ended.code, 0, `space end failed: ${ended.stderr}`);

    // `taskSpaces.switch` cannot reach an ended space — the harness refuses
    // user-owned spaces before calling us — so useOrCreate is the path, and the
    // INACTIVE guidance names claim() as the way back.
    const inactive = await runCli(["nodejs"], {
      input: [
        'await taskSpaces.useOrCreate("e2e")',
        `await page.goto(${JSON.stringify(`${fixture.origin}/`)})`,
        "",
      ].join("\n"),
      env,
    });
    assert.equal(inactive.code, 1, "an ended space must refuse work");
    assert.match(inactive.all, /ended the task/i, "the INACTIVE guidance");

    const afterEnd = await runCli(["nodejs"], {
      input: ["console.log(JSON.stringify(await taskSpaces.list()))", ""].join("\n"),
      env,
    });
    assert.equal(
      lastJson(afterEnd).find((row) => row.name === "e2e").state,
      "ended",
    );

    // claim() is the documented recovery and must actually restore the space.
    const claimed = await runCli(["nodejs"], {
      input: [
        'const s = await taskSpaces.claim("e2e")',
        `await page.goto(${JSON.stringify(`${fixture.origin}/`)})`,
        "console.log(JSON.stringify({ ownership: s.ownership, state: s.state }))",
        "",
      ].join("\n"),
      env,
    });
    assert.equal(claimed.code, 0, `claim failed: ${claimed.stderr}`);
    assert.deepEqual(lastJson(claimed), { ownership: "agent", state: "active" });

    // ---- AC-4: persistence is tied to the browser's life -----------------
    const beforeRestart = JSON.parse(
      readFileSync(join(grazerHome, "spaces.json"), "utf8"),
    );
    assert.ok(beforeRestart.spaces.length > 0, "spaces existed before the restart");

    assert.equal((await runCli(["browser", "stop"], { env })).code, 0);
    const restarted = await runCli(["browser", "start", "--headless"], { env });
    assert.equal(restarted.code, 0, `restart failed: ${restarted.stderr}`);

    const afterRestart = await runCli(["nodejs"], {
      input: ["console.log(JSON.stringify(await taskSpaces.list()))", ""].join("\n"),
      env,
    });
    assert.equal(afterRestart.code, 0, `list after restart failed: ${afterRestart.stderr}`);
    assert.deepEqual(
      lastJson(afterRestart),
      [],
      "contexts died with the browser, so the store must reset",
    );

    const persisted = JSON.parse(
      readFileSync(join(grazerHome, "spaces.json"), "utf8"),
    );
    const browserState = JSON.parse(
      readFileSync(join(grazerHome, "browser.json"), "utf8"),
    );
    assert.equal(
      persisted.browserStartedAt,
      browserState.startedAt,
      "spaces.json records the NEW browser's epoch",
    );
    assert.notEqual(persisted.browserStartedAt, beforeRestart.browserStartedAt);
  },
);
