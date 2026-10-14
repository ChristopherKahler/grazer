/**
 * AC-3: the same assertions the unit tests make against committed fixtures,
 * re-run against a live headless Chromium over real CDP.
 *
 * Skips cleanly when no Chromium is installed, and kills whatever it launched
 * in a finally block so a failing assertion never leaves a browser behind.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { snapshot } from "../dist/snapshot/index.js";
import { acquireSuiteLock } from "./support/suite-lock.mjs";
import {
  connectCdp,
  findChromium,
  launchChromium,
  openPage,
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
  suiteLock = await acquireSuiteLock("snapshot.live");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


/** Bring up server + browser + page, run `body`, tear everything down. */
async function withLivePage(body) {
  const server = await startFixtureServer();
  const browser = await launchChromium(chromium);
  let client;
  try {
    client = await connectCdp(browser.endpoint);
    const { sessionId } = await openPage(client, `${server.origin}/`);
    const send = (method, params, session) =>
      client.send(method, params ?? {}, session ?? sessionId);
    return await body({ send, sessionId, client, origin: server.origin });
  } finally {
    client?.close();
    await browser.kill();
    await server.close();
  }
}

const lines = (content) => content.split("\n");
const lineMatching = (content, pattern) => lines(content).find((l) => pattern.test(l));

test("AC-3: full_page snapshot holds AC-2's assertions live", { skip }, async () => {
  await withLivePage(async ({ send, sessionId, origin }) => {
    const { content, refs } = await snapshot(send, sessionId, { scope: "full_page" });

    assert.ok(
      lineMatching(content, /^- heading "Helper e2e fixture" \[ref=\d+/),
      `no heading line in:\n${content}`,
    );

    const button = lineMatching(
      content,
      /^\s*- button "Click counter" \[ref=\d+, loc=css:#click-button\]/,
    );
    assert.ok(button, `no click-button line in:\n${content}`);

    const link = lineMatching(content, /^\s*- link "Nav target" \[ref=\d+, /);
    assert.ok(link, `no link line in:\n${content}`);
    assert.match(link, /loc=href:\/nav-target/);
    assert.match(link, new RegExp(`url=${origin}/nav-target\\]`));

    const buttonRef = refs.find(
      (ref) => ref.role === "button" && ref.name === "Click counter",
    );
    assert.ok(buttonRef, "refs carry the button");
    assert.match(button, new RegExp(`\\[ref=${buttonRef.backendNodeId},`));

    const duplicates = lines(content).filter((l) => l.includes('"Duplicate action"'));
    assert.equal(duplicates.length, 2);
    for (const line of duplicates) {
      assert.match(line, /\[ref=\d+\]/);
      assert.doesNotMatch(line, /loc=/);
    }

    assert.ok(lineMatching(content, /- text: Helper e2e fixture$/), "text lines render");
    for (const line of lines(content)) {
      assert.doesNotMatch(line, /^\s*- (generic|none|presentation)\b/, line);
    }
    assert.ok(!content.includes("Hidden content"), "display:none stays out");
  });
});

test("AC-3: option toggles behave live", { skip }, async () => {
  await withLivePage(async ({ send, sessionId }) => {
    const noMarks = await snapshot(send, sessionId, { includeActionMarks: false });
    assert.ok(!noMarks.content.includes("[ref="));
    assert.ok(noMarks.refs.length > 0, "refs stay populated without marks");

    const flat = await snapshot(send, sessionId, { interactiveOnly: true });
    for (const line of lines(flat.content)) {
      assert.match(line, /^- \S+ .*\[ref=\d+/, line);
    }
    assert.ok(flat.content.includes('- button "Click counter"'));

    const short = await snapshot(send, sessionId, { maxResultLength: 200 });
    assert.ok(short.content.length <= 240, `content was ${short.content.length} chars`);
    assert.match(lines(short.content).at(-1), /^\[truncated: \d+ of \d+ chars\]$/);
  });
});

test("AC-3: viewport scope excludes the far-below node", { skip }, async () => {
  await withLivePage(async ({ send, sessionId }) => {
    const full = await snapshot(send, sessionId, { scope: "full_page" });
    assert.ok(full.content.includes("Far below"), "full_page includes it");

    const clipped = await snapshot(send, sessionId, { scope: "only_within_viewport" });
    assert.ok(
      !clipped.content.includes("Far below"),
      `far-below survived viewport scope:\n${clipped.content}`,
    );
    assert.ok(clipped.content.includes("Helper e2e fixture"));
  });
});

test("AC-3: a ref resolves through DOM.resolveNode", { skip }, async () => {
  await withLivePage(async ({ send, sessionId }) => {
    const { refs } = await snapshot(send, sessionId, { scope: "full_page" });
    const buttonRef = refs.find(
      (ref) => ref.role === "button" && ref.name === "Click counter",
    );
    assert.ok(buttonRef, "refs carry the button");
    const resolved = await send(
      "DOM.resolveNode",
      { backendNodeId: buttonRef.backendNodeId, objectGroup: "grazer" },
      sessionId,
    );
    assert.ok(resolved.object?.objectId, "backendNodeId resolves to a remote object");
    assert.equal(resolved.object.description, "button#click-button");
  });
});

test("AC-3: snapshot rejects with a prefixed error when CDP fails", { skip }, async () => {
  const failing = async () => {
    throw new Error("Session with given id not found.");
  };
  await assert.rejects(
    () => snapshot(failing, "gone", {}),
    /^Error: snapshot failed: Session with given id not found\.$/,
  );
});
