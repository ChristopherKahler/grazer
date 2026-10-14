/**
 * The three drivers, behind one interface.
 *
 * A driver decides only two things: what browser state the agent starts with,
 * and which tools it may use. Everything else — the prompt, the grader, the
 * metrics — is identical across drivers, or the benchmark measures the harness
 * rather than the driver.
 *
 * Interface:
 *   id
 *   available()            -> { ok, reason }   why this driver can't run here
 *   prepare(ctx)           -> state            fresh browser state for one rep
 *   argv(task, ctx, state) -> string[]         the exact claude arguments
 *   teardown(state)                            always runs, even on failure
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { PACKAGE_ROOT } from "../lib/paths.mjs";
import { runProcess } from "../lib/spawn.mjs";

/**
 * Tools that can retrieve a URL without a browser. Denied for EVERY driver, so
 * the three differ only in how they drive the browser — never in whether they
 * can skip it. Space-separated per `claude --help`.
 */
const DENIED_FETCH_TOOLS = "WebFetch WebSearch";

/**
 * The grazer driver's shell grant.
 *
 * Deliberately NOT plain "Bash": that would let the agent curl the pages and
 * never open a browser, while the MCP drivers are confined to their browser
 * tools — a comparison that flatters us for a reason unrelated to Grazer.
 *
 * The pattern separator is a SPACE, not a colon (`claude --help`: "Bash(git *)").
 * `grazer` is not on PATH in a bench environment, so the node form is the one
 * that matters; the bare form is granted too in case the launcher is installed.
 */
const GRAZER_SHELL_TOOLS = "Bash(node bin/grazer.mjs *) Bash(grazer *) Read";

/** Flags every driver shares. Differences below are only tools and preamble. */
export function baseArgv({ prompt, model, budgetUsd }) {
  const argv = [
    "--print", prompt,
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--no-session-persistence",
    // Without this the runner machine's own MCP servers leak into the run and
    // every driver silently gains tools it was never granted.
    "--strict-mcp-config",
    "--setting-sources", "project",
    // Fairness, enforced rather than requested: no driver may reach a page
    // except through its browser. Without this the shell-based driver could
    // fetch the pages directly and "win" a browsing benchmark without browsing.
    "--disallowed-tools", DENIED_FETCH_TOOLS,
  ];
  if (model) argv.push("--model", model);
  if (budgetUsd) argv.push("--max-budget-usd", String(budgetUsd));
  return argv;
}

/**
 * Run a helper process, returning the full result.
 *
 * Never with a shell, and stderr is kept: a failed browser start must be able
 * to say WHY, not just "failed".
 */
function run(command, args, options = {}) {
  return runProcess(command, args, options);
}

// ---------------------------------------------------------------------------
// grazer
// ---------------------------------------------------------------------------

const GRAZER_CLI = join(PACKAGE_ROOT, "bin", "grazer.mjs");
const BIN_DIR = join(PACKAGE_ROOT, "bin");

/**
 * bin/ first on the agent's PATH so `grazer` resolves to grazer.exe.
 *
 * skills/grazer/SKILL.md documents the call as `grazer nodejs <<EOF`, and the
 * agent is told to read that skill. Without this the agent under test follows
 * its own instructions, gets "not recognized", and burns turns and tokens
 * discovering the `node bin/grazer.mjs` form — a cost that measures our
 * packaging, not our transport. Same approach as test/support/harness-runner.mjs.
 *
 * The key lookup is case-insensitive, and that is load-bearing on Windows.
 * `process.env` is case-insensitive, but a spread copy of it is a plain object
 * and is NOT. The Task Scheduler hands the environment over as `Path`, so
 * `env.PATH` reads undefined, a naive write ADDS a second key beside the real
 * one, Windows keeps only one of them, and the agent's whole PATH collapses to
 * bin/ — `claude` then fails ENOENT in about a millisecond. That is exactly how
 * bench run 3 died.
 */
export function withBinOnPath(env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const existing = env[key] ?? "";
  return { ...env, [key]: [BIN_DIR, existing].filter(Boolean).join(delimiter) };
}

