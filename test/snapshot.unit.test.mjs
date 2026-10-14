/**
 * Deterministic snapshot tests. Everything here runs against committed
 * fixtures captured from real Chrome (`node test/support/capture-ax.mjs`), so
 * the whole pipeline — options, fetch decoding, ref selection, locators, the
 * renderer — is covered without a browser.
 *
 * Assertions match lines to refs rather than to literal backendNodeId values,
 * because those numbers change every time the fixtures are recaptured.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAxTree,
  buildDomIndex,
  parseSnapshotOptions,
  renderSnapshot,
  SNAPSHOT_DEFAULTS,
} from "../dist/snapshot/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "snapshot");

const readFixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const tree = buildAxTree(readFixture("ax-tree.json").nodes);
const domIndex = buildDomIndex(readFixture("dom-snapshot.json"));
const viewport = readFixture("layout-metrics.json").cssVisualViewport;

const render = (options) =>
  renderSnapshot(tree, domIndex, viewport, parseSnapshotOptions(options));

const lines = (content) => content.split("\n");
const lineMatching = (content, pattern) => lines(content).find((l) => pattern.test(l));

/* ------------------------------------------------------------------ AC-1 */

test("AC-1: options parse exactly", () => {
  const parsed = parseSnapshotOptions({
    scope: "only_within_viewport",
    includeActionMarks: false,
    maxResultLength: 5000,
  });
  assert.deepEqual(parsed, {
    scope: "only_within_viewport",
    includeActionMarks: false,
    interactiveOnly: false,
    includeStableLocator: true,
    maxResultLength: 5000,
  });
});

test("AC-1: unknown scope and non-object input fall back to defaults", () => {
  assert.deepEqual(parseSnapshotOptions({ scope: "sideways" }), SNAPSHOT_DEFAULTS);
  for (const input of [undefined, null, "full_page", 7, [], () => {}]) {
    assert.deepEqual(parseSnapshotOptions(input), SNAPSHOT_DEFAULTS, String(input));
  }
});

test("AC-1: garbage field values do not throw and do not leak through", () => {
  const parsed = parseSnapshotOptions({
    includeActionMarks: "yes",
    interactiveOnly: 1,
    includeStableLocator: null,
    maxResultLength: -20,
  });
  assert.deepEqual(parsed, SNAPSHOT_DEFAULTS);
  assert.equal(parseSnapshotOptions({ maxResultLength: 12.7 }).maxResultLength, 12);
});

/* --------------------------------------------------- Task 1 verification */

test("buildAxTree assembles a hand-written payload into a tree", () => {
  const built = buildAxTree([
    {
      nodeId: "1",
      role: { value: "RootWebArea" },
      name: { value: "doc" },
      childIds: ["2", "missing"],
      backendDOMNodeId: 1,
      properties: [{ name: "focusable", value: { value: true } }],
    },
    {
      nodeId: "2",
      role: { value: "button" },
      name: { value: "Go" },
      backendDOMNodeId: 5,
      childIds: ["3"],
      properties: [
        { name: "level", value: { value: 2 } },
        { name: "disabled", value: { value: true } },
        { name: "url", value: { value: "http://x/y" } },
      ],
    },
    { nodeId: "3", role: { value: "StaticText" }, name: { value: "Go" }, ignored: true },
  ]);
  assert.equal(built.axNodeId, "1");
  assert.equal(built.props.focusable, true);
  assert.equal(built.children.length, 1, "a missing childId is skipped, not fatal");
  const [button] = built.children;
  assert.equal(button.role, "button");
  assert.equal(button.backendNodeId, 5);
  assert.deepEqual(button.props, { level: 2, disabled: true, url: "http://x/y" });
  assert.equal(button.children[0].ignored, true);
});

test("buildAxTree tolerates empty and malformed input", () => {
  assert.equal(buildAxTree(undefined), undefined);
  assert.equal(buildAxTree([]), undefined);
  assert.equal(buildAxTree([null, "nope"]), undefined);
});

test("buildDomIndex decodes the string table, attributes and rects", () => {
  const index = buildDomIndex({
    strings: ["http://host/p", "BUTTON", "id", "go", "class", "a b", "A", "href", "/x", "type", "text"],
    documents: [
      {
        documentURL: 0,
        nodes: {
          backendNodeId: [11, 12],
          nodeName: [1, 6],
          attributes: [
            [2, 3, 4, 5],
            [7, 8, 9, 10],
          ],
        },
        layout: {
          nodeIndex: [0, 1],
          bounds: [
            [1, 2, 30, 40],
            [0, 0, 0, 0],
          ],
        },
      },
    ],
  });
  assert.equal(index.documentUrl, "http://host/p");
  const button = index.byBackendNodeId.get(11);
  assert.equal(button.nodeName, "BUTTON");
  assert.equal(button.id, "go");
  assert.deepEqual(button.classList, ["a", "b"]);
  assert.deepEqual(button.rect, { x: 1, y: 2, width: 30, height: 40 });
  const link = index.byBackendNodeId.get(12);
  assert.equal(link.href, "/x");
  assert.equal(link.typeAttr, "text");
  assert.equal(link.rect, undefined, "a zero-area node carries no rect");
  assert.equal(index.idCounts.get("go"), 1);
});

test("buildDomIndex returns an empty index for a missing document", () => {
  const index = buildDomIndex({ strings: [], documents: [] });
  assert.equal(index.byBackendNodeId.size, 0);
  assert.equal(index.documentUrl, "");
});

