import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MARKERS,
  buildApiModel,
  collectInstalledPaths,
  collectLocatorMethods,
  extractBlock,
  renderApiIndex,
  renderApiReference,
  spliceBlock,
} from "../dist/src/skill-doc.js";
import { FUNCTION_DOCS } from "../dist/src/format.js";
import { helperContext } from "../dist/src/helpers.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const skillDir = join(repoRoot, "skills", "grazer");

const model = buildApiModel();
const read = (...segments) => readFileSync(join(skillDir, ...segments), "utf8");

/* ── coverage: every installed name is documented ──
 * This is the arm that catches the class of defect, not just an instance of it.
 * A helper added to a facade without a FUNCTION_DOCS entry fails here on the
 * commit that adds it, instead of silently reaching an agent as a name with no
 * signature. */
test("every installed helper has a doc entry", () => {
  assert.deepEqual(
    model.undocumented,
    [],
    `installed with no FUNCTION_DOCS entry: ${model.undocumented.join(", ")}`,
  );
});

/* ── the inverse, and the original bug: a documented name that does not exist ──
 * SKILL.md 1.2.6 shipped a whole API of these. Every example threw on its
 * first line. */
test("every doc entry names something the runtime installs", () => {
  assert.deepEqual(
    model.phantom,
    [],
    `documented but not installed: ${model.phantom.join(", ")}`,
  );
});

test("the doc table and the installed surface are the same size", () => {
  const installed = collectInstalledPaths(helperContext());
  assert.equal(installed.length, Object.keys(FUNCTION_DOCS).length);
  assert.ok(installed.length > 0, "walked an empty helper surface");
});

/* ── drift: what is committed is what the runtime declares right now ── */
test("the SKILL.md API index matches the runtime", () => {
  assert.equal(
    extractBlock(read("SKILL.md"), MARKERS.index),
    renderApiIndex(model).trim(),
    "SKILL.md is stale — run `npm run skill:doc` in packages/harness",
  );
});

test("the references/api.md reference matches the runtime", () => {
  assert.equal(
    extractBlock(read("references", "api.md"), MARKERS.reference),
    renderApiReference(model).trim(),
    "references/api.md is stale — run `npm run skill:doc` in packages/harness",
  );
});

/* ── every name the docs put in front of an agent is real ──
 * Guards the hand-written half of SKILL.md too: prose naming a helper that no
 * longer exists is the same defect as a stale generated block. */
test("every grazer name in the generated index is installed", () => {
  const installed = new Set(collectInstalledPaths(helperContext()));
  const index = extractBlock(read("SKILL.md"), MARKERS.index);
  const named = [
    ...index.matchAll(
      /`((?:page|browser|taskSpaces|site|fetch)\.[A-Za-z.]*[A-Za-z])\(/g,
    ),
  ]
    .map((match) => match[1])
    .filter((path) => !path.startsWith("page.locator."));
  assert.ok(named.length > 0, "index named no facade helpers");
  for (const path of named) {
    assert.ok(installed.has(path), `SKILL.md names ${path}, not installed`);
  }
});

test("Locator methods are read off a live locator, not hard-coded", () => {
  const methods = collectLocatorMethods(helperContext());
  assert.ok(methods.includes("click"), "locator lost click()");
  assert.ok(methods.includes("fill"), "locator lost fill()");
  assert.equal(
    methods.length,
    model.locator.methods.length,
    "model and live locator disagree",
  );
  assert.ok(
    !methods.includes("selector"),
    "selector is a value, not a callable",
  );
});

/* ── splice mechanics: the hand-written guidance survives regeneration ── */
test("spliceBlock replaces only its own region", () => {
  const source = [
    "# Title",
    "",
    "hand-written above",
    "",
    MARKERS.index.begin,
    "",
    "stale body",
    "",
    MARKERS.index.end,
    "",
    "hand-written below",
    "",
  ].join("\n");
  const spliced = spliceBlock(source, MARKERS.index, "fresh body");
  assert.match(spliced, /hand-written above/);
  assert.match(spliced, /hand-written below/);
  assert.match(spliced, /fresh body/);
  assert.doesNotMatch(spliced, /stale body/);
  assert.equal(extractBlock(spliced, MARKERS.index), "fresh body");
});

test("spliceBlock throws on a file missing its markers", () => {
  assert.throws(
    () => spliceBlock("# no markers here", MARKERS.index, "body"),
    /missing marker pair/,
  );
});

test("spliceBlock throws when the markers are inverted", () => {
  const inverted = `${MARKERS.index.end}\nbody\n${MARKERS.index.begin}`;
  assert.throws(() => spliceBlock(inverted, MARKERS.index, "body"), /precedes/);
});

test("spliceBlock is idempotent", () => {
  const source = `${MARKERS.index.begin}\n\nbody\n\n${MARKERS.index.end}\n`;
  const once = spliceBlock(source, MARKERS.index, "body");
  assert.equal(spliceBlock(once, MARKERS.index, "body"), once);
});

/* ── the generated text carries the facts d5b623e made load-bearing ── */
test("openOrReuseTab documents settled, waitUntil and milliseconds", () => {
  const reference = extractBlock(
    read("references", "api.md"),
    MARKERS.reference,
  );
  const doc = FUNCTION_DOCS["browser.openOrReuseTab"];
  assert.match(doc.description, /settled/);
  assert.match(doc.params.at(-1).description, /"load"/);
  assert.match(doc.params.at(-1).description, /milliseconds, never seconds/);
  assert.match(doc.returns, /settled: boolean/);
  assert.match(doc.returns, /waitedFor/);
  for (const fragment of ["settled", '"networkidle"', "idleMs", "20000"]) {
    assert.ok(
      reference.includes(fragment),
      `api.md lost ${fragment} from openOrReuseTab`,
    );
  }
});

test("no rendered signature falls back to the undocumented placeholder", () => {
  const index = extractBlock(read("SKILL.md"), MARKERS.index);
  assert.doesNotMatch(
    index,
    /\(…\)/,
    "an installed helper rendered without a signature",
  );
});
