#!/usr/bin/env node
/**
 * The benchmark runner.
 *
 * Usage:
 *   node bench/run.mjs --task t3-compile --driver grazer --reps 1
 *   node bench/run.mjs                       # every task, every driver, 3 reps
 *
 * MUST BE RUN FROM A PLAIN SHELL. Measured on 2026-09-03: the same
 * `claude --print` invocation launched from inside a Claude Code session
 * returned in 2s, 23 minutes, and twice not at all within 5 minutes. Wall-clock
 * is one of the four headline metrics, so a harness whose own invocation path
 * adds an unbounded, variable delay cannot measure it. The guard below refuses
 * to start rather than emit numbers that mean nothing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { startBenchFixture } from "./fixture/server.mjs";
import { DRIVERS, driverById } from "./drivers/index.mjs";
import { finalAnswerOf, metricsFrom, parseCliJson } from "./lib/metrics.mjs";
import { assertNoSecrets } from "./lib/secrets.mjs";
import { runProcess } from "./lib/spawn.mjs";
import { RESULTS_DIR } from "./lib/paths.mjs";
import { listTaskIds, loadTask, resolvePrompt } from "./lib/tasks.mjs";
import { withSuiteLock } from "../test/support/suite-lock.mjs";


function parseArgs(argv) {
  const args = { reps: 3, tasks: null, drivers: null, model: null, budgetUsd: 5 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--task") (args.tasks ??= []).push(argv[++i]);
    else if (flag === "--driver") (args.drivers ??= []).push(argv[++i]);
    else if (flag === "--reps") args.reps = Number(argv[++i]);
    else if (flag === "--model") args.model = argv[++i];
    else if (flag === "--budget-usd") args.budgetUsd = Number(argv[++i]);
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

/** Refuse to run nested. See the module comment — this is not a style rule. */
function assertPlainShell() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
    console.error(
      [
        "bench/run.mjs must be run from a plain shell, not from inside a Claude Code session.",
        "",
        "A nested `claude --print` was measured returning in 2s, in 23 minutes, and twice",
        "not at all — so wall-clock, one of the four headline metrics, would be meaningless.",
        "",
        "Open a normal terminal and run it there.",
      ].join("\n"),
    );
    process.exit(2);
  }
}

/** Last few hundred characters of a stream — enough to name a cause, small enough to store. */
export function tailOf(text, limit = 600) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  return value.length <= limit ? value : `…${value.slice(-limit)}`;
}

/** One compact line of stderr for the console, so a FAIL says why on the spot. */
export function stderrHint(tail) {
  if (!tail) return "";
  const lines = String(tail).split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" / ");
  return lines ? `\n     stderr: ${lines}` : "";
}

/**
 * Invoke the agent. Shell-free: every prompt is arbitrary text, and a shell
 * would re-parse it — a prompt containing a quote, `&` or `|` would break the
 * command or inject into it.
 */
function runClaude(argv, { env, timeoutMs }) {
  return runProcess("claude", argv, { env, timeoutMs });
}

