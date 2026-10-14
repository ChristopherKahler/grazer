/**
 * `grazer space` — the human surface.
 *
 * These assert on the store the CLI writes, because that store is the contract
 * between the human and a running agent: `takeover` is only meaningful if the
 * agent's next send reads it and stops.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { findChromium, removeProfileDir } from "./support/chromium.mjs";
import { PACKAGE_ROOT } from "./support/harness-bundle.mjs";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

const CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");

function runCli(args, { env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}

function readSpaces(home) {
  return JSON.parse(readFileSync(join(home, "spaces.json"), "utf8")).spaces;
}

const executable = findChromium();
const skipReason = executable ? false : "no Chromium found (set GRAZER_BROWSER)";

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
  suiteLock = await acquireSuiteLock("spaces-cli");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


test(
  "grazer space list / takeover / handoff / end / delete",
  { skip: skipReason },
  async (t) => {
    const grazerHome = await mkdtemp(join(tmpdir(), "grazer-spaces-cli-"));
    const env = { GRAZER_HOME: grazerHome, GRAZER_BROWSER: executable };

    t.after(async () => {
      await runCli(["browser", "stop"], { env }).catch(() => {});
      await removeProfileDir(grazerHome);
    });

    // With no browser and no store at all, list is an answer, not an error.
    const empty = await runCli(["space", "list"], { env });
    assert.equal(empty.code, 0);
    assert.match(empty.stdout, /No task spaces/);

    assert.equal(
      (await runCli(["browser", "start", "--headless"], { env })).code,
      0,
    );

    // Create two spaces through the runtime, the way an agent would.
    const seed = await new Promise((resolvePromise) => {
      const child = spawn(
        process.execPath,
        [CLI, "nodejs"],
        {
          cwd: PACKAGE_ROOT,
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
      child.stdin.end(
        [
          'await taskSpaces.useOrCreate("alpha")',
          'await taskSpaces.useOrCreate("beta")',
          "",
        ].join("\n"),
      );
    });
    assert.equal(seed.code, 0, `seeding spaces failed: ${seed.stderr}`);

    // ---- list ------------------------------------------------------------
    const listed = await runCli(["space", "list"], { env });
    assert.equal(listed.code, 0, listed.stderr);
    const lines = listed.stdout.trim().split("\n");
    assert.match(lines[0], /^ID\s+NAME\s+OWNERSHIP\s+STATE\s+TABS$/);
    assert.equal(lines.length, 3, "a header and two spaces");
    assert.match(listed.stdout, /alpha\s+agent\s+active\s+1/);
    assert.match(listed.stdout, /beta\s+agent\s+active\s+1/);

    const rows = readSpaces(grazerHome);
    const alpha = rows.find((row) => row.name === "alpha");
    const beta = rows.find((row) => row.name === "beta");

    // ---- takeover / handoff / end ---------------------------------------
    const tookOver = await runCli(["space", "takeover", String(alpha.id)], { env });
    assert.equal(tookOver.code, 0, tookOver.stderr);
    assert.match(tookOver.stdout, /You now control task space/);
    assert.equal(
      readSpaces(grazerHome).find((row) => row.id === alpha.id).ownership,
      "user",
      "takeover is what makes the agent's next send fail USER_IN_CONTROL",
    );

    // By name, not just by id.
    const handedBack = await runCli(["space", "handoff", "alpha"], { env });
    assert.equal(handedBack.code, 0, handedBack.stderr);
    assert.equal(
      readSpaces(grazerHome).find((row) => row.id === alpha.id).ownership,
      "agent",
    );

    const ended = await runCli(["space", "end", String(alpha.id)], { env });
    assert.equal(ended.code, 0, ended.stderr);
    const endedRow = readSpaces(grazerHome).find((row) => row.id === alpha.id);
    assert.equal(endedRow.state, "ended");
    assert.equal(endedRow.ownership, "user");

    // handoff revives an ended space, so the human can undo an accidental end.
    assert.equal((await runCli(["space", "handoff", "alpha"], { env })).code, 0);
    assert.equal(
      readSpaces(grazerHome).find((row) => row.id === alpha.id).state,
      "active",
    );

    // ---- unknown targets and usage --------------------------------------
    const missing = await runCli(["space", "takeover", "nope"], { env });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Task space not found: nope/);

    const badCommand = await runCli(["space", "wat", "1"], { env });
    assert.equal(badCommand.code, 2);
    assert.match(badCommand.stderr, /unknown space command/);

    const noTarget = await runCli(["space", "takeover"], { env });
    assert.equal(noTarget.code, 2);
    assert.match(noTarget.stderr, /needs a task space id or name/);

    // ---- delete ----------------------------------------------------------
    const deletedOne = await runCli(["space", "delete", String(beta.id)], { env });
    assert.equal(deletedOne.code, 0, deletedOne.stderr);
    assert.match(deletedOne.stdout, /Deleted 1 task space\b/);
    assert.equal(
      readSpaces(grazerHome).some((row) => row.id === beta.id),
      false,
    );

    const deletedAll = await runCli(["space", "delete", "--all"], { env });
    assert.equal(deletedAll.code, 0, deletedAll.stderr);
    assert.deepEqual(readSpaces(grazerHome), [], "every context disposed");

    const listedAfter = await runCli(["space", "list"], { env });
    assert.match(listedAfter.stdout, /No task spaces/);
    assert.ok(existsSync(join(grazerHome, "spaces.json")));
  },
);
