/**
 * AC-1 and AC-2: iframe recursion against real Chrome.
 *
 * The fixture deliberately embeds the SAME child page twice — once same-origin
 * and once from a distinct `.test` hostname. Chrome isolates by site, not by
 * port, so only the second becomes an out-of-process frame; that pairing is
 * what makes the actionable/read-only distinction testable at all.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { acquireSuiteLock } from "./support/suite-lock.mjs";

import {
  buildAxTree,
  buildDomIndex,
  collectFrameGraph,
  findIframeNodes,
  parseSnapshotOptions,
  renderFrames,
  snapshot,
  CROSS_SITE_NOTE,
} from "../dist/snapshot/index.js";
import {
  connectCdp,
  findChromium,
  launchChromium,
  openPage,
  startFramesServers,
  startNestedFramesServers,
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
  suiteLock = await acquireSuiteLock("snapshot.frames");
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


async function withFramesPage(body) {
  const servers = await startFramesServers();
  const browser = await launchChromium(chromium, { crossOrigin: true });
  let client;
  try {
    client = await connectCdp(browser.endpoint);
    const { sessionId } = await openPage(client, `${servers.outerOrigin}/`);
    const send = (method, params, session) =>
      client.send(method, params ?? {}, session ?? sessionId);
    const frameOptions = { onEvent: client.on };
    return await body({ send, sessionId, client, servers, frameOptions });
  } finally {
    await client?.close();
    await browser.kill();
    await servers.close();
  }
}

const lines = (content) => content.split("\n");
const lineMatching = (content, pattern) => lines(content).find((l) => pattern.test(l));
const indentOf = (line) => line.length - line.trimStart().length;

/* ------------------------------------------------------- frame collection */

test("collectFrameGraph orders frames parent-first from a hand-written payload", async () => {
  // A fake `send` standing in for Chrome: one main document plus one
  // same-process child, joined by DOM.describeNode.
  const calls = [];
  const child = {
    documentURL: 1,
    frameId: 3,
    nodes: { backendNodeId: [100], nodeName: [4], attributes: [[]] },
    layout: { nodeIndex: [], bounds: [] },
  };
  const send = async (method, params) => {
    calls.push(method);
    if (method === "Accessibility.enable") return {};
    if (method === "Accessibility.getFullAXTree") {
      return params?.frameId === "child-frame"
        ? {
            nodes: [
              {
                nodeId: "c1",
                role: { value: "button" },
                name: { value: "Inner action" },
                backendDOMNodeId: 100,
              },
            ],
          }
        : {
            nodes: [
              { nodeId: "r", role: { value: "RootWebArea" }, childIds: ["f"] },
              {
                nodeId: "f",
                role: { value: "Iframe" },
                name: { value: "Same origin frame" },
                backendDOMNodeId: 55,
              },
            ],
          };
    }
    if (method === "DOMSnapshot.captureSnapshot") {
      return {
        strings: ["http://host/", "http://host/child", "root-frame", "child-frame", "BUTTON"],
        documents: [
          {
            documentURL: 0,
            frameId: 2,
            nodes: { backendNodeId: [55], nodeName: [4], attributes: [[]] },
            layout: { nodeIndex: [0], bounds: [[10, 20, 300, 100]] },
          },
          child,
        ],
      };
    }
    if (method === "DOM.describeNode") {
      assert.equal(params.backendNodeId, 55);
      return { node: { frameId: "child-frame" } };
    }
    throw new Error(`unexpected CDP call ${method}`);
  };

  const graph = await collectFrameGraph(send, undefined);
  assert.equal(graph.rootFrameId, "root-frame");
  assert.deepEqual([...graph.bundles.keys()], ["root-frame", "child-frame"]);

  const root = graph.bundles.get("root-frame");
  assert.equal(root.childFrames.get(55), "child-frame");
  const inner = graph.bundles.get("child-frame");
  assert.equal(inner.crossProcess, false);
  // The child's rects are child-document relative, so the iframe element's
  // origin becomes the child's offset into page space.
  assert.equal(inner.offsetX, 10);
  assert.equal(inner.offsetY, 20);
  assert.ok(
    !calls.includes("Target.setAutoAttach"),
    "no auto-attach when every frame is same-process",
  );
  assert.ok(!calls.includes("Page.getFrameTree"), "frame tree is never needed here");
});

test("collectFrameGraph spends no extra calls on a page with no iframes", async () => {
  const calls = [];
  const send = async (method) => {
    calls.push(method);
    if (method === "Accessibility.getFullAXTree") {
      return { nodes: [{ nodeId: "r", role: { value: "RootWebArea" } }] };
    }
    if (method === "DOMSnapshot.captureSnapshot") {
      return {
        strings: ["http://host/", "only-frame"],
        documents: [
          {
            documentURL: 0,
            frameId: 1,
            nodes: { backendNodeId: [], nodeName: [], attributes: [] },
            layout: { nodeIndex: [], bounds: [] },
          },
        ],
      };
    }
    return {};
  };
  const graph = await collectFrameGraph(send, undefined);
  assert.equal(graph.bundles.size, 1);
  // Sorted: the two fetches run concurrently, so their order is not a contract.
  assert.deepEqual(
    calls.filter((c) => c !== "Accessibility.enable").sort(),
    ["Accessibility.getFullAXTree", "DOMSnapshot.captureSnapshot"],
    "an iframe-free page costs exactly the 03-01 two calls",
  );
});

