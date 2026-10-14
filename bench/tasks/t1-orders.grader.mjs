/**
 * T1 grader — PENDING the choice of site and account.
 *
 * The comparison logic is complete and tested; only the independent fetch is
 * unknown, because it depends on which service T1 targets. `groundTruth` throws
 * a clear pending error rather than returning something plausible, so a run
 * cannot silently "pass" against a placeholder.
 *
 * When the site is chosen, implement `fetchRecentOrders` and nothing else.
 */

/**
 * Fetch the three most recent order numbers by an INDEPENDENT path — the
 * service's own API or HTML, with the bundle's cookies, over plain HTTP.
 *
 * Never through the driver under test: a live account's orders change, and
 * grading the agent against its own output proves only that it is
 * self-consistent.
 */
async function fetchRecentOrders(_ctx) {
  throw new Error(
    "T1 ground truth is pending: no site or account has been chosen yet. " +
      "Implement fetchRecentOrders() against that service's own API using the " +
      "bundle cookies, then delete this throw.",
  );
}

export const pending = true;

export async function groundTruth(ctx) {
  return { orders: await fetchRecentOrders(ctx) };
}

/**
 * Compare as an ORDERED sequence: "newest first" is part of the task, so an
 * agent that finds the right three in the wrong order has not done it.
 *
 * Extraction is tolerant of prose and of the separators order numbers are
 * usually printed with; content is strict.
 */
export function grade(finalAnswer, expected) {
  const want = expected.orders.map(String);
  const text = String(finalAnswer ?? "");

  // Pull every token that looks like an order number, in the order they appear,
  // de-duplicated so a summary line repeating them does not break the sequence.
  const seen = [];
  for (const match of text.matchAll(/\b[A-Z0-9][A-Z0-9-]{4,}\b/gi)) {
    const token = match[0].toUpperCase();
    if (!seen.includes(token)) seen.push(token);
  }
  const got = seen.filter((token) => want.some((w) => w.toUpperCase() === token));

  if (got.length !== want.length) {
    return {
      pass: false,
      detail: `expected ${want.length} order numbers, matched ${got.length} (want=[${want.join(",")}] sawTokens=[${seen.slice(0, 8).join(",")}])`,
    };
  }
  const ordered = got.every((token, i) => token === want[i].toUpperCase());
  return ordered
    ? { pass: true, detail: `matched ${want.length} orders in order` }
    : { pass: false, detail: `right orders, wrong sequence: got=[${got.join(",")}] want=[${want.join(",")}]` };
}
