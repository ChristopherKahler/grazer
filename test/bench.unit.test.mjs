/**
 * Benchmark unit tests. No browser, no `claude` invocation — pure parsing,
 * grading and rendering, so this suite is cheap to run under a CPU budget.
 *
 * The captured CLI fixture below is REAL output from
 * `claude --print --output-format json` on 2026-09-03, not a hand-written
 * guess. That was a condition of the approved G0 design: fields nobody has seen
 * are never read.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { cleanHome } from "./support/clean-home.mjs";

import { finalAnswerOf, inputTokensOf, metricsFrom, parseCliJson } from "../bench/lib/metrics.mjs";
import { median, renderReport, summarise, toCells } from "../bench/report.mjs";
import { parseFrontmatter, resolvePrompt } from "../bench/lib/tasks.mjs";
import { assertNoSecrets } from "../bench/lib/secrets.mjs";

/** Captured verbatim from a real run (values trimmed to the fields we read). */
const REAL_CLI_RESULT = {
  duration_api_ms: 1648,
  stop_reason: "end_turn",
  session_id: "25e46754-e9da-4a55-8a2e-86bd89275a1b",
  total_cost_usd: 0.0436809,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 20925,
    cache_read_input_tokens: 15209,
    output_tokens: 60,
    output_tokens_details: { thinking_tokens: 53 },
    iterations: [
      { input_tokens: 10, cache_creation_input_tokens: 20925, cache_read_input_tokens: 15209, output_tokens: 60, type: "message" },
    ],
  },
  permission_denials: [],
  terminal_reason: "completed",
  is_error: false,
  result: "OK",
};

test("input tokens are the SUM of the three fields, not usage.input_tokens", () => {
  // The trap this whole parser exists for: reading input_tokens alone reports
  // 10 tokens for a run that actually billed 36,144 of input.
  assert.equal(REAL_CLI_RESULT.usage.input_tokens, 10);
  assert.equal(inputTokensOf(REAL_CLI_RESULT.usage), 36144);
});

test("metricsFrom reads the real captured shape", () => {
  const m = metricsFrom(REAL_CLI_RESULT);
  assert.equal(m.inputTokens, 36144);
  assert.equal(m.outputTokens, 60);
  assert.equal(m.totalTokens, 36204);
  assert.equal(m.costUsd, 0.0436809);
  assert.equal(m.apiMs, 1648);
  assert.equal(m.isError, false);
  assert.equal(m.terminalReason, "completed");
  assert.equal(m.permissionDenials, 0);
  assert.equal(finalAnswerOf(REAL_CLI_RESULT), "OK");
});

test("absent metrics are null, never zero", () => {
  const m = metricsFrom({});
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "fixedTokens", "taskTokens", "costUsd"]) {
    assert.equal(m[key], null, `${key} must be null when unreported`);
  }
  // A missing iterations array must not silently make fixed = 0 and task = total.
  const partial = metricsFrom({ usage: { input_tokens: 5, output_tokens: 2 } });
  assert.equal(partial.totalTokens, 7);
  assert.equal(partial.fixedTokens, null);
  assert.equal(partial.taskTokens, null);
});

test("parseCliJson tolerates leading noise and reports unparseable output", () => {
  assert.deepEqual(parseCliJson('warning: x\n{"a":1}').result, { a: 1 });
  assert.equal(parseCliJson("no json here").ok, false);
  assert.equal(parseCliJson('{"broken":').ok, false);
});

test("the result writer refuses anything that looks like a credential", () => {
  assert.doesNotThrow(() => assertNoSecrets({ task: "t3", finalAnswer: "three pages" }));
  for (const leak of [
    { finalAnswer: "Cookie: session=abc" },
    { headers: { authorization: "Bearer x" } },
    { note: "the token was rejected" },
    { password: "hunter2" },
  ]) {
    assert.throws(() => assertNoSecrets(leak), /refusing to write/);
  }
});

