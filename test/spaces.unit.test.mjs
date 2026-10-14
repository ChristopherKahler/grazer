/**
 * Store and manager, against 01-01's fake connection and a temp GRAZER_HOME.
 *
 * No browser needed: everything here is either file bookkeeping or a CDP call
 * through the `CdpSend` seam.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanHome } from "./support/clean-home.mjs";

const {
  allocateId,
  browserEpoch,
  findRow,
  readStore,
  removeRow,
  upsertRow,
  writeStore,
} = await import("../dist/spaces/store.js");
const {
  createSpace,
  disposeSpace,
  listSpaces,
  toView,
  transition,
} = await import("../dist/spaces/manager.js");
const { createGrazerRuntime } = await import("../dist/grazer/runtime.js");

async function makeHome(epoch = "2026-09-03T12:00:00.000Z") {
  const home = await mkdtemp(join(tmpdir(), "grazer-spaces-"));
  if (epoch !== null) {
    await writeFile(
      join(home, "browser.json"),
      JSON.stringify({ port: 1234, pid: 1, startedAt: epoch }),
      "utf8",
    );
  }
  return home;
}

/** A CdpSend fake with canned answers, mirroring the one in roundtrip.test.mjs. */
function makeFakeConnection() {
  const calls = [];
  const canned = new Map();
  const raw = [];
  return {
    calls,
    canned,
    raw,
    connection: {
      isOpen: () => true,
      send(method, params = {}) {
        calls.push({ method, params });
        if (!canned.has(method)) {
          return Promise.reject(new Error(`no canned response for ${method}`));
        }
        const answer = canned.get(method);
        return typeof answer === "function"
          ? Promise.resolve().then(() => answer(params))
          : Promise.resolve(answer);
      },
      sendRaw(message) {
        raw.push(message);
        // Never settles: these tests care about what was written, not the reply.
        return new Promise(() => {});
      },
      onEvent: () => () => {},
      onClose: () => () => {},
    },
  };
}

function row(overrides = {}) {
  return {
    id: 1,
    taskId: "1",
    name: "one",
    browserContextId: "CTX-1",
    ownership: "agent",
    state: "active",
    createdBy: "agent",
    createdAt: "2026-09-03T12:00:00.000Z",
    ...overrides,
  };
}

// --- store ------------------------------------------------------------------

test("a missing store reads as empty at the current browser epoch", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const store = readStore(home);
  assert.deepEqual(store, {
    browserStartedAt: "2026-09-03T12:00:00.000Z",
    nextId: 1,
    spaces: [],
  });
});

test("browserEpoch reads startedAt from browser.json, else empty", async (t) => {
  const home = await makeHome("EPOCH-A");
  const bare = await makeHome(null);
  t.after(() => cleanHome(home));
  t.after(() => cleanHome(bare));

  assert.equal(browserEpoch(home), "EPOCH-A");
  assert.equal(browserEpoch(bare), "");
});

test("a store written under a previous browser is discarded", async (t) => {
  const home = await makeHome("EPOCH-A");
  t.after(() => cleanHome(home));

  const store = readStore(home);
  upsertRow(store, row());
  writeStore(home, store);
  assert.equal(readStore(home).spaces.length, 1, "same epoch keeps the row");

  // The browser restarted: every browserContextId in the file is now dead.
  await writeFile(
    join(home, "browser.json"),
    JSON.stringify({ port: 1234, pid: 2, startedAt: "EPOCH-B" }),
    "utf8",
  );
  const fresh = readStore(home);
  assert.deepEqual(fresh.spaces, []);
  assert.equal(fresh.browserStartedAt, "EPOCH-B");
  assert.equal(fresh.nextId, 1);
});

test("a corrupt store reads as empty rather than throwing", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  await writeFile(join(home, "spaces.json"), "{not json", "utf8");
  assert.deepEqual(readStore(home).spaces, []);
});

test("ids are monotonic and never reused after a close", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const store = readStore(home);
  const first = allocateId(store);
  const second = allocateId(store);
  assert.equal(first, 1);
  assert.equal(second, 2);

  upsertRow(store, row({ id: second, taskId: "2" }));
  removeRow(store, second);
  // A heredoc still running may hold id 2; handing it to a new space would
  // silently redirect that process's commands.
  assert.equal(allocateId(store), 3, "a freed id is never handed out again");
});

