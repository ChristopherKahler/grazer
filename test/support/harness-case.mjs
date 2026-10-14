/**
 * Run the harness's OWN real-browser case bodies through `grazer nodejs`.
 *
 * The case bodies are source strings that expect a set of globals the harness's
 * runner injects (`taskName`, `baseUrl`, `assert*`, `resetHome`, ...). This
 * module rebuilds that environment the way `grazer-source.mjs` does and pipes
 * the result into our CLI.
 *
 * It deliberately does NOT use `scripts/real-browser-e2e/runner.mjs`: that
 * spawns `grazer` without a shell, which cannot find an npm `.cmd` shim on
 * Windows (deferred to lynx). Everything else — the preamble, the fixture
 * server, the case bodies — is imported from the harness unchanged, so these
 * tests fail if Grazer drifts from what the harness actually expects.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_ROOT } from "./harness-bundle.mjs";

const HARNESS_E2E_DIR = join(
  PACKAGE_ROOT,
  "packages",
  "harness",
  "scripts",
  "real-browser-e2e",
);
const CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");

/** The harness's assertion helpers and `resetHome`, concatenated as-is. */
async function readPreamble() {
  return readFile(join(HARNESS_E2E_DIR, "preamble.mjs"), "utf8");
}

/**
 * Rebuild `grazerSource`'s output.
 *
 * Kept structurally identical to `scripts/real-browser-e2e/grazer-source.mjs`,
 * including the case-result file, because that file is how a case reports its
 * assertion count and its own failure message.
 */
export async function buildCaseSource(body, context) {
  const preamble = await readPreamble();
  const constant = (name) => `const ${name} = ${JSON.stringify(context[name] ?? null)};`;
  return `
    ${preamble}

    const verboseAssertions = false;

    ${[
      "taskName",
      "baseUrl",
      "artifactDir",
      "tempDir",
      "uploadPath",
      "uploadPathTwo",
      "explicitScreenshotPath",
      "environmentScreenshotPath",
      "metadataPath",
    ]
      .map(constant)
      .join("\n    ")}
    const keepTaskSpace = false;

    try {
      ${body}
      console.log(JSON.stringify({ ok: true, assertions: __assertionCount }));
      await writeFile(join(tempDir, "case-result.json"), JSON.stringify({ ok: true, assertions: __assertionCount }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, assertions: __assertionCount, error: error.message }));
      await writeFile(join(tempDir, "case-result.json"), JSON.stringify({ ok: false, assertions: __assertionCount, error: error.message })).catch(() => {});
      throw error;
    }
  `;
}

/** Spawn the Grazer CLI with a script on stdin. */
export function runCli(args, { input, env = {}, timeoutMs = 90_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: null, stdout, stderr, timedOut: true, all: `${stdout}\n${stderr}` });
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout,
        stderr,
        timedOut: false,
        all: `${stdout}\n${stderr}`,
      });
    });
    child.stdin.end(input ?? "");
  });
}

/**
 * Set up everything a case body expects: the harness's fixture server, a temp
 * dir with the upload fixtures, and the metadata file.
 */
export async function startCaseEnvironment({ grazerHome, browserPath }) {
  const { closeFixtureServer, startFixtureServer } = await import(
    `file://${join(HARNESS_E2E_DIR, "fixture.mjs").replace(/\\/g, "/")}`
  );

  const tempDir = await mkdtemp(join(tmpdir(), "grazer-harness-case-"));
  const artifactDir = join(tempDir, "artifacts");
  const uploadPath = join(tempDir, "fixture-upload.txt");
  const uploadPathTwo = join(tempDir, "fixture-upload-two.txt");
  const metadataPath = join(tempDir, "metadata.json");
  const taskName = `grazer harness case ${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(artifactDir, { recursive: true });
  await writeFile(uploadPath, "grazer upload fixture\n", "utf8");
  await writeFile(uploadPathTwo, "second upload fixture\n", "utf8");

  const fixture = await startFixtureServer(taskName);

  // The runner's own sanity check: a fixture answering for a DIFFERENT task
  // name means a stale server from an earlier run, and every case would then
  // assert against the wrong page.
  const health = await (await fetch(`${fixture.baseUrl}/healthz`)).json();
  if (health.taskName !== taskName || health.ok !== true) {
    throw new Error(`fixture health payload mismatch: ${JSON.stringify(health)}`);
  }

  await writeFile(
    metadataPath,
    JSON.stringify(
      { baseUrl: fixture.baseUrl, taskName, tempDir, artifactDir, startedAt: new Date().toISOString() },
      null,
      2,
    ),
    "utf8",
  );

  const context = {
    taskName,
    baseUrl: fixture.baseUrl,
    artifactDir,
    tempDir,
    uploadPath,
    uploadPathTwo,
    explicitScreenshotPath: join(artifactDir, "explicit-shot.png"),
    environmentScreenshotPath: join(artifactDir, "environment-shot.png"),
    metadataPath,
  };

  const env = { GRAZER_HOME: grazerHome, GRAZER_BROWSER: browserPath };

  return {
    context,
    env,
    async close() {
      await closeFixtureServer(fixture.server).catch(() => {});
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** What a case reported, from its result file — falling back to stdout. */
async function readCaseResult(tempDir, stdout) {
  try {
    const parsed = JSON.parse(
      await readFile(join(tempDir, "case-result.json"), "utf8"),
    );
    return {
      ok: parsed.ok === true,
      assertions: typeof parsed.assertions === "number" ? parsed.assertions : 0,
      error: parsed.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      assertions: 0,
      error: `case-result.json was not written or readable; grazer nodejs may have exited without executing stdin (${error?.message || error}). stdout was:\n${stdout}`,
    };
  }
}

/** Run one case body end to end and report what it asserted. */
export async function runHarnessCase(body, { context, env, timeoutMs = 120_000 }) {
  await rm(join(context.tempDir, "case-result.json"), { force: true });
  const source = await buildCaseSource(body, context);
  const run = await runCli(["nodejs"], { input: source, env, timeoutMs });
  const result = await readCaseResult(context.tempDir, run.stdout);
  return { ...result, run };
}

export { HARNESS_E2E_DIR, CLI };
export const SUPPORT_DIR = dirname(fileURLToPath(import.meta.url));