test("medians cover passing reps only, and a fully failed cell reports no numbers", () => {
  const records = [
    { task: "t3", driver: "grazer", rep: 1, success: true, wallMs: 10000, totalTokens: 100, numTurns: 3, costUsd: 0.1 },
    { task: "t3", driver: "grazer", rep: 2, success: true, wallMs: 20000, totalTokens: 200, numTurns: 5, costUsd: 0.2 },
    // A crash that returned in 100ms must not drag the median down — the driver
    // that fails fast would otherwise look fastest.
    { task: "t3", driver: "grazer", rep: 3, success: false, wallMs: 100, totalTokens: 5, numTurns: 1, costUsd: 0.01 },
  ];
  const [cell] = toCells(records).map(summarise);
  assert.equal(cell.passed, 2);
  assert.equal(cell.total, 3);
  assert.equal(cell.wallMs, 15000, "median of the two passing reps, not all three");
  assert.equal(cell.totalTokens, 150);

  const allFailed = toCells([
    { task: "t4", driver: "x", rep: 1, success: false, wallMs: 5, totalTokens: 1 },
  ]).map(summarise)[0];
  assert.equal(allFailed.passed, 0);
  assert.equal(allFailed.wallMs, null, "no passing rep means no number at all");
});

test("median handles empty, odd and even sets", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([null, undefined, 4]), 4, "non-numbers are ignored");
});

test("the report labels itself PILOT and renders absent metrics as a dash", () => {
  const out = renderReport([
    { task: "t3", driver: "grazer", rep: 1, success: true, wallMs: 1000, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, model: "cli-default" },
    { task: "t3", driver: "claude-in-chrome", skipped: true, skipReason: "no MCP config" },
  ]);
  assert.match(out, /\*\*PILOT\*\*/);
  assert.match(out, /skipped/);
  assert.doesNotMatch(out, /\| 0 \| 0 \| 0 \|/, "unreported metrics must not render as zeroes");
  assert.match(out, /—/);
});

test("task frontmatter parses block prompts and only BASE_URL is substituted", () => {
  const { data } = parseFrontmatter(
    ["---", "id: t9", "prompt: |", "  Open {{BASE_URL}}/docs/", "  Report the titles.", "requiresLogin: false", "timeoutMs: 1234", "---", "body"].join("\n"),
  );
  assert.equal(data.id, "t9");
  assert.equal(data.requiresLogin, false);
  assert.equal(data.timeoutMs, 1234);
  assert.equal(data.prompt, "Open {{BASE_URL}}/docs/\nReport the titles.");

  const prompt = resolvePrompt({ prompt: data.prompt }, "http://127.0.0.1:9");
  assert.equal(prompt, "Open http://127.0.0.1:9/docs/\nReport the titles.");
});

// --- graders ---------------------------------------------------------------

const { grade: gradeT3 } = await import("../bench/tasks/t3-compile.grader.mjs");
const { grade: gradeT4 } = await import("../bench/tasks/t4-form.grader.mjs");
const { T3_EXPECTED_SLUGS, T4_VALUES } = await import("../bench/fixture/server.mjs");

test("T3 grades as a set and rejects the naive-grep answer", () => {
  const expected = { slugs: T3_EXPECTED_SLUGS };
  const urls = (slugs) => slugs.map((s) => `Title — http://x/docs/${s}`).join("\n");

  assert.equal(gradeT3(urls(T3_EXPECTED_SLUGS), expected).pass, true);
  // Order must not matter.
  assert.equal(gradeT3(urls([...T3_EXPECTED_SLUGS].reverse()), expected).pass, true);
  // The two traps: mentioned only in a code block, and only as a substring.
  const greppy = gradeT3(urls([...T3_EXPECTED_SLUGS, "api-reference", "caching"]), expected);
  assert.equal(greppy.pass, false);
  assert.match(greppy.detail, /extra=\[api-reference,caching\]/);
  // Incomplete fails.
  assert.equal(gradeT3(urls(T3_EXPECTED_SLUGS.slice(0, 1)), expected).pass, false);
});

test("T4 grades what the SERVER received, not what the agent claims", () => {
  const truth = (submissions) => ({ submissions, expected: T4_VALUES });
  const good = [{ fields: { ...T4_VALUES }, code: "GRZ-1000" }];

  assert.equal(gradeT4("Confirmation: GRZ-1000", truth(good)).pass, true);
  // Claiming success without the code fails: it proves nothing was read back.
  assert.equal(gradeT4("Submitted!", truth(good)).pass, false);
  // Nothing arrived, however confident the answer.
  assert.equal(gradeT4("All done, code GRZ-1000", truth([])).pass, false);
  // A retry loop that eventually gets it right has still spammed the endpoint.
  assert.match(
    gradeT4("GRZ-1001", truth([...good, { fields: { ...T4_VALUES }, code: "GRZ-1001" }])).detail,
    /2 submissions/,
  );
  // The radio group is where "click near enough" quietly fails.
  const wrongRadio = [{ fields: { ...T4_VALUES, referral: "search" }, code: "GRZ-1000" }];
  assert.match(gradeT4("GRZ-1000", truth(wrongRadio)).detail, /referral/);
});

