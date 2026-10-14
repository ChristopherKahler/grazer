/**
 * The wave-2 integration test: Phases 1-3 together.
 *
 * AC-1 proves `grazer.snapshot` is live in a heredoc and that it is what
 * `waitForAgentControl` reads. AC-2 runs the harness's OWN case bodies —
 * task-space, observation, navigation — unmodified, so any drift between what
 * Grazer provides and what the harness expects fails here rather than in
 * someone's agent run.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { findChromium, removeProfileDir } from "./support/chromium.mjs";
import { ensureHarnessBundle } from "./support/harness-bundle.mjs";
import { runCli, runHarnessCase, startCaseEnvironment } from "./support/harness-case.mjs";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

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
  suiteLock = await acquireSuiteLock("harness-cases");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


/** Load the three case bodies straight from the harness. */
async function loadCases() {
  const dir = join(
    process.cwd(),
    "packages",
    "harness",
    "scripts",
    "real-browser-e2e",
    "cases",
  );
  const load = async (file, name) => {
    const module = await import(`file://${join(dir, file).replace(/\\/g, "/")}`);
    return module[name];
  };
  return {
    taskSpaceCase: await load("task-space.mjs", "taskSpaceCase"),
    observationCase: await load("observation.mjs", "observationCase"),
    navigationCase: await load("navigation.mjs", "navigationCase"),
  };
}