test("writeStore is atomic and leaves no temp file", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const store = readStore(home);
  upsertRow(store, row());
  writeStore(home, store);

  const path = join(home, "spaces.json");
  assert.ok(existsSync(path));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).spaces[0].name, "one");
  assert.ok(!existsSync(`${path}.${process.pid}.tmp`), "temp file was renamed away");
});

test("findRow resolves by numeric id, name, taskId, and numeric string", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const store = readStore(home);
  upsertRow(store, row({ id: 7, taskId: "7", name: "seven" }));

  assert.equal(findRow(store, 7)?.id, 7);
  assert.equal(findRow(store, "seven")?.id, 7);
  assert.equal(findRow(store, "7")?.id, 7, "the harness passes String(id) too");
  assert.equal(findRow(store, "nope"), undefined);
  assert.equal(findRow(store, 99), undefined);
});

test("upsertRow replaces in place rather than appending a duplicate", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const store = readStore(home);
  upsertRow(store, row());
  upsertRow(store, row({ name: "renamed" }));
  assert.equal(store.spaces.length, 1);
  assert.equal(store.spaces[0].name, "renamed");
});

// --- manager ----------------------------------------------------------------

test("createSpace makes a context, opens its first tab, and records the row", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const fake = makeFakeConnection();
  fake.canned.set("Target.createBrowserContext", {
    id: 1,
    result: { browserContextId: "CTX-A" },
  });
  fake.canned.set("Target.createTarget", { id: 2, result: { targetId: "T-A" } });

  const store = readStore(home);
  const created = await createSpace(fake.connection, store, "alpha");

  assert.equal(created.id, 1);
  assert.equal(created.taskId, "1", "taskId is String(id)");
  assert.equal(created.name, "alpha");
  assert.equal(created.ownership, "agent");
  assert.equal(created.state, "active");
  assert.equal(created.browserContextId, "CTX-A");

  // disposeOnDetach:false keeps the context alive across heredoc processes, and
  // newWindow:true gives a headed user one window per space.
  assert.deepEqual(fake.calls[0], {
    method: "Target.createBrowserContext",
    params: { disposeOnDetach: false },
  });
  assert.deepEqual(fake.calls[1], {
    method: "Target.createTarget",
    params: { url: "about:blank", browserContextId: "CTX-A", newWindow: true },
  });
  assert.equal(store.spaces.length, 1);
});

test("listSpaces joins rows with live tab titles", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const fake = makeFakeConnection();
  fake.canned.set("Target.getBrowserContexts", {
    id: 1,
    result: { browserContextIds: ["CTX-A", "CTX-B"] },
  });
  fake.canned.set("Target.getTargets", {
    id: 2,
    result: {
      targetInfos: [
        { targetId: "T1", type: "page", title: "Alpha one", url: "https://a/", browserContextId: "CTX-A" },
        { targetId: "T2", type: "page", title: "Beta one", url: "https://b/", browserContextId: "CTX-B" },
        { targetId: "T3", type: "page", title: "Beta two", url: "https://b2/", browserContextId: "CTX-B" },
        { targetId: "SW", type: "service_worker", title: "sw", url: "x", browserContextId: "CTX-B" },
      ],
    },
  });

  const store = readStore(home);
  upsertRow(store, row({ id: 1, taskId: "1", name: "alpha", browserContextId: "CTX-A" }));
  upsertRow(store, row({ id: 2, taskId: "2", name: "beta", browserContextId: "CTX-B" }));

  const { views, pruned } = await listSpaces(fake.connection, store);
  assert.equal(pruned, false);
  assert.deepEqual(views.map((view) => view.recentTabTitles), [
    ["Alpha one"],
    ["Beta one", "Beta two"],
  ]);
  assert.equal(typeof views[0].id, "number", "the harness requires numeric ids");
  assert.equal(views[0].taskId, "1");
});

