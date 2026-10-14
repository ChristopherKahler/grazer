// Browser choice: the saved pick in config.json, and the order that decides
// which browser `grazer browser start` runs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanHomeSync } from './support/clean-home.mjs';

import {
  findBrowserExecutable,
  useBrowser,
  readConfig,
  configPath,
  knownBrowsers,
  knownBrowserForPath,
} from '../dist/companion/browsers.js';

let home;
let saved;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'grazer-browsers-'));
  saved = { GRAZER_HOME: process.env.GRAZER_HOME, GRAZER_BROWSER: process.env.GRAZER_BROWSER };
  process.env.GRAZER_HOME = home;
  delete process.env.GRAZER_BROWSER;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanHomeSync(home);
});

/** A file that stands in for a browser executable. */
function fakeExe(name) {
  const path = join(home, name);
  writeFileSync(path, '');
  return path;
}

test('browser use saves a path and keeps other config fields', () => {
  writeFileSync(configPath(), JSON.stringify({ keep: 'me' }));
  const exe = fakeExe('mybrowser.exe');
  assert.equal(useBrowser(exe), exe);
  const config = JSON.parse(readFileSync(configPath(), 'utf8'));
  assert.equal(config.browser, exe);
  assert.equal(config.keep, 'me');
});

test('the saved browser is used when nothing overrides it', () => {
  const exe = fakeExe('saved.exe');
  useBrowser(exe);
  assert.equal(findBrowserExecutable(), exe);
});

test('GRAZER_BROWSER beats the saved browser, and --browser beats both', () => {
  useBrowser(fakeExe('saved.exe'));
  const fromEnv = fakeExe('env.exe');
  process.env.GRAZER_BROWSER = fromEnv;
  assert.equal(findBrowserExecutable(), fromEnv);
  const explicit = fakeExe('flag.exe');
  assert.equal(findBrowserExecutable(explicit), explicit);
});

test('a saved browser that was uninstalled says how to pick another', () => {
  writeFileSync(configPath(), JSON.stringify({ browser: join(home, 'gone.exe') }));
  assert.throws(() => findBrowserExecutable(), /missing: .*gone\.exe[\s\S]*grazer browser use/);
});

test('an unknown name that is not a file is rejected with the known names', () => {
  assert.throws(() => useBrowser('netscape'), /not a known browser[\s\S]*chrome, brave/);
  assert.deepEqual(readConfig(), {}, 'nothing was saved');
});

test('the known list covers the common Chromium browsers', () => {
  const ids = knownBrowsers().map((browser) => browser.id);
  assert.deepEqual(ids, ['chrome', 'brave', 'vivaldi', 'chromium', 'edge']);
  const chrome = knownBrowsers()[0];
  assert.equal(knownBrowserForPath(chrome.paths[0].toUpperCase())?.id, 'chrome');
  assert.equal(knownBrowserForPath('C:\\elsewhere\\thing.exe'), null);
});
