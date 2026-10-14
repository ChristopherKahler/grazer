/**
 * AC-1/AC-2/AC-3: a bundle replayed into a task space leaves a page in that
 * space already logged in, and leaves every other space untouched.
 *
 * The bundle here is built with the extension's OWN encoder rather than by
 * driving the extension: AC-1 allows a fixture bundle of the same shape, 04-01
 * already proves the export path end to end, and coupling this suite to
 * extension loading would make a replay failure ambiguous between the two
 * halves. Using the real encoder is what keeps the shape honest.
 *
 * Skips cleanly without Chromium; kills the browser and the site in finally.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect } from "../dist/cdp/connection.js";
import { createSpace } from "../dist/spaces/manager.js";
import { readStore, writeStore } from "../dist/spaces/store.js";
import { encode } from "../extension/lib/idb-codec.mjs";
import { findChromium, removeProfileDir } from "./support/chromium.mjs";
import { ensureHarnessBundle, PACKAGE_ROOT } from "./support/harness-bundle.mjs";
import { startFixtureSite } from "./support/fixture-site.mjs";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

const chromium = findChromium();
const skip = chromium ? false : "no Chromium found (set GRAZER_BROWSER to run this)";

const GRAZER_CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");
const REPLAY_CLI = join(PACKAGE_ROOT, "bin", "grazer-replay.mjs");

/** Run a Node CLI in the repo with a given GRAZER_HOME. */
function run(script, args, { env, input, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
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
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    child.stdin.end(input ?? "");
  });
}

/**
 * A bundle of exactly the shape 04-01 exports, for the fixture origin.
 *
 * Cookies: one HttpOnly (no page can plant it, so finding it later proves the
 * cookie jar was written) and one ordinary. IndexedDB carries a Date and a
 * Uint8Array, the two values plain JSON would silently destroy.
 */
function fixtureBundle(origin) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    browser: { name: "chrome", version: "152.0.0.0" },
    origins: [
      {
        origin,
        site: "127.0.0.1",
        cookies: [
          {
            name: "grz_http",
            value: "secret",
            domain: "127.0.0.1",
            path: "/",
            secure: false,
            httpOnly: true,
            sameSite: "unspecified",
            session: true,
            partitionKey: null,
          },
          {
            name: "grz_js",
            value: "visible",
            domain: "127.0.0.1",
            path: "/",
            secure: false,
            httpOnly: false,
            sameSite: "lax",
            session: true,
            partitionKey: null,
          },
        ],
        localStorage: { grz_ls: "1" },
        indexedDB: [
          {
            name: "grzdb",
            version: 2,
            stores: [
              {
                name: "items",
                keyPath: "id",
                autoIncrement: false,
                indexes: [
                  { name: "by_label", keyPath: "label", unique: false, multiEntry: false },
                ],
                records: [
                  { key: encode(1), value: encode({ id: 1, label: "plain", note: "hello" }) },
                  {
                    key: encode(2),
                    value: encode({
                      id: 2,
                      label: "dated",
                      at: new Date("2024-05-06T07:08:09.000Z"),
                    }),
                  },
                  {
                    key: encode(3),
                    value: encode({
                      id: 3,
                      label: "binary",
                      bytes: new Uint8Array([1, 2, 3, 4, 5]),
                    }),
                  },
                ],
                truncated: false,
              },
            ],
          },
        ],
        errors: [],
      },
    ],
  };
}

/** Bring up a Grazer browser on a temp home, plus the fixture site. */
async function withReplayEnvironment(body) {
  const home = await mkdtemp(join(tmpdir(), "grazer-replay-home-"));
  const env = { GRAZER_HOME: home, GRAZER_BROWSER: chromium };
  const site = await startFixtureSite();
  let connection;
  try {
    const started = await run(GRAZER_CLI, ["browser", "start", "--headless"], { env });
    assert.equal(started.code, 0, `browser start failed: ${started.stderr}`);

    const state = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(join(home, "browser.json"), "utf8"),
      ),
    );
    connection = await connect({ wsUrl: state.wsUrl });
    const send = async (method, params, sessionId) =>
      (await connection.send(method, params ?? {}, sessionId)).result ?? {};

    return await body({ home, env, site, connection, send });
  } finally {
    await connection?.close().catch(() => {});
    await run(GRAZER_CLI, ["browser", "stop"], { env }).catch(() => {});
    await site.close().catch(() => {});
    await removeProfileDir(home);
  }
}