// --- fixture ----------------------------------------------------------------

test("the fixture serves what the graders expect", async (t) => {
  const { startBenchFixture } = await import("../bench/fixture/server.mjs");
  const fixture = await startBenchFixture({ nonce: "unit" });
  t.after(() => fixture.close());

  const get = async (path) => {
    const response = await fetch(`${fixture.origin}${path}`);
    return { status: response.status, body: await response.text() };
  };

  assert.equal((await get("/healthz")).status, 200);

  // Every expected page must link from the index, or T3 is ungradeable.
  const index = await get("/docs/");
  for (const slug of T3_EXPECTED_SLUGS) {
    assert.match(index.body, new RegExp(`/docs/${slug}`), `index links ${slug}`);
  }

  // The two traps must really contain the term in the form the task excludes,
  // otherwise the naive-grep answer would accidentally be correct.
  assert.match((await get("/docs/api-reference")).body, /<pre>[\s\S]*recipe/);
  assert.match((await get("/docs/caching")).body, /Prerecipes/);

  // T4: a real submission is recorded server-side and echoes its code.
  const body = new URLSearchParams(T4_VALUES).toString();
  const submitted = await fetch(`${fixture.origin}/apply`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const html = await submitted.text();
  const code = /id="code">([^<]+)</.exec(html)?.[1];
  assert.ok(code, "the confirmation page shows a code");

  const recorded = fixture.submissions();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].code, code, "the page shows the code the server recorded");
  assert.equal(recorded[0].fields.referral, T4_VALUES.referral);

  // And the grader passes against that real round trip.
  const truth = { submissions: recorded, expected: T4_VALUES };
  assert.equal(gradeT4(`Confirmation code: ${code}`, truth).pass, true);
});

// --- T1/T2 graders (site pending, comparison logic complete) ----------------

const t1 = await import("../bench/tasks/t1-orders.grader.mjs");
const t2 = await import("../bench/tasks/t2-dashboard.grader.mjs");

test("T1/T2 ground truth refuses to invent a placeholder while the site is undecided", async () => {
  // A pending grader must FAIL LOUDLY, not return something plausible that lets
  // a run report a green cell against nothing.
  assert.equal(t1.pending, true);
  assert.equal(t2.pending, true);
  await assert.rejects(() => t1.groundTruth({}), /pending/i);
  await assert.rejects(() => t2.groundTruth({}), /pending/i);
});

test("T1 grades order numbers as an ORDERED sequence", () => {
  const expected = { orders: ["A-10029", "A-10024", "A-10011"] };
  assert.equal(t1.grade("Newest first: A-10029, A-10024, A-10011", expected).pass, true);
  // Prose around them is fine.
  assert.equal(
    t1.grade("The three most recent are order A-10029, then A-10024, and finally A-10011.", expected).pass,
    true,
  );
  // Right set, wrong order — "newest first" was part of the task.
  const reversed = t1.grade("A-10011, A-10024, A-10029", expected);
  assert.equal(reversed.pass, false);
  assert.match(reversed.detail, /wrong sequence/);
  // Missing one fails.
  assert.equal(t1.grade("A-10029 and A-10024", expected).pass, false);
});