test("listSpaces drops rows whose context is gone", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const fake = makeFakeConnection();
  fake.canned.set("Target.getBrowserContexts", {
    id: 1,
    result: { browserContextIds: ["CTX-A"] },
  });
  fake.canned.set("Target.getTargets", { id: 2, result: { targetInfos: [] } });

  const store = readStore(home);
  upsertRow(store, row({ id: 1, browserContextId: "CTX-A" }));
  upsertRow(store, row({ id: 2, taskId: "2", name: "gone", browserContextId: "CTX-DEAD" }));

  const { views, pruned } = await listSpaces(fake.connection, store);
  assert.equal(pruned, true);
  assert.deepEqual(views.map((view) => view.id), [1]);
});

test("listSpaces prunes nothing when the context query fails", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const fake = makeFakeConnection();
  // No canned Target.getBrowserContexts: the call rejects.
  fake.canned.set("Target.getTargets", { id: 2, result: { targetInfos: [] } });

  const store = readStore(home);
  upsertRow(store, row({ id: 1, browserContextId: "CTX-A" }));

  const { views, pruned } = await listSpaces(fake.connection, store);
  // "I could not ask" must never be read as "there are none".
  assert.equal(pruned, false);
  assert.deepEqual(views.map((view) => view.id), [1]);
});

test("disposeSpace disposes the context and removes the row", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const fake = makeFakeConnection();
  fake.canned.set("Target.disposeBrowserContext", { id: 1, result: {} });

  const store = readStore(home);
  upsertRow(store, row({ id: 4, taskId: "4", browserContextId: "CTX-D" }));

  assert.equal(await disposeSpace(fake.connection, store, 4), true);
  assert.deepEqual(fake.calls.at(-1), {
    method: "Target.disposeBrowserContext",
    params: { browserContextId: "CTX-D" },
  });
  assert.deepEqual(store.spaces, []);
  assert.equal(await disposeSpace(fake.connection, store, 4), false, "already gone");
});

test("disposeSpace still removes the row when the context is already gone", async (t) => {
  const home = await makeHome();
  t.after(() => cleanHome(home));

  const fake = makeFakeConnection();
  // No canned answer: disposeBrowserContext rejects, as it does for a context
  // the user already closed.
  const store = readStore(home);
  upsertRow(store, row({ id: 5, taskId: "5", browserContextId: "CTX-E" }));

  assert.equal(await disposeSpace(fake.connection, store, 5), true);
  assert.deepEqual(store.spaces, [], "a failed dispose must not strand the row");
});

test("transition implements the harness's ownership table", () => {
  assert.equal(transition(row(), "handOff").ownership, "agentDelegatedToUser");
  assert.equal(
    transition(row({ ownership: "agentDelegatedToUser" }), "takeOver").ownership,
    "agent",
  );

  const completed = transition(row(), "complete");
  assert.equal(completed.ownership, "agentDelegatedToUser");
  assert.equal(completed.state, "completed", "the page stays for the user");

  assert.equal(transition(row({ ownership: "user" }), "claim").ownership, "agent");
  assert.equal(
    transition(row({ ownership: "agent" }), "claim").ownership,
    "agent",
    "claim is idempotent on an already-agent space",
  );

  const revived = transition(row({ ownership: "user", state: "ended" }), "claim");
  assert.equal(revived.state, "active", "claiming an ended space revives it");

  assert.equal(transition(row(), "userTakeover").ownership, "user");

  const ended = transition(row(), "end");
  assert.equal(ended.ownership, "user");
  assert.equal(ended.state, "ended");
});

test("toView emits exactly the fields the harness normalizes", () => {
  const view = toView(row({ id: 3, taskId: "3", name: "three" }), ["Tab"]);
  assert.deepEqual(view, {
    taskId: "3",
    id: 3,
    name: "three",
    createdBy: "agent",
    ownership: "agent",
    state: "active",
    recentTabTitles: ["Tab"],
  });
});

// --- runtime: selection, gating, scoping ------------------------------------

const PAGE_PAYLOAD = (id = 1) =>
  JSON.stringify({
    id,
    method: "Runtime.evaluate",
    params: { expression: "1+1" },
    sessionId: "SID",
  });

