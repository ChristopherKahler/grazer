/**
 * T2 grader — PENDING the choice of site and account.
 *
 * Same shape as T1: the CSV comparison is complete and tested, the independent
 * fetch is not implementable until the dashboard is chosen.
 */

/** Fetch the dashboard's rows independently of the driver under test. */
async function fetchDashboardRows(_ctx) {
  throw new Error(
    "T2 ground truth is pending: no dashboard has been chosen yet. " +
      "Implement fetchDashboardRows() against that service's own data path, " +
      "then delete this throw.",
  );
}

export const pending = true;

export async function groundTruth(ctx) {
  return { rows: await fetchDashboardRows(ctx) };
}

/** Split a CSV line, honouring double-quoted fields containing commas. */
export function splitCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Find the CSV inside the agent's answer.
 *
 * Agents wrap CSV in fences, prose, or both. The header row is the anchor: the
 * first line whose fields match the expected header is where the table starts.
 */
export function extractCsv(text, header) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/^```\w*$|^```$/, "").trim());
  const wanted = header.map((h) => h.toLowerCase());
  const start = lines.findIndex((line) => {
    const fields = splitCsvLine(line).map((f) => f.toLowerCase());
    return fields.length === wanted.length && fields.every((f, i) => f === wanted[i]);
  });
  if (start < 0) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "") break;
    const fields = splitCsvLine(lines[i]);
    if (fields.length !== header.length) break;
    rows.push(fields);
  }
  return rows;
}

/**
 * Rows must match exactly, in order — a dashboard table has an order and
 * "export the visible rows" means all of them, not a representative sample.
 */
export function grade(finalAnswer, expected) {
  const { rows } = expected;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { pass: false, detail: "ground truth had no rows" };
  }
  const header = rows[0];
  const want = rows.slice(1);

  const got = extractCsv(finalAnswer, header);
  if (got === null) {
    return { pass: false, detail: `no CSV with header [${header.join(",")}] found in the answer` };
  }
  if (got.length !== want.length) {
    return { pass: false, detail: `expected ${want.length} data rows, got ${got.length}` };
  }
  for (let i = 0; i < want.length; i++) {
    for (let c = 0; c < header.length; c++) {
      if (got[i][c] !== want[i][c]) {
        return {
          pass: false,
          detail: `row ${i + 1} column "${header[c]}": got ${JSON.stringify(got[i][c])}, want ${JSON.stringify(want[i][c])}`,
        };
      }
    }
  }
  return { pass: true, detail: `matched ${want.length} rows` };
}
