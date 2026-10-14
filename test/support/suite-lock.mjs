/**
 * One browser-launching suite at a time, machine-wide.
 *
 * On 2026-09-03 three builders plus orchestrator verification ran browser
 * suites concurrently and pinned the machine's CPU at 100% with ~150 stray
 * chrome.exe. Standing law 11 made that a rule; this file makes it a mechanism,
 * so the rule holds even when nobody is watching the relay.
 *
 * The lock is a single file in `os.tmpdir()`. That location is the whole reason
 * it works across git worktrees: every builder shares one tmpdir, so a lock
 * taken in `.worktrees/snapshot` is visible from `.worktrees/transport`.
 *
 * Acquisition is `writeFile(..., { flag: "wx" })` — one atomic filesystem
 * operation that either creates the file or fails with EEXIST. Two processes
 * cannot both believe they won, which is the only property a mutex must have.
 * Waiters barge in with jittered backoff rather than queueing: the verdict
 * dropped FIFO tickets, and jitter is what keeps two waiters from colliding on
 * every poll.
 */

import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

export const LOCK_PATH = join(tmpdir(), "grazer-suite.lock");

/**
 * Optional trace sink.
 *
 * `node --test` captures a hook's stderr, so a lock message logged from a
 * `before` hook is invisible — which is exactly where every acquire happens.
 * Setting GRAZER_LOCK_DEBUG to a path makes the lock append its own timeline
 * there, which is the only way to see what two shells actually did.
 */
function trace(event, detail) {
  const path = process.env.GRAZER_LOCK_DEBUG;
  if (!path) return;
  try {
    appendFileSync(
      path,
      `${new Date().toISOString()} pid=${process.pid} ${event} ${detail}\n`,
    );
  } catch {
    // Tracing must never break a run.
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STALE_MS = 20 * 60_000;
/**
 * Errors that mean "the lock is not available right now", not "this is broken".
 *
 * Windows does not confine itself to EEXIST: an exclusive create racing the
 * holder's unlink surfaces as EPERM or EACCES, and a file still mapped by a
 * dying process as EBUSY.
 */
const CONTENTION_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

const MIN_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2_000;

/** Whether a pid is alive. Signal 0 tests without delivering anything. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — still alive.
    return error.code === "EPERM";
  }
}

/** The current holder, or null when the lock is free or unreadable. */
export async function readHolder(lockPath = LOCK_PATH) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function describe(holder) {
  if (!holder) return "an unreadable lock file";
  const age = Math.round((Date.now() - Date.parse(holder.acquiredAt ?? "")) / 1000);
  const seconds = Number.isFinite(age) ? `${age}s` : "unknown age";
  return `${holder.name ?? "unnamed"} (pid ${holder.pid}, held ${seconds})`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delete the lock file, tolerating the same Windows races as the create.
 *
 * A failed unlink must never propagate: it happens inside a release, and
 * throwing there would fail a suite that has already passed.
 */
async function removeLock(lockPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(lockPath, { force: true });
      return true;
    } catch (error) {
      if (!CONTENTION_CODES.has(error.code)) return false;
      await sleep(50 * 2 ** attempt);
    }
  }
  return false;
}

/**
 * Take the lock, run `fn`, release it.
 *
 * Never proceeds without the lock: a timeout throws naming the holder, because
 * running anyway is exactly the CPU pileup this exists to prevent.
 */
export async function withSuiteLock(name, fn, options = {}) {
  const handle = await acquireSuiteLock(name, options);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/**
 * Lower-level form for callers that are not a single function body (a test file
 * that takes the lock in `before` and releases it in `after`).
 */
export async function acquireSuiteLock(name, options = {}) {
  const {
    lockPath = LOCK_PATH,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    staleAfterMs = DEFAULT_STALE_MS,
    log = (message) => console.error(message),
    onWait,
    // Injectable so a test can drive the Windows EPERM path deterministically;
    // a real race is not reproducible on demand.
    createLock = (path, body) => writeFile(path, body, { flag: "wx" }),
  } = options;

  const token = { pid: process.pid, name, host: hostname(), acquiredAt: null };
  const deadline = Date.now() + timeoutMs;
  let backoff = MIN_BACKOFF_MS;
  let announced = false;

  for (;;) {
    token.acquiredAt = new Date().toISOString();
    try {
      await createLock(lockPath, JSON.stringify(token));
      trace("acquired", name);
      return makeHandle(lockPath, token, log);
    } catch (error) {
      // EEXIST is the ordinary "someone holds it". The others are Windows
      // being Windows: an exclusive create that races the holder's unlink
      // returns EPERM or EACCES, and a file still mapped by a dying process
      // returns EBUSY. All four mean "not mine yet, try again" — rethrowing
      // one of them killed a whole suite from inside its before() hook.
      if (!CONTENTION_CODES.has(error.code)) throw error;
      trace("contended", `${error.code} on open`);
    }

    const holder = await readHolder(lockPath);
    // A holder whose process is gone, or one that has held far longer than any
    // suite runs, is a crash rather than a queue. Reclaiming is announced: a
    // silent steal would hide a real deadlock.
    const dead = holder && !pidAlive(holder.pid);
    const ancient =
      holder && Date.now() - Date.parse(holder.acquiredAt ?? "") > staleAfterMs;
    if (!holder || dead || ancient) {
      log(
        `[suite-lock] reclaiming ${describe(holder)} — ${
          !holder ? "unreadable" : dead ? "process is gone" : "held past the stale window"
        }`,
      );
      trace("reclaimed", `${holder?.name ?? "unreadable"} pid=${holder?.pid}`);
      await removeLock(lockPath);
      continue;
    }

    if (!announced) {
      announced = true;
      log(`[suite-lock] ${name} waiting for ${describe(holder)}`);
      onWait?.(holder);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[suite-lock] ${name} timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${describe(holder)}`,
      );
    }
    // Jitter: two waiters polling on the same cadence would keep colliding.
    const jittered = Math.min(backoff, MAX_BACKOFF_MS) * (0.5 + Math.random());
    await sleep(Math.min(jittered, Math.max(0, deadline - Date.now())));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

function makeHandle(lockPath, token, log) {
  let released = false;

  /**
   * Release only if the file still holds OUR pid.
   *
   * A process whose lock was reclaimed as stale would otherwise delete its
   * successor's lock on the way out, handing the machine to two suites at once
   * — the exact failure this module exists to prevent.
   */
  const release = async () => {
    if (released) return;
    released = true;
    process.off("exit", onExit);
    process.off("beforeExit", onBeforeExit);
    const holder = await readHolder(lockPath);
    if (holder && holder.pid !== token.pid) {
      log(
        `[suite-lock] not releasing: the lock now belongs to ${describe(holder)}, not pid ${token.pid}`,
      );
      return;
    }
    trace("released", token.name);
    await removeLock(lockPath);
  };

  // `beforeExit` still has an event loop, so the async release runs properly
  // when a suite process ends normally.
  const onBeforeExit = () => {
    void release();
  };
  process.once("beforeExit", onBeforeExit);

  // Backstop for a hard exit (Ctrl+C, an explicit process.exit), where
  // `beforeExit` never fires. Sync, because `exit` cannot await.
  function onExit() {
    if (released) return;
    try {
      if (JSON.parse(readFileSync(lockPath, "utf8"))?.pid === token.pid) {
        trace("released-on-exit", token.name);
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Nothing useful to do while the process is already leaving.
    }
  }
  process.once("exit", onExit);

  return { release, token, lockPath };
}
