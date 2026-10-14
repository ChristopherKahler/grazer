#!/usr/bin/env node
/**
 * The Grazer CLI — the one command agents run.
 *
 *   grazer nodejs <<'EOF'      run a heredoc against the companion browser
 *   grazer browser start       start the companion browser
 *   grazer browser status      is it up, and what is it
 *   grazer browser stop        shut it down
 *
 * Plain argv parsing, no dependencies. Exit codes are a contract:
 *   0  ok
 *   1  the agent's script threw
 *   2  usage error
 *   3  environment problem (no browser running, harness bundle not built)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(BIN_DIR, "..");
const DIST = join(PACKAGE_ROOT, "dist");

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_ENVIRONMENT = 3;

const HELP = `grazer

Give your AI agent its own logged-in browser spaces.

Read the grazer skill for the default workflow and examples.

Typical usage:
  grazer nodejs <<'JS'
  await page.goto("https://example.com")
  console.log(await page.title())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.

Commands:
  grazer nodejs [--sdk-path P]      run a script against the companion browser
  grazer browser start [options]    start the companion browser
  grazer browser status             show the running browser
  grazer browser stop               shut the companion browser down
  grazer browser list               show the browsers found and the one in use
  grazer browser use <name|path>    pick the browser: chrome, brave, edge, chromium,
                                    vivaldi, or the path to any Chromium .exe
  grazer sync register              connect the Grazer Sync extension (all browsers)
  grazer sync status                show which browsers the extension can reach
  grazer sync unregister            disconnect the Grazer Sync extension
  grazer sync seed <space>          copy synced logins into a task space
  grazer space list                 show task spaces
  grazer space takeover <id>        take control of a task space from the agent
  grazer space handoff <id>         hand a task space back to the agent
  grazer space end <id>             end the task; the agent must claim to resume
  grazer space delete <id>|--all    dispose task spaces

browser start options:
  --headless                        run without a visible window (the default)
  --headed                          show a window, for a person to watch or take over
  --browser <path>                  browser executable (else GRAZER_BROWSER, else the
                                    one picked with grazer browser use, else auto)
  --profile <dir>                   profile directory (else <GRAZER_HOME>/profile)

Environment:
  GRAZER_HOME                       state directory (default %LOCALAPPDATA%\\Grazer)
  GRAZER_BROWSER                    browser executable to use (overrides browser use)
`;

const USAGE = `Usage:
  grazer nodejs <<'JS'
  console.log(await page.info())
  JS

  grazer browser start [--headless|--headed] [--browser <path>] [--profile <dir>]
  grazer browser status
  grazer browser stop
  grazer browser list
  grazer browser use <chrome|brave|edge|chromium|vivaldi|path-to-exe>
  grazer sync register|status|unregister [--browser chrome|brave|edge|chromium|all]
  grazer sync seed <spaceIdOrName> [--bundle <path>]
  grazer space list|takeover <id>|handoff <id>|end <id>|delete <id>|--all
`;

function fail(message, code = EXIT_USAGE) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

/** Load a compiled module, with a clear message when the build has not been run. */
async function loadDist(relativePath) {
  const file = join(DIST, relativePath);
  if (!existsSync(file)) {
    fail(
      `Grazer is not built. Run: npm run build\n  (missing ${file})`,
      EXIT_ENVIRONMENT,
    );
    return null;
  }
  return import(`file://${file.replace(/\\/g, "/")}`);
}

