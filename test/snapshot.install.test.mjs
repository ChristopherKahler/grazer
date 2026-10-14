/**
 * AC-3: `grazer.snapshot(options)` on the runtime, driven the way the harness
 * drives it — attach through `sendCDPMessage`, then page-level sends carrying
 * that sessionId.
 *
 * The adapter never touches `sendCDPMessage` itself; it numbers its own
 * requests through `connection.send`, so harness ids stay untouched.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect } from "../dist/cdp/connection.js";
import { createGrazerRuntime } from "../dist/grazer/runtime.js";
import { findRow, readStore, writeStore } from "../dist/spaces/store.js";
import { attachSnapshot } from "../dist/snapshot/index.js";
import { acquireSuiteLock } from "./support/suite-lock.mjs";
import {
  findChromium,
  launchChromium,
  startFixtureServer,
} from "./support/capture-ax.mjs";

const chromium = findChromium();
const skip = chromium ? false : "no Chromium found (set GRAZER_BROWSER to run this)";

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
  suiteLock = await acquireSuiteLock("snapshot.install");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


/** Drive the runtime exactly as the harness does: ids we choose, replies by callback. */
function harnessClient(runtime) {
  let nextId = 1;
  const pending = new Map();
  runtime.onCDPMessage = (raw) => {
    const frame = JSON.parse(raw);
    const entry = frame.id !== undefined ? pending.get(frame.id) : undefined;
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.error) entry.reject(new Error(frame.error.message));
    else entry.resolve(frame.result ?? {});
  };
  runtime.onSendCDPMessageError = (message, error_code) => {
    for (const [, entry] of pending) entry.reject(new Error(`${error_code}: ${message}`));
    pending.clear();
  };
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      runtime.sendCDPMessage(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
}

async function withRuntime(body) {
  const server = await startFixtureServer();
  const browser = await launchChromium(chromium);
  let connection;
  let detach;
  try {
    connection = await connect({ wsUrl: browser.endpoint });
    const runtime = createGrazerRuntime(connection);
    detach = attachSnapshot(runtime, { connection });
    const sendCDP = harnessClient(runtime);
    return await body({ runtime, connection, sendCDP, server });
  } finally {
    detach?.();
    await connection?.close();
    await browser.kill();
    await server.close();
  }
}

/** The harness's own attach + navigate sequence. */
async function openFixture(sendCDP, origin) {
  const { targetId } = await sendCDP("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await sendCDP("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await sendCDP("Page.enable", {}, sessionId);
  await sendCDP("Page.navigate", { url: `${origin}/` }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 900));
  return sessionId;
}

test("AC-3: attachSnapshot exposes an enumerable snapshot method", { skip }, async () => {
  await withRuntime(async ({ runtime }) => {
    assert.equal(typeof runtime.snapshot, "function");
    assert.ok(
      Object.keys(runtime).includes("snapshot"),
      "the harness re-exposes own ENUMERABLE function keys, so it must be enumerable",
    );
  });
});

test("AC-3: grazer.snapshot resolves { content, refs } for the fixture", { skip }, async () => {
  await withRuntime(async ({ runtime, sendCDP, server }) => {
    await openFixture(sendCDP, server.origin);

    const result = await runtime.snapshot({
      scope: "full_page",
      includeActionMarks: true,
      includeStableLocator: true,
    });
    assert.equal(typeof result.content, "string");
    assert.ok(Array.isArray(result.refs));
    assert.ok(result.refs.length > 0, "refs.length > 0");
    assert.ok(result.content.includes("Helper e2e fixture"), result.content);
    assert.ok(
      result.refs.some((ref) => ref.role === "button" && ref.name === "Click counter"),
      "the fixture button is in refs",
    );
    for (const ref of result.refs) {
      assert.equal(typeof ref.backendNodeId, "number");
    }

    // The adapter must not have disturbed the harness's own id space.
    const info = await sendCDP("Browser.getVersion");
    assert.ok(typeof info.product === "string" && info.product.length > 0);
  });
});