/** A runtime over a temp home whose store already holds `rows`. */
async function runtimeWithRows(rows, epoch = "EPOCH-A") {
  const home = await makeHome(epoch);
  const store = readStore(home);
  for (const candidate of rows) upsertRow(store, candidate);
  store.nextId = rows.length + 1;
  writeStore(home, store);
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection, { spacesHome: home });
  const errors = [];
  runtime.onCDPMessage = () => {};
  runtime.onSendCDPMessageError = (message, error_code) =>
    errors.push({ message, error_code });
  return { home, fake, runtime, errors };
}

test("with no space selected, Phase 1 behaviour is untouched", async (t) => {
  const { home, fake, runtime, errors } = await runtimeWithRows([
    row({ ownership: "user", state: "ended" }),
  ]);
  t.after(() => cleanHome(home));

  // A user-owned, ended space exists — but nothing selected it, so the gate
  // must not fire. This is what keeps 01-02's suites and the bridge smoke green.
  runtime.sendCDPMessage(PAGE_PAYLOAD());

  assert.deepEqual(errors, []);
  assert.equal(fake.raw.length, 1, "the message went to the browser");
  assert.equal(runtime.selectedSpaceId(), null);
});

test("the gate reports the right code for each ownership and state", async (t) => {
  const cases = [
    { row: row({ ownership: "agent", state: "active" }), code: null },
    {
      row: row({ ownership: "agentDelegatedToUser", state: "active" }),
      code: "GRAZER_TASK_SPACE_USER_IN_CONTROL",
    },
    {
      row: row({ ownership: "user", state: "active" }),
      code: "GRAZER_TASK_SPACE_USER_IN_CONTROL",
    },
    {
      // state wins over ownership: an ended task is not merely paused.
      row: row({ ownership: "user", state: "ended" }),
      code: "GRAZER_TASK_SPACE_INACTIVE",
    },
    {
      row: row({ ownership: "agent", state: "completed" }),
      code: null,
    },
  ];

  for (const testCase of cases) {
    const { home, fake, runtime, errors } = await runtimeWithRows([testCase.row]);
    t.after(() => cleanHome(home));

    // Selection refuses on the same precedence the gate uses — state before
    // ownership — so where it refuses, claim first and restore the row after.
    const selectionRefusal =
      testCase.row.state === "ended"
        ? "GRAZER_TASK_SPACE_INACTIVE"
        : testCase.row.ownership === "user"
          ? "GRAZER_TASK_SPACE_USER_IN_CONTROL"
          : null;

    const used = await runtime.useTaskSpace(1);
    if (selectionRefusal) {
      assert.equal(used.error_code, selectionRefusal);
      await runtime.claimTaskSpace(1);
      const store = readStore(home);
      const stored = findRow(store, 1);
      stored.ownership = testCase.row.ownership;
      stored.state = testCase.row.state;
      writeStore(home, store);
    } else {
      assert.deepEqual(used, {}, "selecting an agent-owned space succeeds");
    }

    errors.length = 0;
    fake.raw.length = 0;
    runtime.sendCDPMessage(PAGE_PAYLOAD());

    if (testCase.code === null) {
      assert.deepEqual(errors, [], `${testCase.row.ownership}/${testCase.row.state} should pass`);
      assert.equal(fake.raw.length, 1);
    } else {
      assert.equal(errors.length, 1, `${testCase.row.ownership}/${testCase.row.state}`);
      assert.equal(errors[0].error_code, testCase.code);
      assert.equal(fake.raw.length, 0, "nothing reached the browser");
    }
  }
});

