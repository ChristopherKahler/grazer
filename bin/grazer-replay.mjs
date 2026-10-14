#!/usr/bin/env node
// Replay a Grazer Sync bundle into a task space, so a page opened in that
// space is already logged in.
//
//   grazer-replay <spaceIdOrName> [--bundle <path>]
//   grazer-replay --default-context [--bundle <path>]
//
// --default-context targets the browser's own profile rather than a space,
// which is what a driver that cannot create task spaces (Playwright MCP,
// claude-in-chrome) needs in order to start from a logged-in profile.
//
// The bundle defaults to the newest file under <GRAZER_HOME>/bundles, which is
// where the native messaging host writes what the extension exported.

import { resolve } from "node:path";

import { connect } from "../dist/cdp/connection.js";
import { readBrowserState } from "../dist/companion/browser.js";
import { grazerHome } from "../dist/companion/paths.js";
import { findRow, readStore } from "../dist/spaces/store.js";
import { loadBundle, newestBundlePath, replay } from "../dist/replay/index.js";

const USAGE = `grazer-replay — replay a Grazer Sync bundle into a task space

Usage:
  grazer-replay <spaceIdOrName> [--bundle <path>]
  grazer-replay --default-context [--bundle <path>]

Options:
  --default-context  replay into the browser's default context (the profile
                     itself) instead of a task space
  --bundle <path>    bundle file to replay (default: newest in <GRAZER_HOME>/bundles)
  --help             show this message

Exits 1 when any store fails to replay; the other stores are still replayed.`;

function parseArgs(argv) {
  const args = { space: null, bundle: null, help: false, defaultContext: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--default-context") args.defaultContext = true;
    else if (arg === "--bundle") args.bundle = argv[++i] ?? null;
    else if (!args.space) args.space = arg;
    else return { ...args, error: `unexpected argument: ${arg}` };
  }
  // A space and the default context are different destinations; guessing which
  // one was meant would silently seed the wrong one.
  if (args.defaultContext && args.space) {
    return { ...args, error: "--default-context takes no space argument" };
  }
  return args;
}

/** One line per origin: what landed, and what did not. */
function reportOrigin(entry) {
  const parts = [
    describe("cookies", entry.cookies),
    describe("storage keys", entry.localStorage),
    describe("IDB records", entry.indexedDB),
  ];
  console.log(`${entry.origin}  ${parts.join("  ")}`);
  for (const [store, outcome] of Object.entries(entry)) {
    if (outcome && typeof outcome === "object" && outcome.error) {
      console.error(`  ${store} FAILED: ${outcome.error}`);
    }
  }
}

function describe(label, outcome) {
  return outcome.error ? `${label}: FAILED` : `${label}: ${outcome.count}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.space && !args.defaultContext && !args.error)) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }
  if (args.error) {
    console.error(args.error);
    return 1;
  }

  const home = grazerHome();
  const bundlePath = args.bundle ? resolve(args.bundle) : await newestBundlePath(home);
  if (!bundlePath) {
    console.error(`no bundle found under ${home}\\bundles — run Grazer Sync first`);
    return 1;
  }

  let row = null;
  if (!args.defaultContext) {
    row = findRow(readStore(home), args.space);
    if (!row) {
      console.error(`no task space named ${args.space}`);
      return 1;
    }
  }

  const state = await readBrowserState();
  if (!state) {
    console.error("no running Grazer browser (browser.json is absent)");
    return 1;
  }

  const bundle = await loadBundle(bundlePath);
  const connection = await connect({ wsUrl: state.wsUrl });
  try {
    // No browserContextId key at all for the default context: the library
    // treats an absent key as "the default context", and a key present with
    // undefined is a different frame that Chrome rejects.
    const options = {
      send: async (method, params, sessionId) =>
        (await connection.send(method, params ?? {}, sessionId)).result ?? {},
      onEvent: (listener) => connection.onEvent(listener),
    };
    if (row) options.browserContextId = row.browserContextId;

    const result = await replay(bundle, options);
    console.log(`replayed ${bundlePath}`);
    console.log(
      row
        ? `into space ${row.id} (${row.name})`
        : "into the default browser context",
    );
    for (const entry of result.origins) reportOrigin(entry);
    return result.ok ? 0 : 1;
  } finally {
    await connection.close();
  }
}

process.exitCode = await main().catch((error) => {
  console.error(error?.message ?? String(error));
  return 1;
});