test("T2 finds CSV inside prose or fences and compares rows exactly", () => {
  const rows = [
    ["Date", "Description", "Amount"],
    ["2026-01-02", "Widget, large", "10.00"],
    ["2026-01-03", "Gadget", "4.50"],
  ];
  const expected = { rows };
  const answer = [
    "Here is the export:",
    "```csv",
    "Date,Description,Amount",
    '2026-01-02,"Widget, large",10.00',
    "2026-01-03,Gadget,4.50",
    "```",
  ].join("\n");
  assert.equal(t2.grade(answer, expected).pass, true, t2.grade(answer, expected).detail);

  // A quoted comma must survive: splitting naively would shift every column.
  assert.deepEqual(t2.splitCsvLine('2026-01-02,"Widget, large",10.00'), [
    "2026-01-02", "Widget, large", "10.00",
  ]);

  // A dropped row fails, and says which count was wrong.
  const short = t2.grade("Date,Description,Amount\n2026-01-03,Gadget,4.50", expected);
  assert.equal(short.pass, false);
  assert.match(short.detail, /expected 2 data rows, got 1/);

  // A wrong cell names the row and column rather than just "mismatch".
  const wrong = t2.grade("Date,Description,Amount\n2026-01-02,\"Widget, large\",10.00\n2026-01-03,Gadget,9.99", expected);
  assert.match(wrong.detail, /row 2 column "Amount"/);

  // No CSV at all is a distinct, nameable failure.
  assert.match(t2.grade("I could not find the table.", expected).detail, /no CSV/);
});

// --- spawning ---------------------------------------------------------------

test("processes spawn without a shell, so a path with spaces works", async () => {
  const { runProcess } = await import("../bench/lib/spawn.mjs");

  // The regression: process.execPath is C:\Program Files\nodejs\node.exe.
  // With shell:true, cmd split it at the space and every browser start failed
  // with a bare "grazer browser start failed".
  assert.match(process.execPath, /node(\.exe)?$/i);
  const ok = await runProcess(process.execPath, ["-e", "process.stdout.write('hi')"], { timeoutMs: 30_000 });
  assert.equal(ok.ok, true, `spawn failed: ${ok.stderr}`);
  assert.equal(ok.stdout, "hi");

  // A non-zero exit is reported with its code and its stderr, not swallowed.
  const failed = await runProcess(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], { timeoutMs: 30_000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /boom/);

  // A missing executable explains itself rather than failing obscurely.
  const missing = await runProcess("definitely-not-a-real-binary-xyz", [], { timeoutMs: 10_000 });
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /not found on PATH/);
});

test("no benchmark code uses a shell to spawn", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { BENCH_ROOT } = await import("../bench/lib/paths.mjs");

  // A shell would re-parse argv, and every task prompt is arbitrary text: one
  // containing a quote, & or | would break the command or inject into it.
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(path)));
      else if (entry.name.endsWith(".mjs")) out.push(path);
    }
    return out;
  };
  for (const file of await walk(BENCH_ROOT)) {
    const source = await readFile(file, "utf8");
    const offending = source
      .split(/\r?\n/)
      .filter((line) => /shell:\s*true/.test(line) && !line.trim().startsWith("*"));
    assert.deepEqual(offending, [], `${file} spawns with a shell`);
  }
});

test("the rendered report never lets a failed rep improve a driver's numbers", () => {
  // The regression that matters most and would be invisible: a driver that
  // crashes in 0.9s alongside a 41.2s success must render 41.2, not ~21.
  const out = renderReport([
    { task: "t3", driver: "grazer", rep: 1, success: true, wallMs: 41200, totalTokens: 37044, costUsd: 0.12, numTurns: 7, model: "m" },
    { task: "t3", driver: "grazer", rep: 2, success: false, wallMs: 900, totalTokens: 105, costUsd: 0.001, numTurns: 1, graderDetail: "missing a page", model: "m" },
  ]);
  assert.match(out, /\| t3 \| grazer \| 1\/2 \| 41\.2 \|/, "median is the passing rep alone");
  assert.doesNotMatch(out, /\| 21\.\d \|/, "the crash must not pull the median down");
  assert.match(out, /missing a page/, "the failure is listed with its reason");
});

test("loadTask reads the real task files on disk", async () => {
  const { listTaskIds, loadTask, resolvePrompt } = await import("../bench/lib/tasks.mjs");

  // T1/T2 have graders but no .md yet, so they must not appear as runnable.
  const ids = await listTaskIds();
  assert.deepEqual(ids, ["t3-compile", "t4-form"]);

  for (const id of ids) {
    const task = await loadTask(id);
    assert.equal(typeof task.grader.grade, "function");
    assert.equal(typeof task.grader.groundTruth, "function");
    assert.ok(task.prompt.includes("{{BASE_URL}}"), `${id} must template its origin`);
    assert.ok(task.timeoutMs > 0);
    // The substitution must actually happen, or the agent gets a literal token.
    const prompt = resolvePrompt(task, "http://127.0.0.1:1234");
    assert.doesNotMatch(prompt, /\{\{BASE_URL\}\}/);
    assert.match(prompt, /http:\/\/127\.0\.0\.1:1234/);
  }
});

