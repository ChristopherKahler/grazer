/**
 * Refuse to pile a browser suite onto an already-saturated machine.
 *
 * The suite lock stops Grazer's own suites from overlapping. It cannot see
 * anything else on the developer's desktop — a build, a render, their actual work — so
 * this is the second half: hold the lock, then wait until the CPU is not
 * already pinned before launching browsers.
 *
 * Two samples, not one: a single reading catches a momentary spike and would
 * make the guard fire on noise.
 */

import { spawn } from "node:child_process";

const DEFAULT_THRESHOLD = 85;
const DEFAULT_SAMPLES = 2;
const SAMPLE_GAP_MS = 1_000;

/**
 * Current CPU load 0-100, or null when it cannot be measured.
 *
 * Windows has no `getloadavg`, and `os.loadavg()` returns zeros there, so this
 * asks WMI. Null means "unknown", which callers must treat as "proceed" — a
 * guard that cannot measure must not become an unexplained hang.
 */
export function cpuLoadPercent({ timeoutMs = 5_000 } = {}) {
  if (process.platform !== "win32") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      const value = Number.parseFloat(out.trim());
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

/**
 * Wait until the machine is quiet enough, or until `timeoutMs` elapses.
 *
 * Returns what happened rather than throwing: being busy is not a test failure,
 * and a suite that waited then ran is a success. The caller logs the reason.
 */
export async function waitForCpu(options = {}) {
  const {
    threshold = DEFAULT_THRESHOLD,
    samples = DEFAULT_SAMPLES,
    timeoutMs = 120_000,
    log = (message) => console.error(message),
    holderLabel,
  } = options;

  const first = await cpuLoadPercent();
  if (first === null) {
    log("[cpu-guard] cannot read CPU load on this platform — proceeding");
    return { proceeded: true, reason: "unmeasurable", load: null };
  }

  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const readings = [];
    for (let i = 0; i < samples; i += 1) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, SAMPLE_GAP_MS));
      const value = await cpuLoadPercent();
      if (value === null) {
        log("[cpu-guard] CPU query stopped answering — proceeding");
        return { proceeded: true, reason: "unmeasurable", load: null };
      }
      readings.push(value);
    }
    // Every sample must be over the line; one spike is not saturation.
    const busy = readings.every((value) => value > threshold);
    if (!busy) {
      return { proceeded: true, reason: "quiet", load: Math.max(...readings) };
    }
    if (!announced) {
      announced = true;
      log(
        `[cpu-guard] CPU at ${readings.join("%, ")}% (over ${threshold}%) — waiting${
          holderLabel ? `; suite lock held by ${holderLabel}` : ""
        }`,
      );
    }
    if (Date.now() >= deadline) {
      log(`[cpu-guard] still busy after ${Math.round(timeoutMs / 1000)}s — proceeding anyway`);
      return { proceeded: true, reason: "timeout", load: Math.max(...readings) };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