test("AC-3: it tracks the harness's page session, not one of its own", { skip }, async () => {
  await withRuntime(async ({ runtime, sendCDP, server }) => {
    const sessionId = await openFixture(sendCDP, server.origin);
    const result = await runtime.snapshot({ scope: "full_page" });
    const buttonRef = result.refs.find((ref) => ref.name === "Click counter");
    assert.ok(buttonRef, "refs carry the button");
    // Resolving on the HARNESS's session proves the snapshot came from it.
    const resolved = await sendCDP(
      "DOM.resolveNode",
      { backendNodeId: buttonRef.backendNodeId, objectGroup: "grazer" },
      sessionId,
    );
    assert.equal(resolved.object?.description, "button#click-button");
  });
});

test("AC-3: a closed connection rejects with the snapshot prefix", { skip }, async () => {
  await withRuntime(async ({ runtime, connection, sendCDP, server }) => {
    await openFixture(sendCDP, server.origin);
    await connection.close();
    await assert.rejects(
      () => runtime.snapshot({}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.startsWith("snapshot failed:"),
          `message was ${JSON.stringify(err.message)}`,
        );
        return true;
      },
    );
  });
});

/* ------------------------------------------------- no browser needed below */

test("assertAgentControl rejects untouched so the harness reads its code", async () => {
  const control = new Error("The user is currently in control of the browser.");
  control.error_code = "GRAZER_TASK_SPACE_USER_IN_CONTROL";
  const runtime = {
    assertAgentControl() {
      throw control;
    },
  };
  const connection = {
    isOpen: () => true,
    send: async () => ({ result: {} }),
    onEvent: () => () => {},
  };
  attachSnapshot(runtime, { connection });
  await assert.rejects(
    () => runtime.snapshot({}),
    (err) => {
      assert.equal(err, control, "the GrazerError is rethrown by identity");
      assert.equal(err.error_code, "GRAZER_TASK_SPACE_USER_IN_CONTROL");
      assert.ok(
        !err.message.startsWith("snapshot failed:"),
        "user-in-control must not be relabelled as a snapshot failure",
      );
      return true;
    },
  );
});

test("a runtime without assertAgentControl is snapshotted normally", async () => {
  const runtime = {};
  const connection = {
    isOpen: () => true,
    send: async (method) => {
      if (method === "Accessibility.getFullAXTree") {
        return {
          result: {
            nodes: [
              {
                nodeId: "1",
                role: { value: "RootWebArea" },
                childIds: ["2"],
                backendDOMNodeId: 1,
              },
              {
                nodeId: "2",
                role: { value: "button" },
                name: { value: "Go" },
                backendDOMNodeId: 9,
              },
            ],
          },
        };
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        return {
          result: {
            strings: ["http://host/", "only", "BUTTON"],
            documents: [
              {
                documentURL: 0,
                frameId: 1,
                nodes: { backendNodeId: [9], nodeName: [2], attributes: [[]] },
                layout: { nodeIndex: [], bounds: [] },
              },
            ],
          },
        };
      }
      return { result: {} };
    },
    onEvent: () => () => {},
  };
  attachSnapshot(runtime, { connection, currentSessionId: () => "session-1" });
  const result = await runtime.snapshot({});
  assert.ok(result.content.includes('- button "Go"'), result.content);
  assert.deepEqual(result.refs, [{ backendNodeId: 9, role: "button", name: "Go" }]);
});

test("detach removes the method and stops observing", async () => {
  let unsubscribed = false;
  const runtime = {};
  const connection = {
    isOpen: () => true,
    send: async () => ({ result: {} }),
    onEvent: () => () => {
      unsubscribed = true;
    },
  };
  const detach = attachSnapshot(runtime, { connection });
  assert.equal(typeof runtime.snapshot, "function");
  detach();
  assert.equal(runtime.snapshot, undefined);
  assert.equal(unsubscribed, true);
});

/* ------------------------------------------ AC-1: the REAL 02-01 runtime */

/**
 * Same live browser, but the runtime is the real one over a temp spaces home,
 * so `assertAgentControl` consults an actual store row rather than a stub.
 */