/** Create a task space through the 02-01 manager and persist its row. */
async function makeSpace(connection, home, name) {
  const store = readStore(home);
  const row = await createSpace(connection, store, name);
  writeStore(home, store);
  return row;
}

/** Open a tab on `url` inside a context and return an evaluator for it. */
async function openInContext(send, connection, browserContextId, url) {
  const { targetId } = await send("Target.createTarget", { url, browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await new Promise((resolve) => {
    const off = connection.onEvent((event) => {
      if (event.method === "Page.loadEventFired" && event.sessionId === sessionId) {
        off();
        resolve();
      }
    });
    setTimeout(() => {
      off();
      resolve();
    }, 15_000);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return {
    sessionId,
    async evaluate(expression) {
      const result = await send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result?.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            "evaluate failed",
        );
      }
      return result?.result?.value;
    },
  };
}

const READ_IDB = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('grzdb');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    if (!db.objectStoreNames.contains('items')) return { records: [] };
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const request = tx.objectStore('items').getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return {
      records: records.map((record) => ({
        id: record.id,
        label: record.label,
        isDate: record.at instanceof Date,
        at: record.at instanceof Date ? record.at.toISOString() : null,
        isBytes: record.bytes instanceof Uint8Array,
        bytes: record.bytes instanceof Uint8Array ? [...record.bytes] : null,
      })),
      indexes: db.transaction('items', 'readonly').objectStore('items').indexNames.length,
      version: db.version,
    };
  } finally {
    db.close();
  }
})()`;

test("AC-1/AC-2: a replayed space is logged in and others are untouched", { skip }, async () => {
  await withReplayEnvironment(async ({ home, env, site, connection, send }) => {
    const target = await makeSpace(connection, home, "replayed");
    const other = await makeSpace(connection, home, "untouched");

    const bundlePath = join(home, "bundles", "fixture.json");
    await mkdir(join(home, "bundles"), { recursive: true });
    await writeFile(bundlePath, JSON.stringify(fixtureBundle(site.origin)), "utf8");

    // ---- AC-2: the CLI reports per-origin counts and exits 0 -------------
    const replayed = await run(REPLAY_CLI, ["replayed", "--bundle", bundlePath], { env });
    assert.equal(replayed.code, 0, `replay failed: ${replayed.stderr}${replayed.stdout}`);
    assert.match(replayed.stdout, /cookies: 2/);
    assert.match(replayed.stdout, /storage keys: 1/);
    assert.match(replayed.stdout, /IDB records: 3/);
    assert.ok(replayed.stdout.includes(site.origin), replayed.stdout);

    // ---- AC-1: cookies are in the context's jar, httpOnly preserved ------
    const jar = await send("Storage.getCookies", {
      browserContextId: target.browserContextId,
    });
    const byName = new Map((jar.cookies ?? []).map((cookie) => [cookie.name, cookie]));
    assert.ok(byName.has("grz_http"), `grz_http missing: ${JSON.stringify(jar.cookies)}`);
    assert.ok(byName.has("grz_js"));
    assert.equal(byName.get("grz_http").httpOnly, true, "httpOnly survived the replay");
    assert.equal(byName.get("grz_js").httpOnly, false);

    // ---- AC-1: the server sees both cookies on a real request ------------
    const page = await openInContext(
      send,
      connection,
      target.browserContextId,
      `${site.origin}/whoami`,
    );
    const whoami = await page.evaluate("document.body.innerText");
    assert.match(whoami, /grz_http=secret/, `whoami body was ${whoami}`);
    assert.match(whoami, /grz_js=visible/);

    // ---- AC-1: localStorage and IndexedDB, with real types ---------------
    const home_page = await openInContext(
      send,
      connection,
      target.browserContextId,
      `${site.origin}/replayed-check`,
    );
    assert.equal(await home_page.evaluate("localStorage.getItem('grz_ls')"), "1");

    const idb = await home_page.evaluate(READ_IDB);
    assert.equal(idb.records.length, 3, `records: ${JSON.stringify(idb.records)}`);
    assert.equal(idb.version, 2, "the recorded database version was used");
    assert.equal(idb.indexes, 1, "the index was recreated");
    const dated = idb.records.find((record) => record.label === "dated");
    assert.ok(dated?.isDate, "a Date decoded to a real Date, not a string");
    assert.equal(dated.at, "2024-05-06T07:08:09.000Z");
    const binary = idb.records.find((record) => record.label === "binary");
    assert.ok(binary?.isBytes, "a Uint8Array decoded to a real Uint8Array");
    assert.deepEqual(binary.bytes, [1, 2, 3, 4, 5]);

    // ---- AC-1: a second, unrelated space sees none of it ------------------
    const otherJar = await send("Storage.getCookies", {
      browserContextId: other.browserContextId,
    });
    assert.equal(
      (otherJar.cookies ?? []).filter((cookie) => cookie.name.startsWith("grz_")).length,
      0,
      "the other space's jar must stay empty",
    );
    const otherPage = await openInContext(
      send,
      connection,
      other.browserContextId,
      `${site.origin}/whoami`,
    );
    const otherWhoami = await otherPage.evaluate("document.body.innerText");
    assert.ok(!otherWhoami.includes("grz_http"), `leaked into other space: ${otherWhoami}`);
    assert.equal(await otherPage.evaluate("localStorage.getItem('grz_ls')"), null);
  });
});

test("AC-2: a broken store is reported and the rest still replays", { skip }, async () => {
  await withReplayEnvironment(async ({ home, env, site, connection }) => {
    await makeSpace(connection, home, "partial");

    // A store whose index keyPath is invalid makes the IndexedDB seed throw
    // while cookies and localStorage are perfectly replayable.
    const bundle = fixtureBundle(site.origin);
    bundle.origins[0].indexedDB[0].stores[0].indexes[0].keyPath = ["bad", "["];
    bundle.origins[0].indexedDB[0].stores[0].indexes[0].multiEntry = true;
    const bundlePath = join(home, "bundles", "broken.json");
    await mkdir(join(home, "bundles"), { recursive: true });
    await writeFile(bundlePath, JSON.stringify(bundle), "utf8");

    const result = await run(REPLAY_CLI, ["partial", "--bundle", bundlePath], { env });
    assert.equal(result.code, 1, "a failed store exits 1");
    assert.match(result.stdout, /cookies: 2/, "cookies still replayed");
    assert.match(result.stdout, /storage keys: 1/, "localStorage still replayed");
    assert.match(result.stdout, /IDB records: FAILED/);
    assert.match(result.stderr, /indexedDB FAILED:/);
  });
});

test("AC-2: the CLI refuses an unknown space and a missing bundle", { skip }, async () => {
  await withReplayEnvironment(async ({ home, env, site, connection }) => {
    await makeSpace(connection, home, "real");
    const bundlePath = join(home, "bundles", "fixture.json");
    await mkdir(join(home, "bundles"), { recursive: true });
    await writeFile(bundlePath, JSON.stringify(fixtureBundle(site.origin)), "utf8");

    const unknown = await run(REPLAY_CLI, ["nope", "--bundle", bundlePath], { env });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no task space named nope/);

    // A real space, so the run reaches the bundle before it can fail on the name.
    const missing = await run(REPLAY_CLI, ["real", "--bundle", join(home, "gone.json")], {
      env,
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /cannot read bundle/);
  });
});

/**
 * A bundle whose markers the fixture can NOT create by itself.
 *
 * `fixtureBundle` reuses `grz_http` and `grz_ls`, which the fixture server sets
 * on every response and the fixture page writes on every load — so a context
 * that merely VISITED the origin has them, replay or no replay. Asserting on
 * those proves nothing in either direction: the positive check passes when
 * replay did nothing, and the isolation check fails when nothing leaked. These
 * names appear only if replay put them there.
 */
function replayOnlyBundle(origin) {
  const base = fixtureBundle(origin);
  base.origins[0].cookies = [
    {
      name: "grz_replay",
      value: "only-from-replay",
      domain: "127.0.0.1",
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "unspecified",
      session: true,
      partitionKey: null,
    },
  ];
  base.origins[0].localStorage = { grz_replay: "only-from-replay" };
  base.origins[0].indexedDB = [];
  return base;
}

test("AC-2: --default-context seeds the profile, and spaces stay isolated", { skip }, async () => {
  await withReplayEnvironment(async ({ home, env, site, connection, send }) => {
    const bundlePath = join(home, "bundles", "default-context.json");
    await mkdir(join(home, "bundles"), { recursive: true });
    await writeFile(bundlePath, JSON.stringify(replayOnlyBundle(site.origin)), "utf8");

    // A space that exists but is NOT the replay target: it must stay clean.
    const untouched = await makeSpace(connection, home, "untouched");

    const replayed = await run(REPLAY_CLI, ["--default-context", "--bundle", bundlePath], { env });
    assert.equal(replayed.code, 0, `replay failed: ${replayed.stderr}`);
    assert.match(replayed.stdout, /into the default browser context/);

    // The default context is addressed by OMITTING browserContextId, which is
    // what openInContext does when handed undefined.
    const page = await openInContext(send, connection, undefined, `${site.origin}/`);
    assert.equal(
      await page.evaluate("localStorage.getItem('grz_replay')"),
      "only-from-replay",
      "the replayed localStorage is not in the default context",
    );

    // The server-side check is the real one for an HttpOnly cookie: no page
    // script can read or set it, so only the browser's own jar can send it.
    const whoami = await page.evaluate(
      `fetch(${JSON.stringify(site.origin + "/whoami")}, { credentials: "include" }).then((r) => r.text())`,
    );
    assert.match(
      String(whoami),
      /grz_replay=only-from-replay/,
      `the default context did not send the replayed HttpOnly cookie; server saw ${whoami}`,
    );

    // Isolation: the space that was never targeted has none of it.
    const spaced = await openInContext(
      send,
      connection,
      untouched.browserContextId,
      `${site.origin}/`,
    );
    assert.equal(
      await spaced.evaluate("localStorage.getItem('grz_replay')"),
      null,
      "replaying into the default context leaked localStorage into a task space",
    );
    const spacedWhoami = await spaced.evaluate(
      `fetch(${JSON.stringify(site.origin + "/whoami")}, { credentials: "include" }).then((r) => r.text())`,
    );
    assert.ok(
      !/grz_replay=only-from-replay/.test(String(spacedWhoami)),
      `the replayed cookie leaked into a task space; server saw ${spacedWhoami}`,
    );
  });
});

test("AC-2: --default-context refuses a space argument", { skip }, async () => {
  await withReplayEnvironment(async ({ home, env, site }) => {
    const bundlePath = join(home, "bundles", "fixture.json");
    await mkdir(join(home, "bundles"), { recursive: true });
    await writeFile(bundlePath, JSON.stringify(fixtureBundle(site.origin)), "utf8");

    const both = await run(
      REPLAY_CLI,
      ["--default-context", "someSpace", "--bundle", bundlePath],
      { env },
    );
    assert.equal(both.code, 1);
    assert.match(both.stderr, /--default-context takes no space argument/);
  });
});

/* ------------------------------------------------- AC-3: through the harness */

const harnessBundle = chromium ? await ensureHarnessBundle() : null;
const harnessSkip = skip
  ? skip
  : harnessBundle
    ? false
    : "harness bundle not built (npm run harness:build)";

/**
 * Law 11: one browser-launching suite at a time, machine-wide.
 *
 * Held for the whole FILE rather than per test — releasing between this file's
 * own tests would let another suite interleave, which is exactly what the lock
 * exists to prevent.
 */
let suiteLock;
before(async () => {
  if (skip) return;
  suiteLock = await acquireSuiteLock("replay.live");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


test("AC-3: a replayed space is logged in through the harness", { skip: harnessSkip }, async () => {
  await withReplayEnvironment(async ({ home, env, site, connection }) => {
    const name = "replay-e2e";

    // The space is created the way an agent creates one, so the row the replay
    // CLI resolves is the row the harness will later switch to.
    const created = await run(GRAZER_CLI, ["nodejs"], {
      env,
      input: `await taskSpaces.useOrCreate(${JSON.stringify(name)})\nconsole.log("created")\n`,
    });
    assert.equal(created.code, 0, `useOrCreate failed: ${created.stderr}`);

    const bundlePath = join(home, "bundles", "fixture.json");
    await mkdir(join(home, "bundles"), { recursive: true });
    await writeFile(bundlePath, JSON.stringify(fixtureBundle(site.origin)), "utf8");

    const replayed = await run(REPLAY_CLI, [name, "--bundle", bundlePath], { env });
    assert.equal(replayed.code, 0, `replay failed: ${replayed.stderr}${replayed.stdout}`);

    const checked = await run(GRAZER_CLI, ["nodejs"], {
      env,
      input: [
        `await taskSpaces.switch(${JSON.stringify(name)})`,
        `await page.goto(${JSON.stringify(`${site.origin}/whoami`)})`,
        'console.log(await page.evaluate("document.body.innerText"))',
        "",
      ].join("\n"),
      timeoutMs: 120_000,
    });
    assert.equal(checked.code, 0, `heredoc failed: ${checked.stderr}`);
    assert.match(
      checked.stdout,
      /grz_http=secret/,
      `the harness page did not carry the replayed HttpOnly cookie: ${checked.stdout}${checked.stderr}`,
    );
  });
});