test(
  "snapshot is live in heredocs and gates on agent control",
  { skip: skipReason },
  async (t) => {
    const grazerHome = await mkdtemp(join(tmpdir(), "grazer-cases-home-"));
    let environment;

    t.after(async () => {
      await environment?.close();
      await runCli(["browser", "stop"], { env: { GRAZER_HOME: grazerHome } }).catch(() => {});
      await removeProfileDir(grazerHome);
    });

    assert.equal(
      (await runCli(["browser", "start", "--headless"], {
        env: { GRAZER_HOME: grazerHome, GRAZER_BROWSER: executable },
      })).code,
      0,
    );
    environment = await startCaseEnvironment({ grazerHome, browserPath: executable });
    const { context, env } = environment;

    // ---- AC-1: snapshot renders the fixture with [ref=N] annotations ------
    const snapshotted = await runCli(["nodejs"], {
      input: [
        `await taskSpaces.useOrCreate(${JSON.stringify(context.taskName)})`,
        `await page.goto(${JSON.stringify(`${context.baseUrl}/`)})`,
        'console.log(await page.snapshot({ scope: "full_page" }))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(snapshotted.code, 0, `snapshot failed: ${snapshotted.stderr}`);
    assert.match(snapshotted.stdout, /\[ref=\d+\]/, "the tree carries ref annotations");
    assert.match(snapshotted.stdout, /Helper e2e fixture/, "the fixture rendered");

    // ---- AC-1: handOff makes snapshot surface the guidance ---------------
    assert.equal(
      (await runCli(["nodejs"], {
        input: [
          `await taskSpaces.useOrCreate(${JSON.stringify(context.taskName)})`,
          "await taskSpaces.handOff()",
          "",
        ].join("\n"),
        env,
      })).code,
      0,
    );

    const blockedSnapshot = await runCli(["nodejs"], {
      input: [
        `await taskSpaces.switch(${JSON.stringify(context.taskName)})`,
        'console.log(await page.snapshot({ scope: "full_page" }))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(blockedSnapshot.code, 1, "snapshot must refuse under user control");
    assert.match(blockedSnapshot.all, /taken control/i);

    // waitForAgentControl polls grazer.snapshot and must NOT return while the
    // user holds the wheel — that probe is the only reliable signal it has.
    const waited = await runCli(["nodejs"], {
      input: [
        `await taskSpaces.switch(${JSON.stringify(context.taskName)})`,
        `await taskSpaces.waitForAgentControl(${JSON.stringify(context.taskName)}, { interval: 0.1, timeout: 1 })`,
        'console.log("SHOULD NOT REACH")',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(waited.code, 1, "waitForAgentControl must time out");
    assert.match(waited.all, /timed out after 1s/);
    assert.doesNotMatch(waited.stdout, /SHOULD NOT REACH/);

    // After takeOver, waitForAgentControl returns — which is only possible
    // because its grazer.snapshot probe stopped throwing USER_IN_CONTROL.
    // The snapshot here is deliberately cold (no navigation first): it has to
    // resolve the space's own tab on its own.
    const recovered = await runCli(["nodejs"], {
      input: [
        `await taskSpaces.takeOver(${JSON.stringify(context.taskName)})`,
        `await taskSpaces.waitForAgentControl(${JSON.stringify(context.taskName)}, { interval: 0.1, timeout: 5 })`,
        'console.log("CONTROL BACK")',
        'const text = await page.snapshot({ scope: "full_page" })',
        'console.log("RECOVERED " + text.includes("Helper e2e fixture"))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(recovered.code, 0, `takeOver recovery failed: ${recovered.stderr}`);
    assert.match(recovered.stdout, /CONTROL BACK/, "waitForAgentControl returned");
    assert.match(recovered.stdout, /RECOVERED true/);
  },
);

test(
  "a cold snapshot resolves the selected space's own tab",
  { skip: skipReason },
  async (t) => {
    const grazerHome = await mkdtemp(join(tmpdir(), "grazer-cold-snapshot-"));
    let environment;

    t.after(async () => {
      await environment?.close();
      await runCli(["browser", "stop"], { env: { GRAZER_HOME: grazerHome } }).catch(() => {});
      await removeProfileDir(grazerHome);
    });

    assert.equal(
      (await runCli(["browser", "start", "--headless"], {
        env: { GRAZER_HOME: grazerHome, GRAZER_BROWSER: executable },
      })).code,
      0,
    );
    environment = await startCaseEnvironment({ grazerHome, browserPath: executable });
    const { context, env } = environment;

    // Two spaces, each with exactly one tab. The second is created LAST, so a
    // browser-wide "last page target" fallback would pick it — which is
    // precisely the bug this pins.
    const other = `${context.taskName} other`;
    const seeded = await runCli(["nodejs"], {
      input: [
        `await taskSpaces.useOrCreate(${JSON.stringify(context.taskName)})`,
        `await page.goto(${JSON.stringify(`${context.baseUrl}/`)})`,
        `await taskSpaces.useOrCreate(${JSON.stringify(other)})`,
        `await page.goto(${JSON.stringify(`${context.baseUrl}/api/text`)})`,
        "",
      ].join("\n"),
      env,
    });
    assert.equal(seeded.code, 0, `seeding two spaces failed: ${seeded.stderr}`);

    // A NEW process: nothing has attached, so the adapter must resolve the
    // session through the space's own tab list. Returning an empty string here
    // would be worse than failing — absent must never read as empty.
    const cold = await runCli(["nodejs"], {
      input: [
        `await taskSpaces.useOrCreate(${JSON.stringify(context.taskName)})`,
        'const text = await page.snapshot({ scope: "full_page" })',
        'console.log(JSON.stringify({ length: text.length, hasFixture: text.includes("Helper e2e fixture"), hasRefs: /\\[ref=\\d+\\]/.test(text) }))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(cold.code, 0, `cold snapshot failed: ${cold.stderr}`);
    const probe = JSON.parse(
      cold.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).at(-1),
    );
    assert.ok(probe.length > 0, "a cold snapshot must not return an empty string");
    assert.equal(probe.hasFixture, true, "it resolved the selected space's tab");
    assert.equal(probe.hasRefs, true, "with [ref=N] annotations");

    // Switching spaces mid-process must invalidate a remembered session: a
    // snapshot can be the very next call, with no send in between to refresh it.
    const switched = await runCli(["nodejs"], {
      input: [
        `await taskSpaces.useOrCreate(${JSON.stringify(context.taskName)})`,
        'const first = await page.snapshot({ scope: "full_page" })',
        `await taskSpaces.switch(${JSON.stringify(other)})`,
        'const second = await page.snapshot({ scope: "full_page" })',
        'console.log(JSON.stringify({ firstIsFixture: first.includes("Helper e2e fixture"), secondIsFixture: second.includes("Helper e2e fixture") }))',
        "",
      ].join("\n"),
      env,
    });
    assert.equal(switched.code, 0, `space switch snapshot failed: ${switched.stderr}`);
    const switchProbe = JSON.parse(
      switched.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).at(-1),
    );
    assert.equal(switchProbe.firstIsFixture, true, "the first space's page");
    assert.equal(
      switchProbe.secondIsFixture,
      false,
      "after switching, the cached session must not still show the old space",
    );
  },
);

for (const caseName of ["task-space", "observation", "navigation"]) {
  test(
    `harness case: ${caseName}`,
    { skip: skipReason },
    async (t) => {
      const grazerHome = await mkdtemp(join(tmpdir(), `grazer-case-${caseName}-`));
      let environment;

      t.after(async () => {
        await environment?.close();
        await runCli(["browser", "stop"], { env: { GRAZER_HOME: grazerHome } }).catch(() => {});
        await removeProfileDir(grazerHome);
      });

      assert.equal(
        (await runCli(["browser", "start", "--headless"], {
          env: { GRAZER_HOME: grazerHome, GRAZER_BROWSER: executable },
        })).code,
        0,
        "browser start",
      );
      environment = await startCaseEnvironment({ grazerHome, browserPath: executable });

      const cases = await loadCases();
      const body = {
        "task-space": cases.taskSpaceCase,
        observation: cases.observationCase,
        navigation: cases.navigationCase,
      }[caseName]();

      const result = await runHarnessCase(body, environment);

      assert.equal(
        result.ok,
        true,
        `${caseName} failed: ${result.error}\n--- stdout ---\n${result.run.stdout}\n--- stderr ---\n${result.run.stderr}`,
      );
      assert.ok(
        result.assertions > 0,
        `${caseName} reported ${result.assertions} assertions`,
      );
      assert.equal(result.run.code, 0, `${caseName} exited ${result.run.code}`);
    },
  );
}
