/**
 * Locate a Chromium-family browser for the integration tests.
 *
 * Tests must skip cleanly rather than fail on a machine with no browser, so
 * this returns null instead of throwing.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerProfile } from "./profile-registry.mjs";

const CANDIDATES = [
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Absolute path to a Chromium executable, or null when none is installed. */
export function findChromium() {
  const fromEnv = process.env.GRAZER_BROWSER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A fresh temp profile directory. Chrome 136+ needs one for remote debugging.
 *
 * Registered as it is created, not as it is cleaned up: the runs whose
 * directories actually leak are the ones that crash before teardown, and those
 * never reach a deregister call. `npm run test:clean` sweeps the registry.
 */
export async function makeProfileDir(prefix = "grazer-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  registerProfile(dir);
  return dir;
}

/**
 * Best-effort cleanup of a temp profile directory.
 *
 * Never throws, and never fails a test that has already passed. Chrome keeps
 * `profile/lockfile` mapped for a moment after the process dies, so an unlink
 * here hits EBUSY as a matter of course; `rm`'s own `maxRetries` only backs off
 * for a few known codes, so this retries with its own escalating wait and then
 * gives up quietly. `npm run test:clean` sweeps whatever survives.
 */
export async function removeProfileDir(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}

/** Poll `check` until it returns truthy, or throw after `timeoutMs`. */
export async function waitFor(check, { timeoutMs = 10_000, intervalMs = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