test("no driver can reach a page without its browser", async () => {
  const { grazerDriver, playwrightDriver, chromeDriver } = await import("../bench/drivers/index.mjs");
  const ctx = { rep: 1, prompt: "p", model: null, budgetUsd: 5 };
  const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

  const argvs = {
    grazer: grazerDriver.argv({}, ctx, { spaceName: "s" }),
    playwright: playwrightDriver.argv({}, ctx, { config: "c" }),
    chrome: chromeDriver.argv({}, ctx, { config: "c" }),
  };

  for (const [name, argv] of Object.entries(argvs)) {
    // Every driver is denied the tools that retrieve a URL outside a browser,
    // or the comparison measures who was allowed to skip browsing.
    const denied = after(argv, "--disallowed-tools");
    assert.match(denied, /WebFetch/, `${name} must deny WebFetch`);
    assert.match(denied, /WebSearch/, `${name} must deny WebSearch`);
  }

  // The grazer driver must never hold plain Bash: that would let it retrieve
  // the pages from the shell while the MCP drivers are confined to a browser.
  const allowed = after(argvs.grazer, "--allowed-tools");
  assert.doesNotMatch(allowed, /(^|\s)Bash(\s|$)/, "plain Bash is a fairness hole");
  assert.match(allowed, /Bash\(node bin\/grazer\.mjs \*\)/, "scoped to the Grazer CLI");
  // The separator is a space, not a colon — `claude --help` shows "Bash(git *)".
  // The colon form would match nothing and silently grant nothing.
  assert.doesNotMatch(allowed, /Bash\([^)]*:/, "colon is not the pattern separator");
});

test("the grazer driver puts bin/ on the agent's PATH so `grazer` resolves", async (t) => {
  const { grazerDriver } = await import("../bench/drivers/index.mjs");
  const { runProcess } = await import("../bench/lib/spawn.mjs");
  const { delimiter, join } = await import("node:path");
  const { PACKAGE_ROOT } = await import("../bench/lib/paths.mjs");

  // SKILL.md documents the call as `grazer nodejs <<EOF` and the agent is told
  // to read it. If `grazer` does not resolve, the agent under test fights its
  // own instructions and burns turns discovering `node bin/grazer.mjs` — a cost
  // that measures our packaging rather than our transport.
  const env = { ...process.env, PATH: [join(PACKAGE_ROOT, "bin"), process.env.PATH].join(delimiter) };
  const resolved = await runProcess("grazer", ["--version"], { env, timeoutMs: 30_000 });
  assert.equal(resolved.ok, true, `grazer did not resolve: ${resolved.stderr}`);

  // And the driver actually builds such an env, rather than the test proving
  // only that the idea works.
  const state = { home: "H", env: undefined };
  const built = grazerDriver.env({ env: env });
  assert.ok(built.PATH.startsWith(join(PACKAGE_ROOT, "bin")), "bin/ must come first");
  void state;
  void t;
});

test("withBinOnPath rewrites the EXISTING key, whatever its case", async () => {
  const { withBinOnPath } = await import("../bench/drivers/index.mjs");
  const { delimiter, join } = await import("node:path");
  const { PACKAGE_ROOT } = await import("../bench/lib/paths.mjs");
  const BIN = join(PACKAGE_ROOT, "bin");

  // The Task Scheduler hands the environment over as "Path". process.env is
  // case-insensitive but a spread copy of it is a plain object and is NOT, so
  // writing env.PATH there ADDS a second key; Windows keeps one, the agent's
  // whole PATH collapses to bin/, and claude fails ENOENT in ~1ms. That is
  // exactly how bench run 3 died, and this test is the reason it cannot recur.
  const scheduler = withBinOnPath({ Path: "C:\windows;C:\windows\system32", GRAZER_HOME: "H" });
  assert.equal("PATH" in scheduler, false, "must not add a second key");
  assert.equal(scheduler.Path.split(delimiter)[0], BIN, "bin/ leads");
  assert.match(scheduler.Path, /system32/, "the original entries survive");
  assert.equal(scheduler.GRAZER_HOME, "H", "other keys untouched");

  const upper = withBinOnPath({ PATH: "C:\windows" });
  assert.equal("Path" in upper, false);
  assert.equal(upper.PATH.split(delimiter)[0], BIN);

  // No path variable at all: create one rather than silently doing nothing.
  const none = withBinOnPath({ GRAZER_HOME: "H" });
  assert.equal(none.PATH, BIN);
});

