/**
 * The suite lock, tested without a browser.
 *
 * These are the properties the CPU budget actually rests on, so each one is
 * driven through the real filesystem rather than a mock: a mocked mutex proves
 * nothing about `wx` on Windows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanHome } from "./support/clean-home.mjs";

import {
  acquireSuiteLock,
  readHolder,
  withSuiteLock,
} from "./support/suite-lock.mjs";
import {
  readRegistry,
  registerProfile,
  writeRegistry,
} from "./support/profile-registry.mjs";

// An absolute Windows path is not an importable ESM specifier; the child gets
// a file:// URL.
const SUPPORT = new URL("./support/suite-lock.mjs", import.meta.url).href;

async function tempLock(t) {
  const dir = await mkdtemp(join(tmpdir(), "grazer-lock-test-"));
  t.after(() => cleanHome(dir));
  return join(dir, "suite.lock");
}

const quiet = () => {};

test("the lock is exclusive and released afterwards", async (t) => {
  const lockPath = await tempLock(t);
  let ran = false;
  await withSuiteLock("first", async () => {
    ran = true;
    const holder = await readHolder(lockPath);
    assert.equal(holder.pid, process.pid, "the lock names the holding process");
    assert.equal(holder.name, "first");
  }, { lockPath, log: quiet });
  assert.ok(ran);
  assert.equal(existsSync(lockPath), false, "released on the way out");
});

test("the lock is released even when the body throws", async (t) => {
  const lockPath = await tempLock(t);
  await assert.rejects(
    () => withSuiteLock("boom", async () => { throw new Error("body failed"); }, { lockPath, log: quiet }),
    /body failed/,
  );
  assert.equal(existsSync(lockPath), false, "a failing suite must not wedge the lock");
});

test("a live holder makes a second waiter time out, naming it", async (t) => {
  const lockPath = await tempLock(t);
  // A live pid: this process. So the lock is genuinely held, not stale.
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      name: "long-runner",
      acquiredAt: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    () => acquireSuiteLock("waiter", { lockPath, timeoutMs: 600, log: quiet }),
    (error) => {
      assert.match(error.message, /timed out/);
      assert.match(error.message, /long-runner/, "the message names the holder");
      assert.match(error.message, new RegExp(`pid ${process.pid}`));
      return true;
    },
  );
});

test("a dead holder is reclaimed rather than waited on", async (t) => {
  const lockPath = await tempLock(t);
  // Exit a real child so its pid is genuinely gone rather than guessed at.
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = await new Promise((resolve) => dead.once("exit", () => resolve(dead.pid)));

  await writeFile(
    lockPath,
    JSON.stringify({
      pid: deadPid,
      name: "crashed-suite",
      acquiredAt: new Date().toISOString(),
    }),
  );
  const logged = [];
  const handle = await acquireSuiteLock("next", {
    lockPath,
    timeoutMs: 5_000,
    log: (message) => logged.push(message),
  });
  assert.equal((await readHolder(lockPath)).pid, process.pid, "we now hold it");
  assert.ok(
    logged.some((line) => line.includes("reclaiming") && line.includes("crashed-suite")),
    `the reclaim is announced, not silent: ${logged.join(" | ")}`,
  );
  await handle.release();
});

test("a holder past the stale window is reclaimed even while alive", async (t) => {
  const lockPath = await tempLock(t);
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      name: "wedged",
      acquiredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }),
  );
  const handle = await acquireSuiteLock("next", {
    lockPath,
    staleAfterMs: 60_000,
    timeoutMs: 5_000,
    log: quiet,
  });
  assert.equal((await readHolder(lockPath)).name, "next");
  await handle.release();
});

test("release does nothing when the lock has been taken over", async (t) => {
  const lockPath = await tempLock(t);
  const handle = await acquireSuiteLock("mine", { lockPath, log: quiet });

  // Simulate our lock being reclaimed as stale and handed to someone else.
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 999_999, name: "successor", acquiredAt: new Date().toISOString() }),
  );
  await handle.release();

  const holder = await readHolder(lockPath);
  assert.equal(
    holder?.name,
    "successor",
    "releasing must not delete a lock that is no longer ours",
  );
});

test("two processes serialise: the second starts only after the first releases", async (t) => {
  const lockPath = await tempLock(t);
  const logPath = `${lockPath}.log`;

  /**
   * Each child appends `enter:<name>` and `exit:<name>` to one shared file
   * while it holds the lock.
   *
   * The check is the ORDER of those lines, never a clock. Comparing Date.now()
   * across two processes made this test flake once under load: the lock was
   * correct, but a release and the next acquire can straddle a millisecond tick
   * and invert the recorded timestamps. Append order cannot lie that way.
   */
  const child = (name, holdMs) =>
    new Promise((resolve) => {
      const source = `
        import { appendFileSync } from "node:fs";
        import { withSuiteLock } from ${JSON.stringify(SUPPORT)};
        const mark = (event) => appendFileSync(${JSON.stringify(logPath)}, event + ":" + ${JSON.stringify(name)} + "\\n");
        await withSuiteLock(${JSON.stringify(name)}, async () => {
          mark("enter");
          await new Promise((r) => setTimeout(r, ${holdMs}));
          mark("exit");
        }, { lockPath: ${JSON.stringify(lockPath)}, timeoutMs: 30000, log: () => {} });
      `;
      const proc = spawn(process.execPath, ["--input-type=module", "-e", source], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      proc.stderr.on("data", (chunk) => (err += chunk));
      proc.once("exit", (code) => resolve({ code, err }));
    });

  const [a, b] = await Promise.all([child("alpha", 800), child("beta", 50)]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);

  const events = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  assert.equal(events.length, 4, `expected two enter/exit pairs: ${events.join(" ")}`);

  // Every enter must be immediately followed by its own exit. Any interleaving
  // means two suites held the lock at once.
  for (let i = 0; i < events.length; i += 2) {
    const [enterEvent, enterName] = events[i].split(":");
    const [exitEvent, exitName] = events[i + 1].split(":");
    assert.equal(enterEvent, "enter", `out of order: ${events.join(" ")}`);
    assert.equal(exitEvent, "exit", `overlapping holds: ${events.join(" ")}`);
    assert.equal(exitName, enterName, `interleaved holds: ${events.join(" ")}`);
  }
  assert.notEqual(
    events[0].split(":")[1],
    events[2].split(":")[1],
    "both holds came from the same child",
  );
});

