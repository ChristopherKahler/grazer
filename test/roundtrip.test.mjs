/**
 * Transport round-trip tests.
 *
 * Two layers, both against the compiled output in dist/ (the same pattern the
 * harness's own tests use):
 *
 *   1. Fake connection — the contract in isolation: id passthrough, undefined
 *      return, verbatim events, and every local failure code.
 *   2. Real Chromium — the same contract end to end, including the sessionId
 *      passthrough that only a live browser can prove.
 *
 * The real-browser layer skips cleanly when no Chromium is installed.
 */

import assert from "node:assert/strict";
import test, { before } from "node:test";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

import {
  findChromium,
  makeProfileDir,
  removeProfileDir,
  waitFor,
} from "./support/chromium.mjs";

const { createGrazerRuntime } = await import("../dist/grazer/runtime.js");
const { CdpProtocolError, connect, productFromVersion } = await import(
  "../dist/cdp/connection.js"
);
const { launchChromium } = await import("../dist/cdp/launch.js");
const { attachToPage, findPageTargets } = await import(
  "../dist/cdp/session.js"
);

/** A settleable stand-in for a CdpConnection, so failure paths are reachable. */
function makeFakeConnection({ open = true } = {}) {
  const sent = [];
  const eventListeners = new Set();
  const closeListeners = new Set();
  const pending = new Map();
  const calls = [];
  let isOpen = open;
  // Canned answers for the runtime's own numbered requests (listTabs etc.),
  // keyed by CDP method. A method with no entry rejects.
  const canned = new Map();

  return {
    sent,
    calls,
    canned,
    connection: {
      isOpen: () => isOpen,
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
        sent.push(message);
        return new Promise((resolve, reject) => {
          pending.set(message.id, { resolve, reject });
        });
      },
      onEvent(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    },
    /** Settle a request with a success response frame. */
    respond(id, result, extra = {}) {
      pending.get(id)?.resolve({ id, result, ...extra });
      pending.delete(id);
    },
    /** Settle a request with a CDP protocol-error frame. */
    respondError(id, error) {
      pending.get(id)?.reject(new CdpProtocolError({ id, error }));
      pending.delete(id);
    },
    /** Reject a request with an arbitrary transport error. */
    failSend(id, error) {
      pending.get(id)?.reject(error);
      pending.delete(id);
    },
    emit(event) {
      for (const listener of eventListeners) listener(event);
    },
    drop() {
      isOpen = false;
      for (const listener of closeListeners) listener();
    },
    setOpen(value) {
      isOpen = value;
    },
    pendingCount: () => pending.size,
  };
}

const EVAL_PAYLOAD = (id, sessionId) =>
  JSON.stringify({
    id,
    method: "Runtime.evaluate",
    params: { expression: "1+1", returnByValue: true },
    ...(sessionId ? { sessionId } : {}),
  });

// ---------------------------------------------------------------------------
// AC-2 / AC-3 against a fake connection
// ---------------------------------------------------------------------------

test("AC-2 fake: response round-trips id-matched and sendCDPMessage returns undefined", async () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const received = [];
  runtime.onCDPMessage = (message) => received.push(JSON.parse(message));

  const returned = runtime.sendCDPMessage(EVAL_PAYLOAD(7, "SID-1"));
  assert.equal(returned, undefined, "sendCDPMessage must return undefined");

  assert.equal(fake.sent.length, 1);
  assert.deepEqual(fake.sent[0], {
    id: 7,
    method: "Runtime.evaluate",
    params: { expression: "1+1", returnByValue: true },
    sessionId: "SID-1",
  });

  assert.equal(received.length, 0, "delivery must not be synchronous");

  fake.respond(7, { result: { type: "number", value: 2 } }, { sessionId: "SID-1" });
  await waitFor(() => received.length === 1, { label: "response delivery" });

  assert.equal(received[0].id, 7);
  assert.equal(received[0].result.result.value, 2);
  assert.equal(received[0].sessionId, "SID-1");
});