test("useTaskSpace refuses on state before ownership", async (t) => {
  // An ended task and a paused one need different guidance and different
  // recovery — INACTIVE tells the agent to claim(), USER_IN_CONTROL tells it to
  // wait — so selection uses the same precedence as the send gate.
  const cases = [
    { row: row({ ownership: "user", state: "ended" }), code: "GRAZER_TASK_SPACE_INACTIVE" },
    { row: row({ ownership: "agent", state: "ended" }), code: "GRAZER_TASK_SPACE_INACTIVE" },
    { row: row({ ownership: "user", state: "active" }), code: "GRAZER_TASK_SPACE_USER_IN_CONTROL" },
    { row: row({ ownership: "agentDelegatedToUser", state: "active" }), code: null },
    { row: row({ ownership: "agent", state: "completed" }), code: null },
  ];

  for (const testCase of cases) {
    const { home, runtime } = await runtimeWithRows([testCase.row]);
    t.after(() => cleanHome(home));

    const result = await runtime.useTaskSpace(1);
    const label = `${testCase.row.ownership}/${testCase.row.state}`;
    if (testCase.code === null) {
      assert.deepEqual(result, {}, `${label} should select`);
      assert.equal(runtime.selectedSpaceId(), 1);
    } else {
      assert.equal(result.error_code, testCase.code, label);
      assert.equal(runtime.selectedSpaceId(), null, `${label} must not select`);
    }
  }
});

test("browser-level methods are never gated", async (t) => {
  const { home, fake, runtime, errors } = await runtimeWithRows([
    row({ ownership: "user" }),
  ]);
  t.after(() => cleanHome(home));

  await runtime.claimTaskSpace(1);
  const store = readStore(home);
  findRow(store, 1).ownership = "user";
  writeStore(home, store);

  // ensureSession() needs these to reach a target at all; gating them would
  // replace the guidance with a 15s timeout.
  for (const method of ["Target.getTargets", "Target.attachToTarget", "Browser.getVersion"]) {
    runtime.sendCDPMessage(JSON.stringify({ id: 1, method, params: {} }));
  }
  assert.deepEqual(errors, []);
  assert.equal(fake.raw.length, 3);
});

test("the gate re-reads the store, so a takeover lands mid-process", async (t) => {
  const { home, fake, runtime, errors } = await runtimeWithRows([row()]);
  t.after(() => cleanHome(home));

  await runtime.useTaskSpace(1);
  runtime.sendCDPMessage(PAGE_PAYLOAD(1));
  assert.equal(fake.raw.length, 1, "agent-owned: passes");

  // The human runs `grazer space takeover` in another process.
  const store = readStore(home);
  findRow(store, 1).ownership = "user";
  writeStore(home, store);

  runtime.sendCDPMessage(PAGE_PAYLOAD(2));
  assert.equal(fake.raw.length, 1, "no further message reached the browser");
  assert.equal(errors.at(-1).error_code, "GRAZER_TASK_SPACE_USER_IN_CONTROL");
});

test("assertAgentControl throws a coded error, which is how waitForAgentControl works", async (t) => {
  const { home, runtime } = await runtimeWithRows([row()]);
  t.after(() => cleanHome(home));

  await runtime.useTaskSpace(1);
  assert.doesNotThrow(() => runtime.assertAgentControl());

  const store = readStore(home);
  findRow(store, 1).ownership = "agentDelegatedToUser";
  writeStore(home, store);

  assert.throws(
    () => runtime.assertAgentControl(),
    (error) => {
      assert.equal(error.error_code, "GRAZER_TASK_SPACE_USER_IN_CONTROL");
      return true;
    },
  );
});

test("listTabs and createTab are scoped to the selected space's context", async (t) => {
  const { home, fake, runtime } = await runtimeWithRows([
    row({ id: 1, taskId: "1", name: "alpha", browserContextId: "CTX-A" }),
    row({ id: 2, taskId: "2", name: "beta", browserContextId: "CTX-B" }),
  ]);
  t.after(() => cleanHome(home));

  fake.canned.set("Target.getTargets", {
    id: 1,
    result: {
      targetInfos: [
        { targetId: "A1", type: "page", title: "A one", url: "https://a/", browserContextId: "CTX-A" },
        { targetId: "B1", type: "page", title: "B one", url: "https://b1/", browserContextId: "CTX-B" },
        { targetId: "B2", type: "page", title: "B two", url: "https://b2/", browserContextId: "CTX-B" },
        { targetId: "D1", type: "page", title: "default", url: "https://d/" },
      ],
    },
  });
  fake.canned.set("Target.createTarget", { id: 2, result: { targetId: "NEW" } });

  await runtime.useTaskSpace(1);
  const alpha = await runtime.listTabs();
  assert.deepEqual(alpha.tabs.map((tab) => tab.targetId), ["A1"]);
  assert.equal(alpha.tabs[0].active, true, "the only tab is the active one");

  await runtime.createTab("https://a/new");
  assert.deepEqual(fake.calls.at(-1).params, {
    url: "https://a/new",
    browserContextId: "CTX-A",
  });

  await runtime.useTaskSpace(2);
  const beta = await runtime.listTabs();
  assert.deepEqual(beta.tabs.map((tab) => tab.targetId), ["B1", "B2"]);
  assert.equal(beta.tabs.filter((tab) => tab.active).length, 1);
});

