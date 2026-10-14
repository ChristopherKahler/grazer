/**
 * T3 grader: did the agent find exactly the pages that mention the term?
 *
 * Ground truth comes from the fixture's own DOCS table, so the expected set and
 * the served pages cannot drift apart.
 */

import { T3_EXPECTED_SLUGS } from "../fixture/server.mjs";

export async function groundTruth() {
  return { slugs: [...T3_EXPECTED_SLUGS].sort() };
}

/** `TITLE — URL` (em dash or hyphen), the URL last and alone on the line. */
const ANSWER_LINE = /^(.+?)\s+[—-]\s+(\S*\/docs\/([a-z0-9-]+))\/?$/i;

/**
 * Grade ONLY lines matching the answer contract: `TITLE — URL`.
 *
 * The pilot run failed a CORRECT answer because this used to scrape every
 * `/docs/<slug>` it could find anywhere in the text — including a table row the
 * agent had written to say those pages did NOT match. Reading an exclusion as a
 * claim is the grader inventing a mistake the agent never made.
 *
 * The task now states the contract explicitly, and it is identical for all
 * three drivers, so a format miss costs every driver the same.
 */
export function grade(finalAnswer, expected) {
  const want = [...expected.slugs].sort();
  const claimed = new Set();
  let contractLines = 0;

  for (const raw of String(finalAnswer ?? "").split("\n")) {
    const match = ANSWER_LINE.exec(raw.trim());
    if (!match) continue;
    contractLines++;
    claimed.add(match[3].toLowerCase());
  }

  if (contractLines === 0) {
    return {
      pass: false,
      detail: "no lines matched the required answer format (TITLE — URL, one per page)",
    };
  }

  const got = [...claimed].sort();
  const missing = want.filter((slug) => !claimed.has(slug));
  const extra = got.filter((slug) => !want.includes(slug));
  const pass = missing.length === 0 && extra.length === 0;

  return {
    pass,
    detail: pass
      ? `matched all ${want.length} pages`
      : `missing=[${missing.join(",")}] extra=[${extra.join(",")}] got=[${got.join(",")}]`,
  };
}