test("AC-2 fake: sessionId is never injected, replaced, or stripped", async () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  runtime.onCDPMessage = () => {};

  runtime.sendCDPMessage(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} }));
  runtime.sendCDPMessage(EVAL_PAYLOAD(2, "SID-A"));
  runtime.sendCDPMessage(EVAL_PAYLOAD(3, "SID-B"));

  assert.equal(Object.hasOwn(fake.sent[0], "sessionId"), false, "no sessionId invented");
  assert.equal(fake.sent[1].sessionId, "SID-A");
  assert.equal(fake.sent[2].sessionId, "SID-B");
});

test("AC-2 fake: an id-less event is forwarded verbatim with sessionId at top level", async () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const received = [];
  runtime.onCDPMessage = (message) => received.push(JSON.parse(message));

  const event = {
    method: "Page.frameNavigated",
    params: { frame: { id: "F1", url: "about:blank" } },
    sessionId: "SID-1",
  };
  fake.emit(event);

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], event);
  assert.equal(Object.hasOwn(received[0], "id"), false, "an event must carry no id");
});

test("AC-2 fake: a CDP protocol error reaches onCDPMessage as a response frame", async () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const received = [];
  runtime.onCDPMessage = (message) => received.push(JSON.parse(message));

  runtime.sendCDPMessage(EVAL_PAYLOAD(11));
  fake.respondError(11, {
    code: -32601,
    message: "'Runtime.evaluate' wasn't found",
  });
  await waitFor(() => received.length === 1, { label: "error response delivery" });

  assert.equal(received[0].id, 11);
  assert.equal(received[0].error.code, -32601);
});

test("AC-3 fake: a closed socket fires GRAZER_CDP_CHANNEL_UNAVAILABLE", () => {
  const fake = makeFakeConnection({ open: false });
  const runtime = createGrazerRuntime(fake.connection);
  const errors = [];
  runtime.onSendCDPMessageError = (message, error_code) =>
    errors.push({ message, error_code });

  const returned = runtime.sendCDPMessage(EVAL_PAYLOAD(1));

  assert.equal(returned, undefined);
  assert.equal(fake.sent.length, 0, "nothing may be written to a closed socket");
  assert.deepEqual(errors, [
    {
      message: "CDP channel is not available.",
      error_code: "GRAZER_CDP_CHANNEL_UNAVAILABLE",
    },
  ]);
});

test("AC-3 fake: a drop with requests in flight fires GRAZER_TASK_HOST_DISCONNECTED once", () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const errors = [];
  runtime.onCDPMessage = () => {};
  runtime.onSendCDPMessageError = (message, error_code) =>
    errors.push({ message, error_code });

  runtime.sendCDPMessage(EVAL_PAYLOAD(1));
  runtime.sendCDPMessage(EVAL_PAYLOAD(2));
  assert.equal(runtime.stats().inFlight, 2);

  fake.drop();

  assert.deepEqual(errors, [
    {
      message: "CDP agent host is not available.",
      error_code: "GRAZER_TASK_HOST_DISCONNECTED",
    },
  ]);
});

test("AC-3 fake: a drop with nothing in flight reports nothing", () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const errors = [];
  runtime.onSendCDPMessageError = (...args) => errors.push(args);

  fake.drop();

  assert.deepEqual(errors, []);
});

test("AC-3 fake: a ws.send failure fires GRAZER_CDP_SEND_FAILED", async () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const errors = [];
  runtime.onCDPMessage = () => {};
  runtime.onSendCDPMessageError = (message, error_code) =>
    errors.push({ message, error_code });

  const { grazerErrorFor } = await import("../dist/grazer/errors.js");
  runtime.sendCDPMessage(EVAL_PAYLOAD(1));
  fake.failSend(1, grazerErrorFor("send-failed"));
  await waitFor(() => errors.length === 1, { label: "send-failed report" });

  assert.deepEqual(errors, [
    {
      message: "Failed to send CDP message.",
      error_code: "GRAZER_CDP_SEND_FAILED",
    },
  ]);
});