test("createTab refuses while the user holds the space", async (t) => {
  const { home, fake, runtime } = await runtimeWithRows([row()]);
  t.after(() => cleanHome(home));

  await runtime.useTaskSpace(1);
  const store = readStore(home);
  findRow(store, 1).ownership = "agentDelegatedToUser";
  writeStore(home, store);

  const result = await runtime.createTab("https://a/");
  assert.equal(result.error_code, "GRAZER_TASK_SPACE_USER_IN_CONTROL");
  assert.equal(
    fake.calls.filter((call) => call.method === "Target.createTarget").length,
    0,
  );
});

test("space methods resolve error objects and never reject", async (t) => {
  const { home, runtime } = await runtimeWithRows([]);
  t.after(() => cleanHome(home));

  // assertNoGrazerError reads `error` off a RESOLVED object; a rejection would
  // escape it as a bare Error with no stable code.
  assert.deepEqual(await runtime.useTaskSpace(99), {
    error: "Task space not found",
    error_code: "GRAZER_TASK_SPACE_NOT_FOUND",
  });
  assert.deepEqual(await runtime.closeTaskSpace(), {
    error: "Task space not selected",
    error_code: "GRAZER_TASK_SPACE_NOT_SELECTED",
  });
  assert.deepEqual(await runtime.handOffTaskSpace(), {
    error: "Task space not selected",
    error_code: "GRAZER_TASK_SPACE_NOT_SELECTED",
  });
  assert.deepEqual(await runtime.setAgentTaskState("x"), {
    error: "Task space not selected",
    error_code: "GRAZER_TASK_SPACE_NOT_SELECTED",
  });
  assert.deepEqual(await runtime.listProfiles(), { profiles: [] });
  assert.deepEqual(await runtime.animationHighlightMouseToPosition(), {});
});

test("createTaskSpace refuses a duplicate name, as the harness's double does", async (t) => {
  const { home, fake, runtime } = await runtimeWithRows([
    row({ name: "alpha" }),
  ]);
  t.after(() => cleanHome(home));

  fake.canned.set("Target.createBrowserContext", {
    id: 1,
    result: { browserContextId: "CTX-NEW" },
  });
  fake.canned.set("Target.createTarget", { id: 2, result: { targetId: "T" } });

  const duplicate = await runtime.createTaskSpace("alpha");
  assert.match(duplicate.error, /already exists/);

  const created = await runtime.createTaskSpace("beta");
  assert.equal(created.name, "beta");
  assert.equal(created.ownership, "agent");
  assert.equal(runtime.selectedSpaceId(), created.id, "creating selects it");
});

test("closeTaskSpace disposes the context, clears the selection, and re-gates", async (t) => {
  const { home, fake, runtime, errors } = await runtimeWithRows([row()]);
  t.after(() => cleanHome(home));

  fake.canned.set("Target.disposeBrowserContext", { id: 1, result: {} });

  await runtime.useTaskSpace(1);
  assert.deepEqual(await runtime.closeTaskSpace(), {});
  assert.equal(runtime.selectedSpaceId(), null);
  assert.deepEqual(readStore(home).spaces, []);

  // With the selection cleared the gate is inert again.
  errors.length = 0;
  runtime.sendCDPMessage(PAGE_PAYLOAD());
  assert.deepEqual(errors, []);
});