test("the fixture payloads decode into a usable tree and index", () => {
  assert.ok(tree, "ax tree fixture builds a root");
  assert.equal(tree.role, "RootWebArea");
  assert.ok(domIndex.byBackendNodeId.size > 10, "dom index has nodes");
  assert.equal(domIndex.documentUrl, "http://fixture.local/");
  assert.equal(domIndex.idCounts.get("click-button"), 1);
});

/* ------------------------------------------------------------------ AC-2 */

test("AC-2: defaults render the documented tree with refs and locators", () => {
  const { content, refs } = render({});

  const heading = lineMatching(content, /^- heading "Helper e2e fixture" \[ref=\d+/);
  assert.ok(heading, `no heading line in:\n${content}`);

  const button = lineMatching(
    content,
    /^\s*- button "Click counter" \[ref=\d+, loc=css:#click-button\]/,
  );
  assert.ok(button, `no click-button line in:\n${content}`);

  const link = lineMatching(content, /^\s*- link "Nav target" \[ref=\d+, /);
  assert.ok(link, `no link line in:\n${content}`);
  assert.match(link, /loc=href:\/nav-target/);
  assert.match(link, /url=http:\/\/\S*\/nav-target\]/);

  const buttonRef = refs.find(
    (ref) => ref.role === "button" && ref.name === "Click counter",
  );
  assert.ok(buttonRef, "refs carry the button");
  assert.match(
    button,
    new RegExp(`\\[ref=${buttonRef.backendNodeId},`),
    "the button line and its ref entry agree on the backendNodeId",
  );
  for (const ref of refs) {
    assert.equal(typeof ref.backendNodeId, "number");
    assert.equal(typeof ref.role, "string");
    assert.equal(typeof ref.name, "string");
  }
});

test("AC-2: ambiguous duplicates get refs but no locator", () => {
  const { content, refs } = render({});
  const duplicates = lines(content).filter((l) => l.includes('"Duplicate action"'));
  assert.equal(duplicates.length, 2);
  for (const line of duplicates) {
    assert.match(line, /\[ref=\d+\]/, "still addressable by ref");
    assert.doesNotMatch(line, /loc=/, "css and role are both ambiguous here");
  }
  assert.equal(
    refs.filter((ref) => ref.name === "Duplicate action").length,
    2,
    "both duplicates are in refs",
  );
});

test("AC-2: text renders whitespace-collapsed and structural roles never do", () => {
  const { content } = render({});
  const textLines = lines(content).filter((l) => l.trim().startsWith("- text:"));
  assert.ok(textLines.length > 0);
  for (const line of textLines) {
    assert.doesNotMatch(line.trim().slice("- text:".length), /\s\s|\t/);
  }
  assert.ok(lineMatching(content, /- text: Helper e2e fixture$/));
  for (const line of lines(content)) {
    assert.doesNotMatch(line, /^\s*- (generic|none|presentation)\b/, line);
  }
  assert.ok(
    !content.includes("Hidden content"),
    "a display:none element never reaches the snapshot",
  );
});

test("AC-2: includeActionMarks false hides marks but keeps refs", () => {
  const { content, refs } = render({ includeActionMarks: false });
  assert.ok(!content.includes("[ref="), "no action marks");
  assert.ok(!content.includes("loc="), "no locators without a mark to carry them");
  assert.ok(refs.length > 0, "refs stay populated");
  assert.ok(refs.some((ref) => ref.name === "Click counter"));
  assert.ok(content.includes('- heading "Helper e2e fixture"'), "lines still render");
});

test("AC-2: includeStableLocator false drops loc= and keeps ref=", () => {
  const { content } = render({ includeStableLocator: false });
  assert.ok(!content.includes("loc="));
  assert.ok(lineMatching(content, /^\s*- button "Click counter" \[ref=\d+\]$/));
});

test("AC-2: interactiveOnly keeps only flat interactive ref'd lines", () => {
  const { content } = render({ interactiveOnly: true });
  const rendered = lines(content);
  assert.ok(rendered.length > 0);
  for (const line of rendered) {
    assert.match(line, /^- \S+ .*\[ref=\d+/, line);
    assert.doesNotMatch(line, /^\s/, "interactiveOnly output is flat");
  }
  assert.ok(!content.includes("- heading"), "headings are navigation, not interactive");
  assert.ok(!content.includes("- text:"), "no text lines");
  assert.ok(!content.includes("- paragraph"), "no structural lines");
  assert.ok(content.includes('- button "Click counter"'));
  assert.ok(content.includes('- textbox "Text input"'));
  assert.ok(content.includes('- link "Nav target"'));
});

test("AC-2: maxResultLength truncates on a line boundary with a marker", () => {
  const { content } = render({ maxResultLength: 200 });
  assert.ok(content.length <= 240, `content was ${content.length} chars`);
  const rendered = lines(content);
  assert.match(rendered.at(-1), /^\[truncated: \d+ of \d+ chars\]$/);
  const body = rendered.slice(0, -1).join("\n");
  assert.ok(render({}).content.startsWith(body), "the kept prefix is unmodified");
});

test("AC-2: viewport scope drops the far-below node, full_page keeps it", () => {
  assert.ok(render({}).content.includes("Far below"), "full_page keeps it");
  const clipped = render({ scope: "only_within_viewport" }).content;
  assert.ok(!clipped.includes("Far below"), `far-below survived:\n${clipped}`);
  assert.ok(clipped.includes("Helper e2e fixture"), "in-viewport content survives");
});