test("AC-3 fake: an invalid payload throws synchronously with GRAZER_INVALID_ARGUMENT", () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const errors = [];
  runtime.onSendCDPMessageError = (...args) => errors.push(args);

  for (const bad of ["not json", JSON.stringify({ id: 1 }), JSON.stringify([1, 2])]) {
    assert.throws(
      () => runtime.sendCDPMessage(bad),
      (error) => {
        assert.equal(error.error_code, "GRAZER_INVALID_ARGUMENT");
        assert.equal(error.message, "Invalid CDP message payload.");
        return true;
      },
      `payload should have been rejected: ${bad}`,
    );
  }
  assert.equal(fake.sent.length, 0);
  assert.deepEqual(errors, [], "a bad payload is this request's problem, not the task's");
});

test("events arriving before a callback is assigned are dropped and counted", () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);

  fake.emit({ method: "Page.loadEventFired", params: {} });
  assert.equal(runtime.stats().droppedEvents, 1);

  runtime.onCDPMessage = () => {};
  fake.emit({ method: "Page.loadEventFired", params: {} });
  assert.equal(runtime.stats().droppedEvents, 1, "no further drops once assigned");
});

// ---------------------------------------------------------------------------
// 01-02 Task 2: listTabs / createTab / getBrowserVersion against a fake
// ---------------------------------------------------------------------------

/** A Target.getTargets answer mixing real pages with a fresh profile's noise. */
const MIXED_TARGETS = {
  id: 1,
  result: {
    targetInfos: [
      { targetId: "SW-1", type: "service_worker", title: "sw", url: "chrome-extension://x", attached: false },
      { targetId: "PAGE-1", type: "page", title: "First", url: "https://one.test/", attached: false },
      { targetId: "UI-1", type: "browser_ui", title: "ui", url: "chrome://tab-strip", attached: false },
      { targetId: "PAGE-2", type: "page", title: "Second", url: "https://two.test/", attached: true },
      { targetId: "BG-1", type: "background_page", title: "bg", url: "chrome-extension://y", attached: false },
    ],
  },
};

test("listTabs keeps only page targets, in the harness's shape", async () => {
  const fake = makeFakeConnection();
  fake.canned.set("Target.getTargets", MIXED_TARGETS);
  const runtime = createGrazerRuntime(fake.connection);

  const result = await runtime.listTabs();

  assert.deepEqual(result, {
    tabs: [
      { targetId: "PAGE-1", title: "First", url: "https://one.test/", active: false, index: 0 },
      { targetId: "PAGE-2", title: "Second", url: "https://two.test/", active: true, index: 1 },
    ],
  });
  assert.equal(result.tabs.filter((tab) => tab.active).length, 1, "exactly one active tab");
});

test("listTabs falls back to the LAST page target, matching the harness", async () => {
  const fake = makeFakeConnection();
  fake.canned.set("Target.getTargets", MIXED_TARGETS);
  const runtime = createGrazerRuntime(fake.connection);

  // browser-runtime.ts:121-122 picks tabs[tabs.length - 1] when none is active,
  // so an unset pointer must resolve to the same tab the harness would choose.
  const { tabs } = await runtime.listTabs();
  assert.equal(tabs.at(-1).active, true);
  assert.equal(tabs.at(-1).targetId, "PAGE-2");
});

test("createTab returns { targetId } and flips which tab is active", async () => {
  const fake = makeFakeConnection();
  fake.canned.set("Target.getTargets", MIXED_TARGETS);
  fake.canned.set("Target.createTarget", { id: 2, result: { targetId: "PAGE-1" } });
  const runtime = createGrazerRuntime(fake.connection);

  const created = await runtime.createTab("https://one.test/");
  assert.deepEqual(created, { targetId: "PAGE-1" });
  assert.deepEqual(fake.calls.at(-1), {
    method: "Target.createTarget",
    params: { url: "https://one.test/" },
  });

  const { tabs } = await runtime.listTabs();
  assert.equal(tabs.find((tab) => tab.targetId === "PAGE-1").active, true);
  assert.equal(tabs.find((tab) => tab.targetId === "PAGE-2").active, false);
});

