#!/usr/bin/env node
/**
 * Regenerate the API documentation in skills/grazer/ from the built runtime.
 *
 *   node scripts/generate-skill-doc.mjs           # rewrite the generated blocks
 *   node scripts/generate-skill-doc.mjs --check   # exit 1 if they are stale
 *
 * Requires `npm run build` first: the model is read from dist/, which is the
 * code that actually ships, not from the TypeScript sources.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MARKERS,
  buildApiModel,
  extractBlock,
  renderApiIndex,
  renderApiReference,
  spliceBlock,
} from "../dist/src/skill-doc.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const skillDir = join(repoRoot, "skills", "grazer");

const check = process.argv.includes("--check");
const model = buildApiModel();

// A doc entry for something the runtime does not install is the original bug in
// its purest form: publishing it would send an agent to call a name that throws.
// Refuse to write rather than generate a reference that is wrong on arrival.
if (model.phantom.length > 0) {
  console.error(
    `FUNCTION_DOCS documents ${model.phantom.length} name(s) the runtime does not install:`,
  );
  for (const path of model.phantom) console.error(`  ${path}`);
  console.error("Remove the entry, or install the helper. Refusing to write.");
  process.exit(1);
}

if (model.undocumented.length > 0) {
  console.error(
    `The runtime installs ${model.undocumented.length} name(s) with no FUNCTION_DOCS entry:`,
  );
  for (const path of model.undocumented) console.error(`  ${path}`);
  console.error(
    "Add an entry in src/format.ts so the reference can describe it. Refusing to write.",
  );
  process.exit(1);
}

const targets = [
  {
    file: join(skillDir, "SKILL.md"),
    marker: MARKERS.index,
    body: renderApiIndex(model),
  },
  {
    file: join(skillDir, "references", "api.md"),
    marker: MARKERS.reference,
    body: renderApiReference(model),
  },
];

let stale = 0;
for (const target of targets) {
  const current = readFileSync(target.file, "utf8");
  const rel = relative(repoRoot, target.file).replaceAll("\\", "/");
  if (extractBlock(current, target.marker) === target.body.trim()) {
    console.log(`  up to date  ${rel}`);
    continue;
  }
  stale += 1;
  if (check) {
    console.error(`  STALE       ${rel}`);
    continue;
  }
  writeFileSync(target.file, spliceBlock(current, target.marker, target.body));
  console.log(`  written     ${rel}`);
}

const entryCount = model.facades.reduce(
  (total, facade) => total + facade.entries.length,
  0,
);
console.log(
  `  ${entryCount} installed callables across ${model.facades.length} groups, ` +
    `plus ${model.locator.methods.length} Locator methods`,
);

if (check && stale > 0) {
  console.error(
    `\n${stale} generated block(s) are stale. Run: npm run skill:doc`,
  );
  process.exit(1);
}
