/**
 * Removing a temp directory without letting the tidy-up become the test result.
 *
 * Windows does not release a directory the instant the last handle closes — a
 * browser profile, a bundle a child process just wrote, a store file — so an
 * `rm` in teardown can throw `ENOTEMPTY` or `EBUSY` while everything the test
 * actually asserted has already passed. `force: true` does NOT cover this: it
 * swallows `ENOENT` only, and the default `maxRetries` is 0.
 *
 * node:test then blames the test that owned the teardown, which is how this
 * shows up: an unrelated test "failing" under load, at a different rate each
 * time, on an assertion that never ran.
 *
 * Captured three times before this module existed, in three different files
 * and two different shapes:
 *
 *   not ok 54 - createTaskSpace refuses a duplicate name          (uncaptured detail)
 *   not ok 69 - loadBundle and newestBundlePath read the host's directory
 *               failureType: hookFailed
 *               ENOTEMPTY: rmdir Temp\grazer-replay-unit-w9ChFl
 *   not ok 72 - AC-3: the host answers hello and stores a bundle under GRAZER_HOME
 *               testCodeFailure
 *               ENOTEMPTY: rmdir Temp\grazer-home-gw5NXJ\bundles
 *
 * `hookFailed` is an after-hook; `testCodeFailure` is a `finally` inside the
 * test body. Same race, two shapes, which is why both spellings live here
 * rather than being copied per file.
 *
 * Retry, then give up quietly. A leftover temp directory is not a test result —
 * the OS reclaims it — but a thrown teardown destroys one.
 */

import { rm } from "node:fs/promises";
import { rmSync } from "node:fs";

const RETRIES = 10;
const RETRY_DELAY_MS = 50;

/** Errors that mean "still held", as opposed to a real problem worth failing on. */
const TRANSIENT = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Remove a directory tree, tolerating a Windows hold-open.
 * @param {string} dir
 */
export async function cleanHome(dir) {
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS });
  } catch (error) {
    if (!TRANSIENT.has(error?.code)) throw error;
  }
}

/**
 * The synchronous spelling, for teardown in a `finally` that cannot await.
 * @param {string} dir
 */
export function cleanHomeSync(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS });
  } catch (error) {
    if (!TRANSIENT.has(error?.code)) throw error;
  }
}
