/**
 * Process spawning for the benchmark. **Never with a shell.**
 *
 * Two reasons, both bugs this file exists to prevent:
 *
 * 1. `shell: true` re-parses the command string, so an executable path
 *    containing a space is split. `process.execPath` is
 *    `C:\Program Files\nodejs\node.exe`, which cmd read as the command
 *    `C:\Program` — every browser start failed with exit 1 and the runner
 *    reported only "grazer browser start failed".
 * 2. Worse, with a shell the argv array is joined into one command line, so
 *    arbitrary text in an argument is re-interpreted. Every benchmark prompt is
 *    arbitrary text: one containing a quote, `&` or `|` would break the command
 *    or inject into it.
 *
 * Without a shell, Node passes argv straight to CreateProcess and neither can
 * happen. On Windows this means the command must be a real executable — `claude`
 * resolves to `claude.exe`, and `node` is `process.execPath` — not a `.cmd`
 * shim. `runProcess` reports that clearly instead of failing obscurely.
 */

import { spawn } from "node:child_process";

/**
 * Run a process to completion, capturing both streams.
 *
 * stderr is always captured and returned. Discarding it is what turned a
 * one-line cmd error into an unexplained "failed", and cost a whole benchmark
 * rep to diagnose.
 */
export function runProcess(command, args, { env, timeoutMs, cwd } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        env,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Deliberately absent: shell. See the module comment.
      });
    } catch (error) {
      return resolve({
        ok: false, code: null, stdout: "", timedOut: false,
        stderr: `could not spawn ${command}: ${error.message}`,
        wallMs: Date.now() - startedAt,
      });
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill();
          resolve({ ok: false, code: null, stdout, stderr, timedOut: true, wallMs: Date.now() - startedAt });
        }, timeoutMs)
      : null;

    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      const hint =
        error.code === "ENOENT"
          ? ` — not found on PATH as an executable (a .cmd or .bat shim cannot be spawned without a shell, and this harness never uses one)`
          : "";
      resolve({
        ok: false, code: null, stdout, timedOut: false,
        stderr: `${stderr}\nspawn ${command} failed: ${error.message}${hint}`,
        wallMs: Date.now() - startedAt,
      });
    });

    child.once("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, timedOut: false, wallMs: Date.now() - startedAt });
    });
  });
}