async function withRealRuntime(body) {
  const home = await mkdtemp(join(tmpdir(), "grazer-snapshot-home-"));
  const server = await startFixtureServer();
  const browser = await launchChromium(chromium);
  let connection;
  let detach;
  try {
    connection = await connect({ wsUrl: browser.endpoint });
    const runtime = createGrazerRuntime(connection, { spacesHome: home });
    detach = attachSnapshot(runtime, { connection });
    const sendCDP = harnessClient(runtime);
    return await body({ runtime, connection, sendCDP, server, home });
  } finally {
    detach?.();
    await connection?.close();
    await browser.kill();
    await server.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

/** Rewrite one field on the selected space's row, the way the CLI would. */
function patchRow(home, id, patch) {
  const store = readStore(home);
  Object.assign(findRow(store, id), patch);
  writeStore(home, store);
}

async function expectRejection(runtime, code) {
  await assert.rejects(
    () => runtime.snapshot({}),
    (err) => {
      assert.equal(
        err.error_code,
        code,
        `expected ${code}, got ${err.error_code}: ${err.message}`,
      );
      assert.ok(
        !err.message.startsWith("snapshot failed:"),
        `a control refusal must reach waitForAgentControl unwrapped, got ${JSON.stringify(err.message)}`,
      );
      return true;
    },
  );
}

test("AC-1: real runtime gates snapshot on space ownership and state", { skip }, async () => {
  await withRealRuntime(async ({ runtime, sendCDP, server, home }) => {
    const created = await runtime.createTaskSpace("snapshot-gating");
    assert.ok(created.id, `createTaskSpace failed: ${JSON.stringify(created)}`);
    assert.equal(runtime.selectedSpaceId(), created.id);

    // The page must live INSIDE the space: since Task 0 the adapter resolves
    // through the space-scoped `listTabs`, so a tab created in the default
    // browser context is deliberately invisible to it.
    await navigateSpaceTab(runtime, sendCDP, `${server.origin}/`);

    const first = await runtime.snapshot({ scope: "full_page" });
    assert.ok(first.refs.length > 0, "an agent-owned space snapshots normally");

    // handOff: the human has the wheel, though the space is still the agent's.
    const handed = await runtime.handOffTaskSpace();
    assert.ok(!handed.error, `handOffTaskSpace failed: ${JSON.stringify(handed)}`);
    await expectRejection(runtime, "GRAZER_TASK_SPACE_USER_IN_CONTROL");

    // Ended beats ownership: the task is over, not merely paused.
    patchRow(home, created.id, { state: "ended" });
    await expectRejection(runtime, "GRAZER_TASK_SPACE_INACTIVE");

    // takeOver restores agent control; the state has to come back too, since
    // the gate checks state before ownership.
    patchRow(home, created.id, { state: "active" });
    const taken = await runtime.takeOverTaskSpace();
    assert.ok(!taken.error, `takeOverTaskSpace failed: ${JSON.stringify(taken)}`);

    const restored = await runtime.snapshot({ scope: "full_page" });
    assert.ok(restored.content.includes("Helper e2e fixture"), restored.content);
    assert.ok(restored.refs.length > 0, "refs come back after takeOver");
  });
});

test("AC-1: with no space selected the gate never fires", { skip }, async () => {
  await withRealRuntime(async ({ runtime, sendCDP, server }) => {
    assert.equal(runtime.selectedSpaceId(), null);
    await openFixture(sendCDP, server.origin);
    const result = await runtime.snapshot({ scope: "full_page" });
    assert.ok(result.refs.length > 0, "no selection means Phase 1 behaviour");
  });
});

/* --------------------------------- Task 0: session re-validation on switch */

/**
 * Point the SELECTED space's own tab at `url` and wait for the navigation to
 * commit.
 *
 * A fresh space already owns one about:blank tab, so navigating it — rather
 * than calling createTab — leaves each space with exactly ONE tab. That keeps
 * the switch test about session re-validation instead of about which of two
 * candidate tabs gets picked, and it is the scenario as specified: space A on a
 * fixture page, space B on about:blank.
 *
 * The wait polls `listTabs` for the committed URL rather than sleeping a fixed
 * interval: `node --test` runs the suites as concurrent processes, and under
 * that load a fixed wait let an about:blank page through and produced an empty
 * snapshot — the very symptom this test exists to catch.
 */
async function navigateSpaceTab(runtime, sendCDP, url) {
  const { tabs = [] } = await runtime.listTabs();
  assert.equal(tabs.length, 1, `expected one tab in a fresh space: ${JSON.stringify(tabs)}`);
  const { targetId } = tabs[0];
  const { sessionId } = await sendCDP("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await sendCDP("Page.enable", {}, sessionId);
  await sendCDP("Page.navigate", { url }, sessionId);

  const deadline = Date.now() + 20_000;
  for (;;) {
    const listed = (await runtime.listTabs()).tabs ?? [];
    const tab = listed.find((candidate) => candidate.targetId === targetId);
    if (tab?.url.startsWith(url)) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`tab never navigated to ${url}: ${JSON.stringify(listed)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The AX tree lags the committed URL by a frame.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return targetId;
}

test(
  "Task 0: snapshot follows a space switch even as the first call after it",
  { skip },
  async () => {
    await withRealRuntime(async ({ runtime, sendCDP, server }) => {
      // Space A holds the fixture page; space B holds a blank one.
      const spaceA = await runtime.createTaskSpace("space-a");
      assert.ok(spaceA.id, `createTaskSpace A failed: ${JSON.stringify(spaceA)}`);
      await navigateSpaceTab(runtime, sendCDP, `${server.origin}/`);

      // Space B keeps the about:blank tab it was created with.
      const spaceB = await runtime.createTaskSpace("space-b");
      assert.ok(spaceB.id, `createTaskSpace B failed: ${JSON.stringify(spaceB)}`);

      // Select A and snapshot as the very FIRST call — no send in between to
      // refresh anything. This is the 02-02 repro.
      assert.deepEqual(await runtime.useTaskSpace(spaceA.id), {});
      const inA = await runtime.snapshot({ scope: "full_page" });
      assert.ok(
        inA.content.includes("Helper e2e fixture"),
        `space A should show the fixture, got:\n${inA.content}`,
      );

      // Switch to B and snapshot first thing: the remembered session belongs to
      // A's target, which is not in B's tab list, so it must be discarded.
      assert.deepEqual(await runtime.useTaskSpace(spaceB.id), {});
      const inB = await runtime.snapshot({ scope: "full_page" });
      assert.ok(
        !inB.content.includes("Helper e2e fixture"),
        `space B leaked space A's page:\n${inB.content}`,
      );

      // And back again.
      assert.deepEqual(await runtime.useTaskSpace(spaceA.id), {});
      const backInA = await runtime.snapshot({ scope: "full_page" });
      assert.ok(
        backInA.content.includes("Helper e2e fixture"),
        `space A did not come back, got:\n${backInA.content}`,
      );
      assert.ok(backInA.refs.length > 0, "refs come back with the page");
    });
  },
);