async function browserCommand(argv) {
  const sub = argv[0];

  if (sub === "list" || sub === "use") {
    const browsers = await loadDist("companion/browsers.js");
    if (!browsers) return;
    if (sub === "use") {
      if (argv.length !== 2) return fail(`grazer browser use takes one browser name or path\n\n${USAGE}`);
      try {
        const executable = browsers.useBrowser(argv[1]);
        process.stdout.write(`Grazer will use ${executable}\n`);
        if (process.env.GRAZER_BROWSER) {
          process.stdout.write(
            `Note: GRAZER_BROWSER is set (${process.env.GRAZER_BROWSER}) and still takes priority.\n`,
          );
        }
        process.exitCode = EXIT_OK;
      } catch (error) {
        fail(error?.message || String(error), EXIT_ENVIRONMENT);
      }
      return;
    }
    if (argv.length > 1) return fail(`unknown option: ${argv[1]}\n\n${USAGE}`);
    let current = null;
    try {
      current = browsers.findBrowserExecutable();
    } catch {
      // Nothing usable yet; the list below still shows what was looked for.
    }
    for (const browser of browsers.detectBrowsers()) {
      const inUse = browser.found && current && browser.found.toLowerCase() === current.toLowerCase();
      const where = browser.found ?? "not found";
      process.stdout.write(`${inUse ? "*" : " "} ${browser.id.padEnd(9)} ${where}\n`);
    }
    if (current && !browsers.knownBrowserForPath(current)) {
      process.stdout.write(`* other     ${current}\n`);
    }
    process.stdout.write(current ? "\n* = the browser Grazer uses\n" : "\nNo browser found. Run: grazer browser use <path-to-exe>\n");
    process.exitCode = EXIT_OK;
    return;
  }

  const companion = await loadDist("companion/browser.js");
  if (!companion) return;

  if (sub === "start") {
    const options = {};
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--headless") options.headless = true;
      else if (arg === "--headed") options.headless = false;
      else if (arg === "--browser") options.executable = argv[++i];
      else if (arg === "--profile") options.profileDir = argv[++i];
      else return fail(`unknown option for browser start: ${arg}\n\n${USAGE}`);
    }
    try {
      const { state, alreadyRunning, product } =
        await companion.startBrowser(options);
      process.stdout.write(
        `${alreadyRunning ? "already running" : "started"} ${product} on port ${state.port} (pid ${state.pid})\n`,
      );
      process.exitCode = EXIT_OK;
    } catch (error) {
      fail(error?.message || String(error), EXIT_ENVIRONMENT);
    }
    return;
  }

  if (sub === "status") {
    if (argv.length > 1) return fail(`unknown option: ${argv[1]}\n\n${USAGE}`);
    const status = await companion.browserStatus();
    if (!status.running) {
      // "not running" is an answer, but a non-zero code is what a script checks.
      process.stderr.write("Grazer browser is not running.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `${status.product} on port ${status.state.port} (pid ${status.state.pid})\n`,
    );
    process.exitCode = EXIT_OK;
    return;
  }

  if (sub === "stop") {
    if (argv.length > 1) return fail(`unknown option: ${argv[1]}\n\n${USAGE}`);
    const { stopped, wasRunning } = await companion.stopBrowser();
    if (!stopped) {
      process.stderr.write("Grazer browser is not running.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(wasRunning ? "stopped\n" : "cleared stale state\n");
    process.exitCode = EXIT_OK;
    return;
  }

  fail(`unknown browser command: ${sub ?? "(none)"}\n\n${USAGE}`);
}

/**
 * `grazer sync ...` runs the Grazer Sync scripts that sit next to this file:
 * register/status/unregister go to grazer-sync.mjs (all four browsers unless
 * --browser says otherwise), seed goes to grazer-replay.mjs.
 */
async function syncCommand(argv) {
  const sub = argv[0];
  let script;
  let args;
  if (sub === "register" || sub === "status" || sub === "unregister") {
    script = join(BIN_DIR, "grazer-sync.mjs");
    const named = argv.some((arg) => arg === "--browser" || arg.startsWith("--browser="));
    args = named ? argv : [...argv, "--browser", "all"];
  } else if (sub === "seed") {
    if (argv.length < 2) return fail(`grazer sync seed needs a task space id or name\n\n${USAGE}`);
    script = join(BIN_DIR, "grazer-replay.mjs");
    args = argv.slice(1);
  } else {
    return fail(`unknown sync command: ${sub ?? "(none)"}\n\n${USAGE}`);
  }

  const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise((resolvePromise) => {
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolvePromise(EXIT_ENVIRONMENT);
    });
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}

async function spaceCommand(argv) {
  const cli = await loadDist("companion/spaces-cli.js");
  if (!cli) return;
  const result = await cli.runSpacesCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

/** Read everything on stdin. Returns "" for a closed or TTY stdin. */
function readStdin() {
  return new Promise((resolvePromise) => {
    if (process.stdin.isTTY) {
      resolvePromise("");
      return;
    }
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolvePromise(""));
  });
}

async function nodejsCommand(argv) {
  const hostPath = join(DIST, "host", "host.js");
  if (!existsSync(hostPath)) {
    return fail(
      `Grazer is not built. Run: npm run build\n  (missing ${hostPath})`,
      EXIT_ENVIRONMENT,
    );
  }
  for (const arg of argv) {
    if (arg !== "--sdk-path" && arg.startsWith("--") && arg !== "--help") {
      // The harness's e2e runner keys off this exact wording when a build is
      // too old to understand --sdk-path, so keep the option name in the text.
      return fail(`unknown option ${arg} for grazer nodejs\n\n${USAGE}`);
    }
  }

  const code = await readStdin();
  if (!code.trim()) {
    return fail(USAGE);
  }

  // A fresh host process per heredoc: installGrazerSdk overrides console.log and
  // installs process-lifecycle flush hooks, which are only safe per-run.
  const child = spawn(process.execPath, [hostPath, ...argv], {
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  child.stdin.end(code);

  const exitCode = await new Promise((resolvePromise) => {
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolvePromise(EXIT_ENVIRONMENT);
    });
    child.once("exit", (childCode, signal) => {
      if (childCode === null) {
        process.stderr.write(`grazer nodejs terminated by signal ${signal}\n`);
        resolvePromise(1);
        return;
      }
      resolvePromise(childCode);
    });
  });
  process.exitCode = exitCode;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    process.exitCode = command ? EXIT_OK : EXIT_USAGE;
    return;
  }
  if (command === "--version" || command === "-v") {
    // Read, not import: a JSON import prints an experimental warning on Node 22.
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (command === "browser") return browserCommand(argv.slice(1));
  if (command === "space") return spaceCommand(argv.slice(1));
  if (command === "sync") return syncCommand(argv.slice(1));
  if (command === "nodejs") return nodejsCommand(argv.slice(1));

  fail(`unknown command: ${command}\n\n${USAGE}`);
}

await main();