test("all space methods are own enumerable properties for exposeGrazerMethods", async (t) => {
  const { home, runtime } = await runtimeWithRows([]);
  t.after(() => cleanHome(home));

  const keys = Object.keys(runtime);
  for (const name of [
    "listTaskSpaces",
    "createTaskSpace",
    "claimTaskSpace",
    "useTaskSpace",
    "handOffTaskSpace",
    "takeOverTaskSpace",
    "completeTaskSpace",
    "closeTaskSpace",
    "markTaskSpaceError",
    "setAgentTaskState",
    "deleteSpaces",
    "listProfiles",
  ]) {
    assert.ok(keys.includes(name), `${name} must be own+enumerable`);
  }
});

// --- runtime: browser-context scoping ---------------------------------------
//
// A task space is its own browser context. Several browser-level CDP methods
// take an optional `browserContextId` and quietly act on the DEFAULT context
// when it is omitted — which the harness always does, having no notion of
// spaces. Left alone, "allow downloads to this directory" configured the wrong
// context and Chrome cancelled every download inside a space.

/** The methods that must inherit the selected space's context. */
const CONTEXT_SCOPED = [
  "Browser.setDownloadBehavior",
  "Browser.cancelDownload",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
];

for (const method of CONTEXT_SCOPED) {
  test(`${method} inherits the selected space's browser context`, async (t) => {
    const { home, fake, runtime, errors } = await runtimeWithRows([
      row({ browserContextId: "CTX-SPACE" }),
    ]);
    t.after(() => cleanHome(home));
    await runtime.useTaskSpace(1);

    runtime.sendCDPMessage(JSON.stringify({ id: 7, method, params: { some: "value" } }));

    assert.deepEqual(errors, []);
    assert.equal(fake.raw.length, 1);
    assert.equal(fake.raw[0].method, method);
    assert.equal(fake.raw[0].params.browserContextId, "CTX-SPACE");
    assert.equal(fake.raw[0].params.some, "value", "the caller's own params survive");
    assert.equal(fake.raw[0].sessionId, undefined, "sessionId is never invented");
  });

  test(`${method} keeps a browserContextId the caller supplied`, async (t) => {
    const { home, fake, runtime } = await runtimeWithRows([
      row({ browserContextId: "CTX-SPACE" }),
    ]);
    t.after(() => cleanHome(home));
    await runtime.useTaskSpace(1);

    runtime.sendCDPMessage(
      JSON.stringify({ id: 8, method, params: { browserContextId: "CTX-CALLER" } }),
    );

    assert.equal(
      fake.raw[0].params.browserContextId,
      "CTX-CALLER",
      "naming a context means meaning it",
    );
  });
}

test("context scoping does nothing when no space is selected", async (t) => {
  const { home, fake, runtime } = await runtimeWithRows([row()]);
  t.after(() => cleanHome(home));

  runtime.sendCDPMessage(
    JSON.stringify({ id: 9, method: "Browser.setDownloadBehavior", params: { behavior: "allow" } }),
  );

  assert.equal(fake.raw.length, 1);
  assert.equal(
    fake.raw[0].params.browserContextId,
    undefined,
    "Phase 1 behaviour is untouched without a space",
  );
});

test("methods outside the table are passed through untouched", async (t) => {
  const { home, fake, runtime } = await runtimeWithRows([
    row({ browserContextId: "CTX-SPACE" }),
  ]);
  t.after(() => cleanHome(home));
  await runtime.useTaskSpace(1);

  // Target.* reaches sessions and must never be rewritten, and a page-level
  // method carries a sessionId the runtime is forbidden to touch.
  for (const [id, method, params] of [
    [10, "Target.getTargets", {}],
    [11, "Target.createTarget", { url: "about:blank" }],
    [12, "Browser.getVersion", {}],
    [13, "Storage.clearDataForOrigin", { origin: "https://example.com" }],
  ]) {
    runtime.sendCDPMessage(JSON.stringify({ id, method, params }));
  }

  for (const frame of fake.raw) {
    assert.equal(
      frame.params.browserContextId,
      undefined,
      `${frame.method} must not be rewritten`,
    );
  }
});
