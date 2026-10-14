/**
 * AC-1: bin/grazer.exe forwards faithfully to `node bin/grazer.mjs`.
 *
 * Every case runs the same input two ways — through the launcher and through
 * node directly — and asserts the two are indistinguishable in stdout, stderr
 * and exit code. That is the whole contract: the launcher exists so
 * `spawn("grazer", args)` works on Windows without a shell, and it is only
 * useful if it changes nothing else.
 *
 * Nothing here uses shell:true; that would defeat the point of the test.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import { findChromium, removeProfileDir } from "./support/chromium.mjs";
import { ensureHarnessBundle, PACKAGE_ROOT } from "./support/harness-bundle.mjs";
import { findCsc } from "../launcher/build.mjs";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

const EXE = join(PACKAGE_ROOT, "bin", "grazer.exe");
const CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");

/**
 * Run a command and resolve when the PROCESS exits, not when its pipes close.
 * `grazer browser start` leaves a detached browser holding the inherited
 * stdout handle, so waiting for stream EOF hangs forever even though the
 * command itself finished in under a second.
 */
function run(command, args, { input, env = {}, timeoutMs = 90_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
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
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, spawnError: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut: false });
    });
    child.stdin.end(input ?? "");
  });
}

const viaExe = (args, options) => run(EXE, args, options);
const viaNode = (args, options) => run(process.execPath, [CLI, ...args], options);

/** Node prints an ExperimentalWarning for the JSON import; it is not the CLI's. */
const withoutNodeWarnings = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/--trace-warnings/.test(line))
    .join("\n");

async function assertSameBothWays(t, args, options) {
  const [exe, node] = await Promise.all([viaExe(args, options), viaNode(args, options)]);
  assert.equal(exe.spawnError, undefined, `launcher failed to spawn: ${exe.spawnError}`);
  assert.equal(exe.timedOut, false, "the launcher did not exit in time");
  assert.equal(exe.code, node.code, `exit code differs for ${args.join(" ")}`);
  assert.equal(exe.stdout, node.stdout, `stdout differs for ${args.join(" ")}`);
  assert.equal(
    withoutNodeWarnings(exe.stderr),
    withoutNodeWarnings(node.stderr),
    `stderr differs for ${args.join(" ")}`,
  );
  t.diagnostic(`${args.join(" ") || "(no args)"} -> exit ${exe.code}, both ways identical`);
  return exe;
}

const skipReason = existsSync(EXE)
  ? false
  : findCsc()
    ? "bin/grazer.exe is not built — run: node launcher/build.mjs"
    : "no C# compiler and no built bin/grazer.exe";

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
  suiteLock = await acquireSuiteLock("launcher");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


test("AC-1: --version is byte-identical through the launcher", { skip: skipReason }, async (t) => {
  const result = await assertSameBothWays(t, ["--version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\s*$/);
});

test("AC-1: help and usage exit codes survive the launcher", { skip: skipReason }, async (t) => {
  // No args is a usage error (2); explicit --help is success (0). Both must
  // come through unchanged, because the exit codes are the CLI's contract.
  const bare = await assertSameBothWays(t, []);
  assert.equal(bare.code, 2);
  const help = await assertSameBothWays(t, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Give your AI agent its own logged-in browser spaces/);
});

test("AC-1: an unknown command reports and fails the same way", { skip: skipReason }, async (t) => {
  const result = await assertSameBothWays(t, ["definitely-not-a-command"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown command: definitely-not-a-command/);
});

test("AC-1: arguments with spaces and quotes survive unchanged", { skip: skipReason }, async (t) => {
  // The launcher forwards the raw command-line tail rather than re-joining
  // argv, so a path that already carries spaces (or quotes) must arrive at the
  // CLI byte-for-byte. The CLI echoes the --sdk-path value back in its error,
  // which makes the round trip observable.
  const spaced = "C:\\path with space\\x.js";
  const result = await assertSameBothWays(t, ["nodejs", "--sdk-path", spaced], {
    input: "console.log('never runs')\n",
  });
  assert.ok(
    result.stderr.includes(spaced),
    `the exact path did not survive; stderr was: ${result.stderr}`,
  );

  const quoted = 'C:\\a "quoted" b\\x.js';
  const second = await assertSameBothWays(t, ["nodejs", "--sdk-path", quoted], {
    input: "console.log('never runs')\n",
  });
  assert.ok(
    second.stderr.includes(quoted),
    `the embedded quotes did not survive; stderr was: ${second.stderr}`,
  );
});

test("AC-1: a heredoc against a running browser behaves identically", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const executable = findChromium();
  if (!executable) return t.skip("no Chromium found (set GRAZER_BROWSER)");
  const bundle = await ensureHarnessBundle();
  if (!bundle) return t.skip("harness bundle not built (npm run harness:build)");

  const home = await mkdtemp(join(tmpdir(), "grazer-launcher-"));
  const env = { GRAZER_HOME: home, GRAZER_BROWSER: executable };

  const started = await viaExe(["browser", "start", "--headless"], { env });
  assert.equal(started.code, 0, `browser start failed: ${started.stderr}`);
  assert.match(started.stdout, /started .* on port \d+/);

  try {
    // Exit 0: the script runs and its console.log reaches our stdout.
    const ok = await assertSameBothWays(t, ["nodejs"], {
      env,
      input: [
        'console.log("launcher-ok", typeof grazer.sendCDPMessage)',
        'console.log(await page.evaluate("1+1"))',
        "",
      ].join("\n"),
    });
    assert.equal(ok.code, 0, `heredoc failed: ${ok.stderr}`);
    assert.match(ok.stdout, /launcher-ok function/);
    assert.match(ok.stdout, /^2$/m, "the page evaluated through the launcher");

    // Exit 1: the agent's script threw, and that code has to come back out
    // through the launcher unchanged.
    const threw = await assertSameBothWays(t, ["nodejs"], {
      env,
      input: 'throw new Error("deliberate failure from the launcher test")\n',
    });
    assert.equal(threw.code, 1);
    assert.match(threw.stderr, /deliberate failure from the launcher test/);
  } finally {
    await viaExe(["browser", "stop"], { env });
    await removeProfileDir(home);
  }
});

test("the launcher is small enough to commit", { skip: skipReason }, async () => {
  const { statSync } = await import("node:fs");
  const bytes = statSync(EXE).size;
  assert.ok(bytes < 10 * 1024, `bin/grazer.exe is ${bytes} bytes, expected under 10 KB`);
});