test("a failed cell explains itself", async () => {
  const { stderrHint, tailOf } = await import("../bench/run.mjs");

  // Run 3 recorded only "no JSON object in stdout" with exitCode null, so an
  // ENOENT that took a millisecond looked the same as a bad answer.
  assert.equal(tailOf(""), null, "empty stays null, not an empty string");
  assert.equal(tailOf("  short  "), "short");
  const long = "x".repeat(900);
  const tail = tailOf(long, 100);
  assert.equal(tail.length, 101, "truncated with an ellipsis marker");
  assert.ok(tail.startsWith("…"));

  assert.equal(stderrHint(null), "", "nothing to say adds nothing");
  const hint = stderrHint("line one\nline two\nspawn claude failed: ENOENT");
  assert.match(hint, /spawn claude failed: ENOENT/);
  assert.match(hint, /^\n {5}stderr: /, "indented onto its own line");
  assert.equal(hint.split("\n").length, 2, "stays one extra console line");
});

test("a prepare() failure costs one cell, not the whole matrix", async (t) => {
  const { runOne } = await import("../bench/run.mjs");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const outDir = await mkdtemp(join(tmpdir(), "bench-prepare-fail-"));
  t.after(() => cleanHome(outDir));

  // prepare() used to run outside the recorded path, so a failure here threw
  // past the record writer: no file for the cell and every remaining cell
  // abandoned. Run 2 died exactly this way.
  const driver = {
    id: "broken",
    prepare: async () => { throw new Error("browser start failed twice — exit 3: DevToolsActivePort"); },
    argv: () => [],
    env: () => ({}),
    teardown: async () => {},
  };
  const task = { id: "t-x", timeoutMs: 1000, grader: { groundTruth: async () => ({}), grade: () => ({ pass: true, detail: "" }) } };

  const record = await runOne({ task, driver, ctx: { rep: 1, model: null }, outDir });

  assert.equal(record.success, false);
  assert.match(record.graderDetail, /driver\.prepare failed/);
  assert.match(record.graderDetail, /DevToolsActivePort/, "the real reason survives");
  assert.equal(record.totalTokens, null, "absent is null, not zero");

  // And it is on disk, so the cell is accounted for rather than missing.
  const written = JSON.parse(await readFile(join(outDir, "t-x-broken-1.json"), "utf8"));
  assert.equal(written.rep, 1);
  assert.match(written.stderrTail, /browser start failed twice/);
});

test("T3 never reads an exclusion as a claim (the pilot's grader defect)", async () => {
  const { grade } = await import("../bench/tasks/t3-compile.grader.mjs");
  const want = { slugs: ["getting-started", "recipes-overview", "scheduling"] };
  const contract = [
    "Getting started — http://x/docs/getting-started",
    "Recipes overview — http://x/docs/recipes-overview",
    "Scheduling — http://x/docs/scheduling",
  ].join("\n");

  assert.equal(grade(contract, want).pass, true);

  // Run 4's real shape: a correct answer whose prose ALSO names the pages it
  // ruled out. The old grader scraped that row and scored the answer wrong.
  const withExclusions = [
    contract,
    "",
    "| Configuration, Troubleshooting, Migration | — | no occurrence |",
    "See http://x/docs/troubleshooting for the full text.",
  ].join("\n");
  assert.equal(grade(withExclusions, want).pass, true, "an exclusion is not a claim");

  // A table-only answer breaks the stated contract and fails for every driver
  // equally — that is the cost of the format rule, and it is symmetric.
  const tableOnly = grade("| Getting started | http://x/docs/getting-started | yes |", want);
  assert.equal(tableOnly.pass, false);
  assert.match(tableOnly.detail, /required answer format/);
});