test("findIframeNodes finds iframe roles at any depth and ignores the rest", () => {
  const tree = buildAxTree([
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "4"] },
    { nodeId: "2", role: { value: "generic" }, childIds: ["3"] },
    { nodeId: "3", role: { value: "Iframe" }, backendDOMNodeId: 7 },
    { nodeId: "4", role: { value: "button" }, backendDOMNodeId: 8 },
  ]);
  assert.deepEqual(
    findIframeNodes(tree).map((node) => node.backendNodeId),
    [7],
  );
  assert.deepEqual(findIframeNodes(undefined), []);
});

/* -------------------------------------------------------------- AC-1/AC-2 */

test("AC-1: same-process iframe content nests and is actionable", { skip }, async () => {
  await withFramesPage(async ({ send, sessionId, frameOptions }) => {
    const { content, refs } = await snapshot(
      send,
      sessionId,
      { scope: "full_page" },
      frameOptions,
    );

    const iframeLines = lines(content).filter((l) => /^\s*- iframe\b/.test(l));
    assert.equal(iframeLines.length, 2, `expected two iframe lines in:\n${content}`);
    const sameOrigin = iframeLines.find((l) => l.includes("Same origin frame"));
    assert.ok(sameOrigin, "same-origin iframe line present");
    assert.match(sameOrigin, /\[ref=\d+/, "the iframe element itself is ref'd");

    const inner = lineMatching(content, /^\s*- button "Inner action" \[ref=\d+/);
    assert.ok(inner, `no inner button line in:\n${content}`);
    assert.ok(
      indentOf(inner) > indentOf(sameOrigin),
      "child content nests beneath its iframe line",
    );

    const innerRef = refs.find((ref) => ref.name === "Inner action");
    assert.ok(innerRef, "refs carry the inner button");
    assert.match(inner, new RegExp(`\\[ref=${innerRef.backendNodeId},|\\[ref=${innerRef.backendNodeId}\\]`));

    const resolved = await send("DOM.resolveNode", {
      backendNodeId: innerRef.backendNodeId,
      objectGroup: "grazer",
    });
    assert.ok(resolved.object?.objectId, "a same-process ref resolves on the page session");
    assert.equal(resolved.object.description, "button#inner-button");
  });
});

test("AC-2: cross-site frame is visible, marked, and carries no refs", { skip }, async () => {
  await withFramesPage(async ({ send, sessionId, frameOptions }) => {
    const { content, refs } = await snapshot(
      send,
      sessionId,
      { scope: "full_page" },
      frameOptions,
    );
    const rendered = lines(content);

    const crossLine = rendered.find((l) => l.includes("Cross origin frame"));
    assert.ok(crossLine, `no cross-origin iframe line in:\n${content}`);
    const noteIndex = rendered.findIndex((l) => l.includes(CROSS_SITE_NOTE));
    assert.ok(noteIndex > 0, `no cross-site note in:\n${content}`);
    assert.equal(
      rendered[noteIndex - 1],
      crossLine,
      "the note sits directly under its iframe line",
    );
    assert.ok(
      indentOf(rendered[noteIndex]) > indentOf(crossLine),
      "the note nests under the iframe line",
    );

    // The OOPIF's content is readable...
    const after = rendered.slice(noteIndex);
    const oopifHeading = after.find((l) => /- heading "Child frame"/.test(l));
    assert.ok(oopifHeading, `cross-site content missing in:\n${content}`);
    const oopifButton = after.find((l) => /- button "Inner action"/.test(l));
    assert.ok(oopifButton, "cross-site button is rendered");
    // ...and honestly marked unusable.
    assert.doesNotMatch(oopifButton, /\[ref=/, "cross-site nodes carry no ref");
    assert.doesNotMatch(oopifHeading, /\[ref=/, "cross-site nodes carry no ref");

    // Exactly one "Inner action" ref: the same-process one.
    assert.equal(
      refs.filter((ref) => ref.name === "Inner action").length,
      1,
      "the cross-site button is absent from refs",
    );
    assert.ok(refs.some((ref) => ref.name === "Outer action"), "page refs are intact");
  });
});

test("AC-2: page-level refs are unchanged by the cross-site frame", { skip }, async () => {
  await withFramesPage(async ({ send, sessionId, frameOptions }) => {
    const withFrames = await snapshot(send, sessionId, {}, frameOptions);
    // Rendering the root frame alone must produce the same page-level refs.
    const tree = buildAxTree((await send("Accessibility.getFullAXTree")).nodes);
    const domIndex = buildDomIndex(
      await send("DOMSnapshot.captureSnapshot", {
        computedStyles: [],
        includeDOMRects: true,
      }),
    );
    const rootOnly = renderFrames(
      {
        rootFrameId: "solo",
        bundles: new Map([
          [
            "solo",
            {
              frameId: "solo",
              url: domIndex.documentUrl,
              crossProcess: false,
              tree,
              domIndex,
              childFrames: new Map(),
              offsetX: 0,
              offsetY: 0,
            },
          ],
        ]),
      },
      undefined,
      parseSnapshotOptions({}),
    );
    const pageLevel = withFrames.refs.filter((ref) =>
      rootOnly.refs.some((other) => other.backendNodeId === ref.backendNodeId),
    );
    assert.deepEqual(
      pageLevel.map((ref) => `${ref.role}:${ref.name}`),
      rootOnly.refs.map((ref) => `${ref.role}:${ref.name}`),
      "every page-level ref survives frame recursion unchanged",
    );
  });
});

test("AC-1: viewport scope offsets child rects into page space", { skip }, async () => {
  await withFramesPage(async ({ send, sessionId, frameOptions }) => {
    const clipped = await snapshot(
      send,
      sessionId,
      { scope: "only_within_viewport" },
      frameOptions,
    );
    // Both iframes sit inside a 900x700 window, so their content stays visible
    // once child rects are shifted by the iframe element's origin.
    assert.ok(
      clipped.content.includes("Inner action"),
      `child content dropped under viewport scope:\n${clipped.content}`,
    );
    assert.ok(clipped.content.includes("Frames fixture"));
  });
});

/* ------------------------------------------------ AC-2: nested cross-site */

/** outer.test -> inner.test -> deep.test, each its own renderer process. */
async function withNestedPage(body) {
  const servers = await startNestedFramesServers();
  const browser = await launchChromium(chromium, { crossOrigin: true });
  let client;
  try {
    client = await connectCdp(browser.endpoint);
    const { sessionId } = await openPage(client, `${servers.outerOrigin}/`);
    const send = (method, params, session) =>
      client.send(method, params ?? {}, session ?? sessionId);
    return await body({ send, sessionId, servers, frameOptions: { onEvent: client.on } });
  } finally {
    await client?.close();
    await browser.kill();
    await servers.close();
  }
}

test("AC-2: a cross-site grandchild renders two levels deep, read-only", { skip }, async () => {
  await withNestedPage(async ({ send, sessionId, frameOptions }) => {
    const { content, refs } = await snapshot(
      send,
      sessionId,
      { scope: "full_page" },
      frameOptions,
    );
    const rendered = lines(content);

    const outerIframe = rendered.find((l) => l.includes("Cross origin frame"));
    assert.ok(outerIframe, `no outer iframe line in:
${content}`);
    const childHeading = rendered.find((l) => /- heading "Child frame"/.test(l));
    assert.ok(childHeading, `child frame content missing in:
${content}`);

    const grandchildIframe = rendered.find((l) => l.includes("Grandchild frame") && /- iframe\b/.test(l));
    assert.ok(grandchildIframe, `no grandchild iframe line in:
${content}`);
    const deepHeading = rendered.find((l) => /- heading "Grandchild frame"/.test(l));
    assert.ok(deepHeading, `grandchild content missing in:
${content}`);
    const deepButton = rendered.find((l) => /- button "Deep action"/.test(l));
    assert.ok(deepButton, `grandchild button missing in:
${content}`);

    // Two levels of nesting, measured by indentation.
    assert.ok(
      indentOf(childHeading) > indentOf(outerIframe),
      "child content nests under the outer iframe",
    );
    assert.ok(
      indentOf(deepHeading) > indentOf(grandchildIframe),
      "grandchild content nests under the grandchild iframe",
    );
    assert.ok(
      indentOf(deepHeading) > indentOf(childHeading),
      "the grandchild sits deeper than the child",
    );

    // Every cross-site node stays read-only, at both depths.
    for (const line of [childHeading, deepHeading, deepButton, grandchildIframe]) {
      assert.doesNotMatch(line, /\[ref=/, `cross-site node carried a ref: ${line}`);
    }
    const notes = rendered.filter((l) => l.includes(CROSS_SITE_NOTE));
    assert.equal(notes.length, 2, "one note per cross-site frame");

    // Page-level refs are untouched by either frame.
    assert.ok(refs.some((ref) => ref.name === "Outer action"), "page button still ref'd");
    assert.ok(refs.some((ref) => ref.name === "Cross origin frame"), "iframe element still ref'd");
    assert.equal(
      refs.filter((ref) => ["Inner action", "Deep action", "Grandchild frame"].includes(ref.name))
        .length,
      0,
      "nothing from either cross-site frame reaches refs",
    );
  });
});
