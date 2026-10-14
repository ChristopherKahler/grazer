/**
 * T4 grader: did the RIGHT form data actually reach the server, and did the
 * agent read back the code the server issued?
 *
 * Ground truth is the server's own record, never the agent's account of what it
 * typed — that is the independent-path rule this benchmark grades everything by.
 */

import { T4_VALUES } from "../fixture/server.mjs";

export async function groundTruth(ctx) {
  const response = await fetch(`${ctx.baseUrl}/__submissions`);
  if (!response.ok) {
    throw new Error(`fixture /__submissions returned HTTP ${response.status}`);
  }
  const { submissions } = await response.json();
  return { submissions, expected: T4_VALUES };
}

export function grade(finalAnswer, truth) {
  const { submissions, expected } = truth;

  // Exactly one: a retry loop that submits three times and reports the last
  // code has not done the task, it has spammed the endpoint.
  if (submissions.length === 0) {
    return { pass: false, detail: "the server received no submission" };
  }
  if (submissions.length > 1) {
    return {
      pass: false,
      detail: `the server received ${submissions.length} submissions; exactly one was asked for`,
    };
  }

  const { fields, code } = submissions[0];
  const wrong = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = String(fields[key] ?? "").trim();
    if (got !== want) wrong.push(`${key}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  if (wrong.length > 0) {
    return { pass: false, detail: `submitted values wrong — ${wrong.join("; ")}` };
  }

  // The code proves the agent read the confirmation page rather than assuming
  // the submit worked.
  if (!String(finalAnswer ?? "").includes(code)) {
    return {
      pass: false,
      detail: `submission was correct but the answer did not report the confirmation code ${code}`,
    };
  }
  return { pass: true, detail: `correct submission, reported ${code}` };
}