test("a process that dies holding the lock does not wedge the next one", async (t) => {
  const lockPath = await tempLock(t);
  const source = `
    import { acquireSuiteLock } from ${JSON.stringify(SUPPORT)};
    await acquireSuiteLock("suicide", { lockPath: ${JSON.stringify(lockPath)}, log: () => {} });
    process.kill(process.pid, "SIGKILL");
  `;
  const childPid = await new Promise((resolve) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: "ignore",
    });
    proc.once("exit", () => resolve(proc.pid));
  });

  // Prove the child really took the lock before dying, or this test would pass
  // just as happily on a child that crashed before ever acquiring it.
  const stranded = await readHolder(lockPath);
  assert.equal(stranded?.name, "suicide", "the killed child had the lock");
  assert.equal(stranded.pid, childPid);

  // SIGKILL runs no exit handler, so the lock file is left behind; the next
  // acquire has to notice the pid is gone and reclaim it.
  const handle = await acquireSuiteLock("after", {
    lockPath,
    timeoutMs: 5_000,
    log: quiet,
  });
  assert.equal((await readHolder(lockPath)).name, "after");
  await handle.release();
});

/* ------------------------------------------------------- profile registry */

test("the profile registry appends, de-duplicates and rewrites", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "grazer-registry-test-"));
  t.after(() => cleanHome(dir));
  const registry = join(dir, "profiles.txt");

  assert.deepEqual(readRegistry(registry), [], "absent registry reads as empty");
  registerProfile(join(dir, "profile-a"), registry);
  registerProfile(join(dir, "profile-b"), registry);
  registerProfile(join(dir, "profile-a"), registry);
  assert.deepEqual(readRegistry(registry), [
    join(dir, "profile-a"),
    join(dir, "profile-b"),
  ]);

  await writeRegistry([join(dir, "profile-b")], registry);
  assert.deepEqual(readRegistry(registry), [join(dir, "profile-b")]);

  registerProfile("", registry);
  assert.deepEqual(readRegistry(registry), [join(dir, "profile-b")], "empty path ignored");
  assert.equal(
    (await readFile(registry, "utf8")).endsWith("\n"),
    true,
    "entries stay line-delimited",
  );
});

/* --------------------------------------------- Windows contention codes */

/** An fs error with a code, the way node raises one. */
function fsError(code) {
  const error = new Error(`${code}: simulated`);
  error.code = code;
  return error;
}

test("acquire treats EPERM/EACCES/EBUSY as contention, not as a crash", async (t) => {
  // Windows returns EPERM (not EEXIST) when an exclusive create races the
  // holder's unlink. Rethrowing it killed a whole suite from its before()
  // hook during the G2 rerun, so each code has to retry instead.
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const lockPath = await tempLock(t);
    let attempts = 0;
    const handle = await acquireSuiteLock("racer", {
      lockPath,
      timeoutMs: 5_000,
      log: quiet,
      createLock: async (path, body) => {
        attempts += 1;
        // Fail twice the way a real race does, then let the create through.
        if (attempts <= 2) throw fsError(code);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, body, { flag: "wx" });
      },
    });
    assert.equal(attempts, 3, `${code} should have been retried, not thrown`);
    assert.equal((await readHolder(lockPath)).name, "racer");
    await handle.release();
  }
});

test("acquire still surfaces a genuine filesystem failure", async (t) => {
  const lockPath = await tempLock(t);
  await assert.rejects(
    () =>
      acquireSuiteLock("broken", {
        lockPath,
        timeoutMs: 2_000,
        log: quiet,
        createLock: async () => {
          throw fsError("ENOSPC");
        },
      }),
    /ENOSPC/,
    "an error that is not contention must not be retried into a timeout",
  );
});

test("a contended create still times out rather than spinning forever", async (t) => {
  const lockPath = await tempLock(t);
  // A live holder plus a create that always reports contention: the waiter must
  // still give up on the deadline and name who it was waiting for.
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, name: "holder", acquiredAt: new Date().toISOString() }),
  );
  await assert.rejects(
    () =>
      acquireSuiteLock("waiter", {
        lockPath,
        timeoutMs: 600,
        log: quiet,
        createLock: async () => {
          throw fsError("EPERM");
        },
      }),
    /timed out.*holder/s,
  );
});