export async function runOne({ task, driver, ctx, outDir }) {
  // prepare() is inside the recorded path on purpose. It was outside, so a
  // failure here — "browser start failed twice", a missing profile dir — threw
  // past the record writer, produced no file for the cell, and aborted every
  // remaining cell in the matrix. One bad cell must cost one cell.
  let state;
  try {
    state = await driver.prepare(ctx);
  } catch (error) {
    const record = {
      task: task.id,
      driver: driver.id,
      rep: ctx.rep,
      startedAt: new Date().toISOString(),
      wallMs: 0,
      exitCode: null,
      timedOut: false,
      success: false,
      graderDetail: `driver.prepare failed: ${error?.message ?? String(error)}`,
      finalAnswer: null,
      stderrTail: tailOf(error?.stack ?? error?.message),
      stdoutTail: null,
      ...metricsFrom({}),
      model: ctx.model ?? "cli-default",
    };
    assertNoSecrets(record);
    await writeFile(
      join(outDir, `${task.id}-${driver.id}-${ctx.rep}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return record;
  }

  let record;
  try {
    const argv = driver.argv(task, ctx, state);
    const run = await runClaude(argv, { env: driver.env(state), timeoutMs: task.timeoutMs });
    const parsed = parseCliJson(run.stdout);
    const metrics = parsed.ok ? metricsFrom(parsed.result) : metricsFrom({});
    const finalAnswer = parsed.ok ? finalAnswerOf(parsed.result) : null;

    let graded = { pass: false, detail: "not graded" };
    if (run.timedOut) {
      graded = { pass: false, detail: `timed out after ${task.timeoutMs}ms` };
    } else if (!parsed.ok) {
      graded = { pass: false, detail: `could not parse CLI output: ${parsed.error}` };
    } else {
      try {
        const truth = await task.grader.groundTruth(ctx);
        graded = task.grader.grade(finalAnswer, truth);
      } catch (error) {
        graded = { pass: false, detail: `grader threw: ${error.message}` };
      }
    }

    record = {
      task: task.id,
      driver: driver.id,
      rep: ctx.rep,
      startedAt: new Date().toISOString(),
      wallMs: run.wallMs,
      exitCode: run.code,
      timedOut: run.timedOut,
      success: graded.pass,
      graderDetail: graded.detail,
      finalAnswer,
      // Always persisted, pass or fail. Bench run 3 lost its cause because the
      // record kept only "no JSON object in stdout": exit code null and no
      // stderr, so an ENOENT that took one millisecond was indistinguishable
      // from an agent that answered badly. A failed cell must explain itself.
      stderrTail: tailOf(run.stderr),
      stdoutTail: parsed.ok ? null : tailOf(run.stdout),
      ...metrics,
      model: ctx.model ?? "cli-default",
    };
  } finally {
    await driver.teardown(state);
  }

  assertNoSecrets(record);
  await writeFile(
    join(outDir, `${task.id}-${driver.id}-${ctx.rep}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return record;
}

async function main() {
  assertPlainShell();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node bench/run.mjs [--task <id>]... [--driver <id>]... [--reps N] [--model M] [--budget-usd N]");
    return 0;
  }

  const taskIds = args.tasks ?? (await listTaskIds());
  if (taskIds.length === 0) {
    console.error("no task files under bench/tasks");
    return 1;
  }
  const drivers = (args.drivers ?? DRIVERS.map((d) => d.id)).map(driverById);

  const fixture = await startBenchFixture();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(RESULTS_DIR, stamp);
  await mkdir(outDir, { recursive: true });
  console.log(`fixture ${fixture.origin}`);
  console.log(`results ${outDir}`);

  try {
    for (const taskId of taskIds) {
      const task = await loadTask(taskId);
      for (const driver of drivers) {
        const availability = driver.available();
        if (!availability.ok) {
          // Skipped is not failed, and neither is zero. Record why.
          const skip = {
            task: task.id, driver: driver.id, rep: null,
            skipped: true, skipReason: availability.reason,
          };
          await writeFile(join(outDir, `${task.id}-${driver.id}-skipped.json`),
            `${JSON.stringify(skip, null, 2)}\n`, "utf8");
          console.log(`-- ${task.id} / ${driver.id}: SKIPPED (${availability.reason})`);
          continue;
        }
        for (let rep = 1; rep <= args.reps; rep++) {
          const ctx = {
            rep,
            baseUrl: fixture.origin,
            prompt: resolvePrompt(task, fixture.origin),
            model: args.model,
            budgetUsd: args.budgetUsd,
          };
          process.stdout.write(`-- ${task.id} / ${driver.id} / rep ${rep} ... `);
          const record = await runOne({ task, driver, ctx, outDir });
          console.log(
            `${record.success ? "pass" : "FAIL"} ${(record.wallMs / 1000).toFixed(1)}s ` +
            `${record.totalTokens ?? "?"} tok` +
            (record.success
              ? ""
              : ` — ${record.graderDetail}${stderrHint(record.stderrTail)}`),
          );
        }
      }
    }
  } finally {
    await fixture.close();
  }

  console.log(`\nRender with: node bench/report.mjs ${outDir}`);
  return 0;
}

// Only when executed directly: importing this module must never start a run
// (and must never trip the plain-shell guard).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Law 11: one browser-launching run at a time, machine-wide. Held for the
  // WHOLE matrix — a lock released between reps would let another suite
  // interleave with ours, which is exactly the CPU pileup it exists to stop.
  process.exitCode = await withSuiteLock("bench", main).catch((error) => {
    console.error(error?.stack ?? String(error));
    return 1;
  });
}