test("createTab defaults to about:blank", async () => {
  const fake = makeFakeConnection();
  fake.canned.set("Target.createTarget", { id: 1, result: { targetId: "NEW-1" } });
  const runtime = createGrazerRuntime(fake.connection);

  await runtime.createTab();
  assert.deepEqual(fake.calls.at(-1).params, { url: "about:blank" });
});

test("Target.activateTarget passing through sendCDPMessage moves the active tab", async () => {
  const fake = makeFakeConnection();
  fake.canned.set("Target.getTargets", MIXED_TARGETS);
  const runtime = createGrazerRuntime(fake.connection);
  runtime.onCDPMessage = () => {};

  runtime.sendCDPMessage(
    JSON.stringify({ id: 1, method: "Target.activateTarget", params: { targetId: "PAGE-1" } }),
  );

  const { tabs } = await runtime.listTabs();
  assert.equal(tabs.find((tab) => tab.targetId === "PAGE-1").active, true);
});

test("a destroyed active target clears the pointer and the fallback takes over", async () => {
  const fake = makeFakeConnection();
  fake.canned.set("Target.getTargets", MIXED_TARGETS);
  const runtime = createGrazerRuntime(fake.connection);
  runtime.onCDPMessage = () => {};

  runtime.sendCDPMessage(
    JSON.stringify({ id: 1, method: "Target.activateTarget", params: { targetId: "PAGE-1" } }),
  );
  fake.emit({ method: "Target.targetDestroyed", params: { targetId: "PAGE-1" } });

  const { tabs } = await runtime.listTabs();
  assert.equal(tabs.find((tab) => tab.targetId === "PAGE-2").active, true);
});

test("getBrowserVersion matches the update-notice shape", async () => {
  const fake = makeFakeConnection();
  fake.canned.set("Browser.getVersion", {
    id: 1,
    result: { product: "Chrome/152.0.7977.66", protocolVersion: "1.3" },
  });
  const runtime = createGrazerRuntime(fake.connection);

  assert.deepEqual(await runtime.getBrowserVersion(), {
    currentVersion: "Chrome/152.0.7977.66",
    updateAvailable: false,
  });
});

test("tab methods RESOLVE with { error, error_code } rather than rejecting", async () => {
  const fake = makeFakeConnection({ open: false });
  const runtime = createGrazerRuntime(fake.connection);

  // assertNoGrazerError reads `error` off a resolved object; a rejection would
  // escape it as a bare Error with no stable code.
  for (const call of [
    () => runtime.listTabs(),
    () => runtime.createTab("https://one.test/"),
    () => runtime.getBrowserVersion(),
  ]) {
    const result = await call();
    assert.equal(result.error, "CDP channel is not available.");
    assert.equal(result.error_code, "GRAZER_CDP_CHANNEL_UNAVAILABLE");
  }
});

test("tab methods are own enumerable properties, so exposeGrazerMethods finds them", () => {
  const fake = makeFakeConnection();
  const runtime = createGrazerRuntime(fake.connection);
  const keys = Object.keys(runtime);
  for (const name of ["listTabs", "createTab", "getBrowserVersion", "sendCDPMessage"]) {
    assert.ok(keys.includes(name), `${name} must be own+enumerable (index.ts exposeGrazerMethods)`);
  }
});

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-3 against a real Chromium
// ---------------------------------------------------------------------------

const executable = findChromium();

/**
 * Law 11: one browser-launching suite at a time, machine-wide.
 *
 * Held for the whole FILE rather than per test — releasing between this file's
 * own tests would let another suite interleave, which is exactly what the lock
 * exists to prevent.
 */
