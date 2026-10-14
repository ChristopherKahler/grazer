// AC-2: a real export out of a real headless browser.
//
// The fixture plants an HttpOnly cookie, a normal cookie, a localStorage key
// and an IndexedDB database; the extension's own service worker is driven over
// CDP and has to bring all of it back. Then the bundle it produced is fed to
// the real native host process, so the file on disk is the genuine article and
// not a fixture.
//
// Loading the extension: Chrome 137+ ignores --load-extension (the switch was
// disabled as a hardening measure) and Chrome 152 is what is installed here,
// so the CDP command Extensions.loadUnpacked is the way in. Both Chrome 152
// and Brave 152 answer it with the id derived from the committed manifest key.
// Passing --disable-extensions-except alongside it actively suppresses the
// CDP-loaded extension, so the preferred launch carries no extension switches
// at all; the switches are only used as a fallback for a browser whose CDP has
// no Extensions domain.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixtureSite } from './support/fixture-site.mjs';
import { extensionIdFromManifest } from '../extension/lib/extension-id.mjs';
import { decode } from '../extension/lib/idb-codec.mjs';
import { FrameReader, encodeFrame } from '../dist/native-host/framing.js';
import { acquireSuiteLock } from './support/suite-lock.mjs';
import { CDP_TIMEOUT, createCdpClient } from './support/cdp-deadline.mjs';

/**
 * Law 11: one browser-launching suite at a time, machine-wide.
 *
 * Held for the whole FILE rather than per test — releasing between this file's
 * own tests would let another suite interleave, which is exactly what the lock
 * exists to prevent.
 */
let suiteLock;
before(async () => {
  suiteLock = await acquireSuiteLock('extension.live');
});
// No `after` release: node:test can settle the root suite's hooks before the
// last browser test has finished, which released the lock mid-run and let two
// suites overlap. The lock is released when the process exits instead, so it
// provably spans the whole run.


const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(REPO, 'extension');
const HOST_JS = join(REPO, 'dist', 'native-host', 'host.js');

const CHROMIUM_CANDIDATES = [
  process.env.GRAZER_BROWSER,
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
];

const findChromium = () => CHROMIUM_CANDIDATES.find((path) => path && existsSync(path)) ?? null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `probe` until it returns something truthy, or give up. No fixed sleeps. */
async function until(probe, { timeoutMs = 15000, everyMs = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Minimal CDP client over the browser endpoint, with flat sessions. */
/**
 * A CDP client over the browser endpoint, with a deadline on every await.
 *
 * Unbounded here once cost a full run: Extensions.loadUnpacked never replied
 * and node --test has no global timeout, so the suite hung for 18 minutes and
 * six other failures lost their detail. See ./support/cdp-deadline.mjs.
 */
function connect(url) {
  return createCdpClient(new WebSocket(url), { label: url });
}

async function launchBrowser(binary, extraArgs) {
  const profile = mkdtempSync(join(tmpdir(), 'grazer-live-'));
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    ...extraArgs,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const portFile = join(profile, 'DevToolsActivePort');
  const port = await until(
    () => {
      if (child.exitCode !== null) throw new Error(`browser exited (${child.exitCode}): ${stderr.slice(-400)}`);
      try {
        return readFileSync(portFile, 'utf8').split('\n')[0].trim() || null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 30000, what: 'the browser devtools port' },
  );

  return {
    port,
    async kill() {
      child.kill();
      await sleep(200);
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows holds files */ }
    },
  };
}

const listTargets = async (port) => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());

const findServiceWorker = async (port, extensionId) => (await listTargets(port))
  .find((target) => target.type === 'service_worker' && String(target.url).includes(extensionId));

const browserEndpoint = async (port) => (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json());

/**
 * Launch a browser with Grazer Sync loaded, whichever way this browser allows,
 * and wait for its service worker to come up.
 */
async function launchWithExtension(binary, extensionId) {
  // Preferred: no extension switches, load over CDP.
  let browser = await launchBrowser(binary, []);
  let version = await browserEndpoint(browser.port);
  let cdp = connect(version.webSocketDebuggerUrl);
  await cdp.opened;

  let loadedVia = 'Extensions.loadUnpacked';
  try {
    const loaded = await cdp.call('Extensions.loadUnpacked', { path: EXTENSION_DIR.split('/').join('\\') });
    assert.equal(loaded.id, extensionId, 'the browser derives the same id from the committed key');
  } catch (error) {
    // A PROTOCOL error means this browser has no Extensions domain, and the
    // command-line switches are the right fallback. A TIMEOUT means the browser
    // is not answering at all — falling back would relaunch, fail the service
    // worker wait 10s later, and report the wrong cause. Fail loudly instead,
    // after killing the browser this function launched: the caller has no
    // handle to it yet, so nothing else can.
    if (error?.code === CDP_TIMEOUT) {
      cdp.close();
      await browser.kill();
      throw error;
    }
    // A browser without the Extensions domain: fall back to the switches.
    cdp.close();
    await browser.kill();
    loadedVia = '--load-extension';
    browser = await launchBrowser(binary, [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ]);
    version = await browserEndpoint(browser.port);
    cdp = connect(version.webSocketDebuggerUrl);
    await cdp.opened;
  }

  // Everything from here can throw, and until it is returned the caller has no
  // handle to this browser — so anything that fails must kill it here or the
  // process outlives the run.
  let worker;
  let session;
  try {
    worker = await until(
      () => findServiceWorker(browser.port, extensionId),
      { timeoutMs: 10000, what: `the Grazer Sync service worker (loaded via ${loadedVia})` },
    );
    session = (await cdp.call('Target.attachToTarget', { targetId: worker.id, flatten: true })).sessionId;

    // The worker target is attachable before background.mjs has finished
    // evaluating its module graph, so self.grazerExport can still be undefined.
    // Chrome waits for evaluation before dispatching a runtime message, which is
    // why the popup never sees this; Runtime.evaluate does not, so gate on it.
    await until(
      async () => {
        const probe = await cdp.call('Runtime.evaluate', {
          expression: 'typeof self.grazerExport',
          returnByValue: true,
        }, session);
        return probe.result?.value === 'function';
      },
      { timeoutMs: 10000, what: 'the service worker to finish evaluating background.mjs' },
    );
  } catch (error) {
    cdp.close();
    await browser.kill();
    throw error;
  }

  return {
    browser,
    cdp,
    session,
    loadedVia,
    browserName: version.Browser,
    async close() {
      cdp.close();
      await browser.kill();
    },
  };
}

/** Run an expression in the extension's service worker and return its value. */
async function inWorker({ cdp, session }, expression) {
  const evaluated = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, session);
  if (evaluated.exceptionDetails) {
    throw new Error(`${expression} threw: ${JSON.stringify(evaluated.exceptionDetails).slice(0, 600)}`);
  }
  return evaluated.result.value;
}