export const grazerDriver = {
  id: "grazer",

  available() {
    return existsSync(GRAZER_CLI)
      ? { ok: true }
      : { ok: false, reason: `missing ${GRAZER_CLI}` };
  },

  /**
   * A fresh task space per rep, in a browser this driver owns.
   *
   * Spaces are isolated browser contexts, so "fresh state" costs a context
   * rather than a profile copy — which is the thing being measured, and is why
   * the other two drivers have to copy a directory instead.
   */
  async prepare(ctx) {
    // One retry, on a fresh home. A cold headless start has been measured
    // overrunning the product's 15s DevToolsActivePort window on this machine
    // while a warm one takes ~2s; that timeout lives in src/companion/browser.ts
    // and is not the benchmark's to change. prepare() is outside the measured
    // window, so retrying here costs no fidelity — and the first failure is
    // logged verbatim rather than swallowed, so a REAL breakage is still visible.
    const attempts = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const home = await mkdtemp(join(tmpdir(), "grazer-bench-home-"));
      const env = withBinOnPath({ ...process.env, GRAZER_HOME: home });
      const started = await run(
        process.execPath,
        [GRAZER_CLI, "browser", "start", "--headless"],
        { env, timeoutMs: 60_000 },
      );
      if (started.ok) {
        if (attempts.length > 0) {
          console.warn(`   (browser start succeeded on attempt ${attempt}; first failure: ${attempts[0]})`);
        }
        return { home, env, spaceName: `bench-${ctx.rep}-${Date.now()}` };
      }
      attempts.push(
        `exit ${started.code}: ${(started.stderr || started.stdout || "no output").trim()}`,
      );
      await rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
    throw new Error(`grazer browser start failed twice — ${attempts.join(" | ")}`);
  },

  argv(task, ctx, state) {
    return [
      ...baseArgv(ctx),
      "--allowed-tools", GRAZER_SHELL_TOOLS,
      "--add-dir", join(PACKAGE_ROOT, "skills", "grazer"),
      "--append-system-prompt",
      [
        "Drive the browser with `grazer nodejs` heredocs, run from this repository.",
        `Work inside the task space named "${state.spaceName}": begin with`,
        `await taskSpaces.useOrCreate("${state.spaceName}").`,
        "Read skills/grazer/SKILL.md before your first browser command.",
      ].join(" "),
    ];
  },

  env(state) {
    return state.env;
  },

  async teardown(state) {
    if (!state?.home) return;
    await run(process.execPath, [GRAZER_CLI, "browser", "stop"], { env: state.env });
    await rm(state.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// playwright-mcp
// ---------------------------------------------------------------------------

export const playwrightDriver = {
  id: "playwright-mcp",

  available() {
    // Resolved at run time by npx; there is nothing to check here that would
    // not be a lie until the first run.
    return { ok: true, reason: "resolved by npx at run time" };
  },

  async prepare() {
    const profile = await mkdtemp(join(tmpdir(), "grazer-bench-pw-"));
    const config = join(profile, "mcp.json");
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          playwright: {
            command: "npx",
            args: ["-y", "@playwright/mcp@latest", "--headless", "--user-data-dir", profile],
          },
        },
      }, null, 2),
      "utf8",
    );
    return { profile, config, env: { ...process.env } };
  },

  argv(task, ctx, state) {
    return [
      ...baseArgv(ctx),
      "--mcp-config", state.config,
      "--allowed-tools", "mcp__playwright",
      "--append-system-prompt", "Drive the browser with the Playwright MCP tools.",
    ];
  },

  env(state) {
    return state.env;
  },

  async teardown(state) {
    if (!state?.profile) return;
    await rm(state.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  },
};

// ---------------------------------------------------------------------------
// claude-in-chrome
// ---------------------------------------------------------------------------

/**
 * This driver attaches to a Chrome the operator is already running with the
 * extension installed; it cannot provision that from here. `available()` says
 * so rather than pretending, and the runner records the cell as skipped with
 * the reason instead of writing a zero.
 */
export const chromeDriver = {
  id: "claude-in-chrome",

  available() {
    const config = process.env.GRAZER_BENCH_CHROME_MCP;
    if (!config) {
      return { ok: false, reason: "set GRAZER_BENCH_CHROME_MCP to an MCP config for the Chrome extension" };
    }
    if (!existsSync(config)) return { ok: false, reason: `missing ${config}` };
    return { ok: true };
  },

  async prepare() {
    return { config: process.env.GRAZER_BENCH_CHROME_MCP, env: { ...process.env } };
  },

  argv(task, ctx, state) {
    return [
      ...baseArgv(ctx),
      "--mcp-config", state.config,
      "--allowed-tools", "mcp__claude-in-chrome",
      "--append-system-prompt", "Drive the browser with the Chrome MCP tools.",
    ];
  },

  env(state) {
    return state.env;
  },

  async teardown() {},
};

export const DRIVERS = [grazerDriver, playwrightDriver, chromeDriver];

export function driverById(id) {
  const driver = DRIVERS.find((d) => d.id === id);
  if (!driver) throw new Error(`unknown driver: ${id} (have ${DRIVERS.map((d) => d.id).join(", ")})`);
  return driver;
}
