/**
 * Locate (and if necessary build) the vendored harness bundle.
 *
 * The harness's own `prepare` script is POSIX sh and fails under cmd.exe, so the
 * root `npm run harness:build` runs `npm ci --ignore-scripts` then the build.
 * A failure here returns null so the e2e test skips with a reason instead of
 * failing on a machine that has never built it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_SUPPORT_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(TEST_SUPPORT_DIR, "..", "..");
const BUNDLE_PATH = join(
  PACKAGE_ROOT,
  "packages",
  "harness",
  "dist",
  "out",
  "index.js",
);

function runNpm(args, timeoutMs) {
  return new Promise((resolvePromise) => {
    // shell:true because npm on Windows is a .cmd shim, which spawn cannot exec.
    const child = spawn("npm", args, {
      cwd: PACKAGE_ROOT,
      stdio: "ignore",
      shell: true,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise(false);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0);
    });
  });
}

/** Path to the built bundle, building it once if needed; null when unavailable. */
export async function ensureHarnessBundle({ timeoutMs = 300_000 } = {}) {
  if (existsSync(BUNDLE_PATH)) return BUNDLE_PATH;
  const built = await runNpm(["run", "harness:build"], timeoutMs);
  if (!built || !existsSync(BUNDLE_PATH)) return null;
  return BUNDLE_PATH;
}