let suiteLock;
before(async () => {
  if (!executable) return;
  suiteLock = await acquireSuiteLock("roundtrip");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


test(
  "real Chromium: full transport round trip",
  { skip: executable ? false : "no Chromium found (set GRAZER_BROWSER)" },
  async (t) => {
    const userDataDir = await makeProfileDir("grazer-roundtrip-");
    let browser;
    let connection;

    t.after(async () => {
      await connection?.close().catch(() => {});
      browser?.kill();
      await removeProfileDir(userDataDir);
    });

    browser = await launchChromium({ executable, userDataDir, headless: true });
    assert.ok(browser.port > 0, "a dynamic debug port was written");

    connection = await connect({ port: browser.port });

    // AC-1: browser-level request resolves with the product string.
    const version = await connection.send("Browser.getVersion");
    const product = productFromVersion(version);
    assert.match(product, /^(Chrome|HeadlessChrome|Brave)\//, `product was ${product}`);

    // Page discovery filters out the component-extension targets a fresh
    // profile carries (service_worker / background_page / browser_ui).
    const pages = await waitFor(
      async () => {
        const found = await findPageTargets(connection);
        return found.length > 0 ? found : null;
      },
      { label: "a page target" },
    );
    assert.ok(pages.every((page) => page.type === "page"));

    const sessionId = await attachToPage(connection, pages[0].targetId);
    assert.ok(sessionId, "attachToTarget returned a sessionId");

    const runtime = createGrazerRuntime(connection);
    const received = [];
    runtime.onCDPMessage = (message) => received.push(JSON.parse(message));
    const sendErrors = [];
    runtime.onSendCDPMessageError = (message, error_code) =>
      sendErrors.push({ message, error_code });

    // AC-2: id-matched Runtime.evaluate through the runtime, sessionId in the
    // payload string. Without it Chrome answers -32601 (verified live).
    const returned = runtime.sendCDPMessage(EVAL_PAYLOAD(7, sessionId));
    assert.equal(returned, undefined, "sendCDPMessage must return undefined");

    const evaluated = await waitFor(
      () => received.find((frame) => frame.id === 7),
      { label: "Runtime.evaluate response id 7" },
    );
    assert.equal(evaluated.result.result.value, 2);

    // AC-2: an event reaches onCDPMessage verbatim with sessionId at top level.
    runtime.sendCDPMessage(
      JSON.stringify({ id: 8, method: "Page.enable", params: {}, sessionId }),
    );
    await waitFor(() => received.find((frame) => frame.id === 8), {
      label: "Page.enable response",
    });

    runtime.sendCDPMessage(
      JSON.stringify({
        id: 9,
        method: "Page.navigate",
        params: { url: "data:text/html,<title>grazer</title>" },
        sessionId,
      }),
    );
    const pageEvent = await waitFor(
      () =>
        received.find(
          (frame) => !Object.hasOwn(frame, "id") && String(frame.method).startsWith("Page."),
        ),
      { label: "a Page.* event" },
    );
    assert.equal(pageEvent.sessionId, sessionId, "sessionId sits at the top level");

    // AC-3: a request in flight when the browser dies reports host-disconnected
    // exactly once, and the connection's own pending promise rejects.
    const inFlight = connection
      .send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, sessionId)
      .then(
        () => ({ settled: "resolved" }),
        (error) => ({ settled: "rejected", error }),
      );
    runtime.sendCDPMessage(
      JSON.stringify({
        id: 10,
        method: "Runtime.evaluate",
        params: { expression: "new Promise(() => {})", awaitPromise: true },
        sessionId,
      }),
    );
    await waitFor(() => runtime.stats().inFlight === 1, { label: "a harness request in flight" });

    browser.kill();

    const outcome = await inFlight;
    assert.equal(outcome.settled, "rejected");
    assert.equal(outcome.error.error_code, "GRAZER_TASK_HOST_DISCONNECTED");

    await waitFor(() => sendErrors.length > 0, { label: "host-disconnected report" });
    assert.deepEqual(sendErrors, [
      {
        message: "CDP agent host is not available.",
        error_code: "GRAZER_TASK_HOST_DISCONNECTED",
      },
    ]);

    // AC-3: sending after the socket is gone is a channel-unavailable, and no
    // request is left pending.
    sendErrors.length = 0;
    await connection.close();
    runtime.sendCDPMessage(EVAL_PAYLOAD(11, sessionId));
    assert.deepEqual(sendErrors, [
      {
        message: "CDP channel is not available.",
        error_code: "GRAZER_CDP_CHANNEL_UNAVAILABLE",
      },
    ]);
    assert.equal(runtime.stats().inFlight, 0, "no request stays pending");
  },
);
