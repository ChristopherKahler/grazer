/**
 * The `grazer nodejs` host: one fresh process per heredoc.
 *
 * Order is the whole design here. `installGrazerSdk` runs as a side effect of
 * importing the harness bundle (index.ts:256-265, the non-CLI branch), and it
 * only wires `createTab` / the task-space methods and sets `grazer.helpers` if
 * `globalThis.grazer` **already exists** (index.ts:196-217). So:
 *
 *   1. connect to the companion browser
 *   2. `globalThis.grazer = createGrazerRuntime(connection)`
 *   3. THEN `await import(bundle)`
 *
 * Importing first would hand the agent a bundle with no browser behind it.
 *
 * The script runs as an AsyncFunction on the real `globalThis`, not under `vm`:
 * `installGrazerSdk` defines `page`, `browser`, `cdp` and friends as
 * non-enumerable globals, and the agent's code refers to them as free
 * identifiers, which only resolves against the real global object.
 *
 * A fresh process per heredoc is also why `process.exit()` is never called on
 * the success path: `installGrazerSdk` replaces `console.log` with a buffered
 * sink flushed from `beforeExit` / `exit` (output-sink.ts:100-114). Exiting
 * early would throw the agent's output away.
 *
 * Exit codes: 0 ok, 1 the script threw, 2 usage, 3 environment.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connect } from "../cdp/connection.js";
import { createGrazerRuntime } from "../grazer/runtime.js";
import { attachSnapshot, type SnapshotTarget } from "../snapshot/install.js";

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
/** dist/host -> dist -> the package root. Resolved from this file, never from cwd. */
const PACKAGE_ROOT = resolve(HOST_DIR, "..", "..");

const EXIT_SCRIPT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_ENVIRONMENT = 3;

const DEFAULT_SDK_PATH = join(
  PACKAGE_ROOT,
  "packages",
  "harness",
  "dist",
  "out",
  "index.js",
);

const USAGE = `Usage:
  grazer nodejs <<'JS'
  console.log(await page.info())
  JS
`;

interface HostArgs {
  sdkPath: string;
}

function parseArgs(argv: string[]): HostArgs | null {
  let sdkPath = DEFAULT_SDK_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sdk-path") {
      const value = argv[++i];
      if (!value) return null;
      sdkPath = resolve(value);
      continue;
    }
    return null;
  }
  return { sdkPath };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () =>
      resolvePromise(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", () => resolvePromise(""));
  });
}

/** The companion browser's descriptor, or null when it is not running. */
async function readBrowserState(): Promise<{ port: number } | null> {
  const home =
    process.env.GRAZER_HOME ||
    (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Grazer")
      : join(process.env.USERPROFILE || process.env.HOME || ".", ".grazer"));
  try {
    const raw = await readFile(join(resolve(home), "browser.json"), "utf8");
    const parsed = JSON.parse(raw) as { port?: number };
    return typeof parsed?.port === "number" ? { port: parsed.port } : null;
  } catch {
    return null;
  }
}

/** Confirm the descriptor points at a browser that is actually answering. */
async function browserAlive(port: number, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function die(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) die(USAGE, EXIT_USAGE);

  if (!existsSync(args.sdkPath)) {
    die(
      `Grazer harness bundle not built. Run: npm run harness:build\n  (missing ${args.sdkPath})`,
      EXIT_ENVIRONMENT,
    );
  }

  const state = await readBrowserState();
  if (!state || !(await browserAlive(state.port))) {
    die(
      "Grazer browser is not running. Start it with: grazer browser start",
      EXIT_ENVIRONMENT,
    );
  }

  // Read the script before connecting: an empty heredoc is a usage error and
  // should not have cost a browser connection.
  const code = await readStdin();
  if (!code.trim()) die(USAGE, EXIT_USAGE);

  let connection;
  try {
    connection = await connect({ port: state.port, openTimeoutMs: 10_000 });
  } catch (error) {
    die(
      `Grazer could not connect to the browser on port ${state.port}: ${(error as Error).message}`,
      EXIT_ENVIRONMENT,
    );
  }

  const runtime = createGrazerRuntime(connection);
  (globalThis as Record<string, unknown>).grazer = runtime;

  // Before the bundle import, for the same reason the runtime itself is:
  // installGrazerSdk re-exposes the runtime's own enumerable function keys
  // (index.ts:321-343), so `snapshot` has to be on the object by then or
  // `snapshotText()` and `waitForAgentControl` — which probes `grazer.snapshot`
  // to learn whether the agent still holds control — are simply absent.
  // The cast is the adapter's own design: SnapshotTarget carries an index
  // signature precisely so 03-02 never has to edit the transport's file, and a
  // concrete interface is not assignable to one. Nothing is loosened here that
  // the adapter does not already assume.
  attachSnapshot(runtime as unknown as SnapshotTarget, { connection });

  // The bundle finds its skill directory next to itself; this covers a bundle
  // built without the copy step, and lets a caller point somewhere else.
  process.env.GRAZER_AGENT_WORKSPACE ??= join(PACKAGE_ROOT, "skills", "grazer");

  // Only now: the import runs installGrazerSdk, which reads globalThis.grazer.
  await import(pathToFileURL(args.sdkPath).href);

  const AsyncFunction = Object.getPrototypeOf(async function () {})
    .constructor as new (body: string) => () => Promise<unknown>;

  let thrown: unknown;
  try {
    const fn = new AsyncFunction(`"use strict";\n${code}`);
    await fn();
  } catch (error) {
    thrown = error;
  }

  // Close the socket so nothing holds the loop open, then RETURN. Letting the
  // process end naturally is what lets the sink's beforeExit hook flush the
  // agent's console.log output; process.exit() here would discard it.
  runtime.dispose();
  await connection.close().catch(() => {});

  if (thrown) {
    const error = thrown as { stack?: string; message?: string };
    process.stderr.write(`${error?.stack || error?.message || String(thrown)}\n`);
    process.exitCode = EXIT_SCRIPT_ERROR;
  }
}

await main();