test("Task 0: an empty task space reports it rather than snapshotting nothing", async () => {
  const runtime = { listTabs: async () => ({ tabs: [] }) };
  const connection = {
    isOpen: () => true,
    send: async () => ({ result: {} }),
    onEvent: () => () => {},
  };
  attachSnapshot(runtime, { connection });
  await assert.rejects(
    () => runtime.snapshot({}),
    /^Error: snapshot failed: no page target in the selected task space$/,
  );
});

test("Task 0: a stale observed session is discarded, not reused", async () => {
  let attachCalls = 0;
  let listed = [{ targetId: "T-OLD", active: true }];
  const runtime = { listTabs: async () => ({ tabs: listed }) };
  const connection = {
    isOpen: () => true,
    send: async (method, params) => {
      if (method === "Target.attachToTarget") {
        attachCalls += 1;
        return { result: { sessionId: `S-${params.targetId}` } };
      }
      if (method === "Accessibility.getFullAXTree") {
        return { result: { nodes: [{ nodeId: "1", role: { value: "RootWebArea" } }] } };
      }
      if (method === "DOMSnapshot.captureSnapshot") {
        return {
          result: {
            strings: ["http://host/", "f"],
            documents: [
              {
                documentURL: 0,
                frameId: 1,
                nodes: { backendNodeId: [], nodeName: [], attributes: [] },
                layout: { nodeIndex: [], bounds: [] },
              },
            ],
          },
        };
      }
      return { result: {} };
    },
    onEvent: () => () => {},
  };
  attachSnapshot(runtime, { connection });

  await runtime.snapshot({});
  assert.equal(attachCalls, 1, "first call attaches");
  await runtime.snapshot({});
  assert.equal(attachCalls, 1, "a still-listed target is reused, not re-attached");

  // The space switched: the old target is gone from the list.
  listed = [{ targetId: "T-NEW", active: true }];
  await runtime.snapshot({});
  assert.equal(attachCalls, 2, "a target missing from listTabs forces a re-attach");
});