/** Send one bundle through the real native host process and return its reply. */
function storeViaNativeHost(bundle, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST_JS], {
      env: { ...process.env, GRAZER_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = new FrameReader();
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the native host did not answer; stderr: ${stderr}`));
    }, 20000);
    child.stdout.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) {
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        if (frame.ok) resolve(frame.value);
        else reject(new Error(frame.error));
        return;
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.write(encodeFrame({ type: 'bundle', bundle }));
  });
}

async function readManifestId() {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  return extensionIdFromManifest(manifest);
}

test('AC-2: the extension exports cookies, localStorage and IndexedDB from a real browser', async (t) => {
  const binary = findChromium();
  if (!binary) return t.skip('no Chromium found (set GRAZER_BROWSER)');
  if (!existsSync(HOST_JS)) return t.skip('dist/native-host/host.js is not built — run npm run build');

  const extensionId = await readManifestId();
  const fixture = await startFixtureSite();
  const home = mkdtempSync(join(tmpdir(), 'grazer-live-home-'));
  const run = await launchWithExtension(binary, extensionId);

  try {
    // Visit the fixture so it plants its cookies and web storage.
    const page = await run.cdp.call('Target.createTarget', { url: `${fixture.origin}/` });
    const pageSession = (await run.cdp.call('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    const title = await until(
      async () => {
        const result = await run.cdp.call('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, pageSession);
        const value = result.result?.value;
        return value === 'loading' ? null : value;
      },
      { timeoutMs: 20000, what: 'the fixture to finish planting its storage' },
    );
    assert.equal(title, 'ready', 'the fixture planted its cookies and storage');

    // Drive the extension's own export, in the extension's own worker.
    assert.equal(
      await inWorker(run, 'chrome.runtime.id'),
      extensionId,
      'chrome.runtime.id matches the id computed from manifest.json',
    );

    const bundle = await inWorker(run, `self.grazerExport([${JSON.stringify(fixture.origin)}])`);

    assert.equal(bundle.version, 1);
    assert.ok(['chrome', 'brave'].includes(bundle.browser.name));
    assert.match(bundle.browser.version, /^\d+\./);
    assert.equal(bundle.origins.length, 1);

    const entry = bundle.origins[0];
    assert.equal(entry.origin, fixture.origin);
    assert.equal(entry.site, '127.0.0.1', 'an IP host is its own site, not a mangled eTLD+1');
    assert.deepEqual(entry.errors, [], 'a clean export reports no errors');

    // --- cookies, HttpOnly included -------------------------------------
    const httpOnly = entry.cookies.find((cookie) => cookie.name === 'grz_http');
    assert.ok(httpOnly, `grz_http missing; got ${entry.cookies.map((c) => c.name).join(', ') || 'nothing'}`);
    assert.equal(httpOnly.value, 'secret');
    assert.equal(httpOnly.httpOnly, true);
    assert.equal(httpOnly.path, '/');
    assert.equal(httpOnly.partitionKey, null);

    const readable = entry.cookies.find((cookie) => cookie.name === 'grz_js');
    assert.ok(readable, 'grz_js missing');
    assert.equal(readable.value, 'visible');
    assert.equal(readable.httpOnly, false);

    // --- localStorage ----------------------------------------------------
    assert.equal(entry.localStorage.grz_ls, '1');

    // --- IndexedDB, with the codec intact --------------------------------
    const db = entry.indexedDB.find((candidate) => candidate.name === 'grzdb');
    assert.ok(db, `grzdb missing; got ${entry.indexedDB.map((d) => d.name).join(', ') || 'nothing'}`);
    assert.equal(db.version, 2);

    const store = db.stores.find((candidate) => candidate.name === 'items');
    assert.ok(store, 'store items missing');
    assert.equal(store.keyPath, 'id');
    assert.equal(store.truncated, false);
    assert.equal(store.records.length, 3);
    assert.deepEqual(store.indexes.map((index) => index.name), ['by_label'], 'index metadata travels with the store');

    const dated = store.records.find((record) => record.value.label === 'dated');
    assert.ok(dated, 'the record holding a Date is missing');
    assert.deepEqual(dated.value.at, { $t: 'Date', v: '2024-05-06T07:08:09.000Z' }, 'the Date carries a codec tag');

    const binaryRecord = store.records.find((record) => record.value.label === 'binary');
    assert.ok(binaryRecord, 'the record holding a Uint8Array is missing');
    assert.equal(binaryRecord.value.bytes.$t, 'Uint8Array', 'the typed array carries a codec tag');

    // The tags are not decoration: they decode back to the original values.
    assert.ok(decode(dated.value.at) instanceof Date);
    assert.equal(decode(dated.value.at).toISOString(), '2024-05-06T07:08:09.000Z');
    assert.deepEqual([...decode(binaryRecord.value.bytes)], [1, 2, 3, 4, 5]);

    // --- and it reaches disk through the real native host ----------------
    const stored = await storeViaNativeHost(bundle, home);
    assert.equal(stored.type, 'stored');
    assert.equal(stored.origins, 1);

    const onDisk = JSON.parse(readFileSync(stored.path, 'utf8'));
    assert.deepEqual(onDisk, bundle, 'the file on disk is the bundle the browser produced');
    const diskEntry = onDisk.origins[0];
    assert.equal(diskEntry.cookies.find((c) => c.name === 'grz_http').value, 'secret');
    assert.equal(diskEntry.localStorage.grz_ls, '1');
    assert.equal(diskEntry.indexedDB[0].stores[0].records.length, 3);

    t.diagnostic(`${run.browserName} via ${run.loadedVia}; bundle file ${stored.path} (${stored.bytes} bytes)`);
  } finally {
    await run.close();
    await fixture.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('AC-2: an origin with no tab open is opened in the background and closed again', async (t) => {
  const binary = findChromium();
  if (!binary) return t.skip('no Chromium found (set GRAZER_BROWSER)');

  const extensionId = await readManifestId();
  const fixture = await startFixtureSite();
  const run = await launchWithExtension(binary, extensionId);

  try {
    // No tab is open on the fixture: the export has to open one itself.
    const bundle = await inWorker(run, `self.grazerExport([${JSON.stringify(fixture.origin)}])`);
    const entry = bundle.origins[0];

    assert.equal(entry.origin, fixture.origin);
    assert.deepEqual(entry.errors, []);
    assert.equal(entry.localStorage.grz_ls, '1', 'the background tab loaded the page and its storage');
    assert.ok(entry.cookies.some((cookie) => cookie.name === 'grz_http'));

    const left = (await listTargets(run.browser.port)).filter((target) => String(target.url).startsWith(fixture.origin));
    assert.equal(left.length, 0, 'the export closed the tab it opened');
  } finally {
    await run.close();
    await fixture.close();
  }
});
