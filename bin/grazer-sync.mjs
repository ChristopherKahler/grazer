#!/usr/bin/env node
// Register the Grazer Sync native messaging host with Chrome, Brave, Edge and Chromium.
//
//   grazer-sync register [--browser chrome|brave|edge|chromium|both|all] [--dry-run]
//   grazer-sync unregister [--browser chrome|brave|edge|chromium|both|all]
//   grazer-sync status [--browser chrome|brave|edge|chromium|both|all]
//
// The extension id in the host manifest is derived from extension/manifest.json
// rather than copied out of chrome://extensions, so registration cannot drift
// away from the extension it is meant to authorise.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extensionIdFromManifest } from '../extension/lib/extension-id.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(REPO_ROOT, 'extension', 'manifest.json');
const CMD_PATH = join(REPO_ROOT, 'bin', 'grazer-native-host.cmd');
const REGISTER_JS = join(REPO_ROOT, 'dist', 'native-host', 'register.js');

const USAGE = `grazer-sync — register the Grazer Sync native messaging host

Usage:
  grazer-sync register   [--browser chrome|brave|edge|chromium|both|all] [--dry-run]
  grazer-sync unregister [--browser chrome|brave|edge|chromium|both|all]
  grazer-sync status     [--browser chrome|brave|edge|chromium|both|all]

Options:
  --browser <name>  chrome (default), brave, edge, chromium, both (chrome and
                    brave), or all four
  --dry-run         print what would be written and run, change nothing
  --help            show this message

Bundles land under %LOCALAPPDATA%\\Grazer (override with GRAZER_HOME).`;

function parseArgs(argv) {
  const args = { command: null, browser: 'chrome', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--browser') {
      i += 1;
      args.browser = argv[i];
    } else if (arg.startsWith('--browser=')) args.browser = arg.slice('--browser='.length);
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (args.command === null) args.command = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

function browsersFor(name) {
  if (name === 'both') return ['chrome', 'brave'];
  if (name === 'all') return ['chrome', 'brave', 'edge', 'chromium'];
  if (['chrome', 'brave', 'edge', 'chromium'].includes(name)) return [name];
  throw new Error(`--browser must be chrome, brave, edge, chromium, both, or all (got ${String(name)})`);
}

function grazerHome(env = process.env) {
  if (env.GRAZER_HOME && env.GRAZER_HOME.trim().length > 0) return env.GRAZER_HOME;
  const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim().length > 0
    ? env.LOCALAPPDATA
    : join(env.USERPROFILE || env.HOME || '.', 'AppData', 'Local');
  return join(base, 'Grazer');
}

async function loadRegister() {
  if (!existsSync(REGISTER_JS)) {
    throw new Error(`dist/native-host is not built yet — run "npm run build" first (looked for ${REGISTER_JS})`);
  }
  return import(pathToFileURL(REGISTER_JS).href);
}

function reportSteps(steps) {
  let failed = false;
  for (const step of steps) {
    if (step.skipped) {
      console.log(`  [${step.browser}] would run: ${step.command}`);
      continue;
    }
    if (step.status === 0) {
      console.log(`  [${step.browser}] ok: ${step.command}`);
    } else {
      failed = true;
      console.error(`  [${step.browser}] FAILED (${step.status}): ${step.command}`);
      if (step.output) console.error(`           ${step.output.split('\n')[0]}`);
    }
  }
  return failed;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.command === null) {
    console.log(USAGE);
    return 0;
  }

  const browsers = browsersFor(args.browser);
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const extensionId = await extensionIdFromManifest(manifest);
  const register = await loadRegister();
  const home = grazerHome();

  if (args.command === 'register') {
    const result = register.registerNativeHost({
      extensionId,
      browsers,
      home,
      cmdPath: CMD_PATH,
      dryRun: args.dryRun,
    });
    console.log(`extension id: ${extensionId}`);
    console.log(`host manifest${args.dryRun ? ' (not written)' : ''}: ${result.manifestPath}`);
    console.log(JSON.stringify(result.manifest, null, 2));
    return reportSteps(result.steps) ? 1 : 0;
  }

  if (args.command === 'unregister') {
    const steps = register.unregisterNativeHost({ browsers, dryRun: args.dryRun });
    return reportSteps(steps) ? 1 : 0;
  }

  if (args.command === 'status') {
    const entries = register.statusNativeHost({ browsers });
    console.log(`extension id: ${extensionId}`);
    for (const entry of entries) {
      console.log(
        entry.registered
          ? `  [${entry.browser}] registered -> ${entry.manifestPath}`
          : `  [${entry.browser}] not registered`,
      );
    }
    return entries.every((entry) => entry.registered) ? 0 : 1;
  }

  throw new Error(`unknown command: ${args.command}`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`grazer-sync: ${err.message}`);
  process.exitCode = 1;
}
