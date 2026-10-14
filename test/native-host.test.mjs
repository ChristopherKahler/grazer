// AC-3: the native messaging host stores a bundle and survives bad frames.
// Plus framing and registration unit coverage (AC-4 is exercised end to end
// through bin/grazer-sync.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanHomeSync } from './support/clean-home.mjs';
import { promisify } from 'node:util';

import { FrameReader, encodeFrame, MAX_INCOMING_BYTES } from '../dist/native-host/framing.js';
import {
  HOST_NAME,
  registryKey,
  hostManifest,
  formatCommand,
  regAddArgv,
  regDeleteArgv,
  regQueryArgv,
  registerNativeHost,
  unregisterNativeHost,
  statusNativeHost,
} from '../dist/native-host/register.js';
import { bundlePath, sanitiseSite, timestamp, grazerHome } from '../dist/native-host/host.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST_JS = join(REPO, 'dist', 'native-host', 'host.js');
const EXTENSION_ID = 'jcnpacffbkmlcfnoeddmgaeinofiijki';

// ------------------------------------------------------------- framing ----

test('framing round-trips a value', () => {
  const reader = new FrameReader();
  const frames = reader.push(encodeFrame({ type: 'hello', n: 1 }));
  assert.deepEqual(frames, [{ ok: true, value: { type: 'hello', n: 1 } }]);
  assert.equal(reader.pending, 0);
});

test('framing reassembles a message split across chunks', () => {
  const reader = new FrameReader();
  const payload = { type: 'bundle', bundle: { origins: Array.from({ length: 40 }, (_, i) => ({ site: `s${i}` })) } };
  const frame = encodeFrame(payload);

  const out = [];
  for (let i = 0; i < frame.length; i += 7) {
    out.push(...reader.push(frame.subarray(i, Math.min(i + 7, frame.length))));
  }
  assert.deepEqual(out, [{ ok: true, value: payload }]);
});

test('framing reads back-to-back frames out of one chunk', () => {
  const reader = new FrameReader();
  const chunk = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 }), encodeFrame({ c: 3 })]);
  assert.deepEqual(reader.push(chunk), [
    { ok: true, value: { a: 1 } },
    { ok: true, value: { b: 2 } },
    { ok: true, value: { c: 3 } },
  ]);
});

test('framing reports a non-JSON body without throwing', () => {
  const body = Buffer.from('this is not json', 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  const frames = new FrameReader().push(Buffer.concat([header, body]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].ok, false);
  assert.match(frames[0].error, /not JSON/);
});

test('framing refuses an absurd length rather than allocating on it', () => {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(MAX_INCOMING_BYTES + 1, 0);
  const frames = new FrameReader().push(header);
  assert.equal(frames[0].ok, false);
  assert.match(frames[0].error, /exceeds/);
});

// ----------------------------------------------------- host file naming ----

test('bundle files are named for the site and the second they arrived', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grazer-name-'));
  try {
    const at = new Date(2026, 8, 3, 7, 5, 9);
    const path = bundlePath(dir, { origins: [{ site: 'example.co.uk' }] }, at);
    assert.equal(path, join(dir, 'example.co.uk-20260903-070509.json'));
    assert.equal(timestamp(at), '20260903-070509');
    assert.equal(sanitiseSite('exa/mple.com'), 'exa_mple.com');
    assert.equal(sanitiseSite(undefined), 'unknown');
    assert.equal(bundlePath(dir, { origins: [] }, at), join(dir, 'unknown-20260903-070509.json'));
  } finally {
    cleanHomeSync(dir);
  }
});

test('GRAZER_HOME overrides the default Grazer home', () => {
  assert.equal(grazerHome({ GRAZER_HOME: 'D:\\somewhere' }), 'D:\\somewhere');
  assert.equal(grazerHome({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }), join('C:\\Users\\x\\AppData\\Local', 'Grazer'));
});

// ------------------------------------------------------ AC-3: live host ----

/** Spawn the host, send every frame, collect replies until it goes quiet. */
function talkToHost(messages, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST_JS], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = new FrameReader();
    const replies = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`host did not answer ${messages.length} messages (got ${replies.length}); stderr: ${stderr}`));
    }, 15000);

    child.stdout.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) replies.push(frame);
      if (replies.length >= messages.length) {
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve({ replies, stderr });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);

    for (const message of messages) {
      child.stdin.write(message instanceof Buffer ? message : encodeFrame(message));
    }
  });
}

const sampleBundle = {
  version: 1,
  createdAt: '2026-09-03T07:00:00.000Z',
  browser: { name: 'chrome', version: '152.0.7977.66' },
  origins: [{
    origin: 'http://127.0.0.1:8123',
    site: '127.0.0.1',
    cookies: [{
      name: 'grz_http', value: 'secret', domain: '127.0.0.1', path: '/',
      secure: false, httpOnly: true, sameSite: 'unspecified',
      expirationDate: 0, session: true, partitionKey: null,
    }],
    localStorage: { grz_ls: '1' },
    indexedDB: [{
      name: 'grzdb', version: 2,
      stores: [{
        name: 'items', keyPath: 'id', autoIncrement: false, indexes: [],
        records: [{ key: 1, value: { id: 1, at: { $t: 'Date', v: '2020-01-01T00:00:00.000Z' } } }],
        truncated: false,
      }],
    }],
    errors: [],
  }],
};

test('AC-3: the host answers hello and stores a bundle under GRAZER_HOME', async (t) => {
  if (!existsSync(HOST_JS)) t.skip('dist/native-host/host.js is not built');
  const home = mkdtempSync(join(tmpdir(), 'grazer-home-'));
  try {
    const { replies } = await talkToHost(
      [{ type: 'hello' }, { type: 'bundle', bundle: sampleBundle }],
      { GRAZER_HOME: home },
    );

    assert.equal(replies.length, 2);
    assert.equal(replies[0].ok, true);
    assert.equal(replies[0].value.type, 'hello');
    assert.equal(typeof replies[0].value.version, 'number');
    assert.equal(replies[0].value.home, home);

    assert.equal(replies[1].ok, true);
    const stored = replies[1].value;
    assert.equal(stored.type, 'stored');
    assert.equal(stored.origins, 1);
    assert.ok(stored.bytes > 0);
    assert.ok(stored.path.startsWith(join(home, 'bundles')), `unexpected path ${stored.path}`);
    assert.match(stored.path, /127\.0\.0\.1-\d{8}-\d{6}(-\d+)?\.json$/);

    const written = JSON.parse(readFileSync(stored.path, 'utf8'));
    assert.deepEqual(written, sampleBundle, 'the file parses back to the bundle that was sent');
    assert.equal(stored.bytes, Buffer.byteLength(JSON.stringify(sampleBundle)));

    const log = readFileSync(join(home, 'logs', 'native-host.log'), 'utf8');
    assert.match(log, /stored /);
  } finally {
    cleanHomeSync(home);
  }
});

test('AC-3: a bad frame is answered with an error and the host stays alive', async (t) => {
  if (!existsSync(HOST_JS)) t.skip('dist/native-host/host.js is not built');
  const home = mkdtempSync(join(tmpdir(), 'grazer-home-'));
  try {
    const junkBody = Buffer.from('{not json at all', 'utf8');
    const junkHeader = Buffer.allocUnsafe(4);
    junkHeader.writeUInt32LE(junkBody.length, 0);

    const { replies } = await talkToHost(
      [Buffer.concat([junkHeader, junkBody]), { type: 'hello' }],
      { GRAZER_HOME: home },
    );

    assert.equal(replies.length, 2);
    assert.equal(replies[0].value.type, 'error');
    assert.match(replies[0].value.message, /not JSON/);
    assert.equal(replies[1].value.type, 'hello', 'the host kept reading after the bad frame');
  } finally {
    cleanHomeSync(home);
  }
});

test('AC-3: an unknown message type is an error, not a crash', async (t) => {
  if (!existsSync(HOST_JS)) t.skip('dist/native-host/host.js is not built');
  const home = mkdtempSync(join(tmpdir(), 'grazer-home-'));
  try {
    const { replies } = await talkToHost(
      [{ type: 'nonsense' }, { type: 'bundle' }, { type: 'hello' }],
      { GRAZER_HOME: home },
    );
    assert.equal(replies[0].value.type, 'error');
    assert.match(replies[0].value.message, /unknown message type: nonsense/);
    assert.equal(replies[1].value.type, 'error');
    assert.match(replies[1].value.message, /bundle must be an object/);
    assert.equal(replies[2].value.type, 'hello');
  } finally {
    cleanHomeSync(home);
  }
});

// --------------------------------------------------------- registration ----

test('the host manifest names the computed extension id and the cmd wrapper', () => {
  const manifest = hostManifest({ extensionId: EXTENSION_ID, cmdPath: 'C:\\g\\bin\\grazer-native-host.cmd' });
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.ok(manifest.path.endsWith('bin\\grazer-native-host.cmd'));
  assert.throws(() => hostManifest({ extensionId: 'NOT-AN-ID', cmdPath: 'x' }), /not a valid extension id/);
});

test('registry keys stay under HKCU for every browser', () => {
  assert.equal(registryKey('chrome'), `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
  assert.equal(registryKey('brave'), `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`);
  assert.equal(registryKey('edge'), `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`);
  assert.equal(registryKey('chromium'), `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`);
  for (const browser of ['chrome', 'brave', 'edge', 'chromium']) {
    for (const argv of [regAddArgv(browser, 'p.json'), regDeleteArgv(browser), regQueryArgv(browser)]) {
      assert.equal(argv[0], 'reg');
      assert.ok(argv.some((part) => part.startsWith('HKCU\\')), 'every reg call targets HKCU');
      assert.ok(!argv.some((part) => part.includes('HKLM')), 'nothing touches HKLM');
    }
  }
});

test('the printed reg command quotes the key and the manifest path', () => {
  const command = formatCommand(regAddArgv('chrome', 'C:\\Program Files\\Grazer\\host.json'));
  assert.match(command, /^reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.grazerai\.companion" \/ve \/t REG_SZ \/d "C:\\Program Files\\Grazer\\host\.json" \/f$/);
});

test('a dry run writes nothing and runs nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'grazer-reg-'));
  try {
    let ran = 0;
    const result = registerNativeHost({
      extensionId: EXTENSION_ID,
      browsers: ['chrome', 'brave'],
      home,
      cmdPath: join(REPO, 'bin', 'grazer-native-host.cmd'),
      dryRun: true,
      run: () => { ran += 1; return { status: 0, output: '' }; },
    });
    assert.equal(ran, 0);
    assert.equal(existsSync(result.manifestPath), false, 'nothing was written');
    assert.equal(result.steps.length, 2);
    assert.ok(result.steps.every((step) => step.skipped));
    assert.match(result.steps[0].command, /Google\\Chrome/);
    assert.match(result.steps[1].command, /BraveSoftware/);
  } finally {
    cleanHomeSync(home);
  }
});

test('a real run writes the manifest and issues one reg add per browser', () => {
  const home = mkdtempSync(join(tmpdir(), 'grazer-reg-'));
  try {
    const calls = [];
    const result = registerNativeHost({
      extensionId: EXTENSION_ID,
      browsers: ['chrome'],
      home,
      cmdPath: 'C:\\g\\bin\\grazer-native-host.cmd',
      run: (argv) => { calls.push(argv); return { status: 0, output: '' }; },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['reg', 'add']);
    assert.equal(calls[0].at(-2), result.manifestPath, 'the /d value is the manifest we just wrote');
    const written = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    assert.deepEqual(written, result.manifest);

    const removals = [];
    unregisterNativeHost({ browsers: ['chrome'], run: (argv) => { removals.push(argv); return { status: 0, output: '' }; } });
    assert.deepEqual(removals[0].slice(0, 2), ['reg', 'delete']);
  } finally {
    cleanHomeSync(home);
  }
});

test('status reads the manifest path back out of a reg query', () => {
  const registered = statusNativeHost({
    browsers: ['chrome'],
    run: () => ({
      status: 0,
      output: `\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}\r\n    (Default)    REG_SZ    C:\\Users\\x\\AppData\\Local\\Grazer\\native-host\\${HOST_NAME}.json\r\n\r\n`,
    }),
  });
  assert.equal(registered[0].registered, true);
  assert.equal(registered[0].manifestPath, `C:\\Users\\x\\AppData\\Local\\Grazer\\native-host\\${HOST_NAME}.json`);

  const missing = statusNativeHost({
    browsers: ['brave'],
    run: () => ({ status: 1, output: 'ERROR: The system was unable to find the specified registry key or value.' }),
  });
  assert.equal(missing[0].registered, false);
  assert.equal(missing[0].manifestPath, null);
});

// -------------------------------------------------------------- AC-4 ------

test('AC-4: register --dry-run prints the manifest and the exact reg command', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(REPO, 'bin', 'grazer-sync.mjs'), 'register', '--browser', 'chrome', '--dry-run'],
    { cwd: REPO },
  );

  assert.match(stdout, new RegExp(`extension id: ${EXTENSION_ID}`));
  assert.match(stdout, /"name": "com\.grazerai\.companion"/);
  assert.match(stdout, /"type": "stdio"/);
  assert.match(stdout, new RegExp(`"chrome-extension://${EXTENSION_ID}/"`));
  assert.match(stdout, /"path": ".*bin\\\\grazer-native-host\.cmd"/);
  assert.match(stdout, /would run: reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.grazerai\.companion" \/ve \/t REG_SZ \/d ".*com\.grazerai\.companion\.json" \/f/);
});

test('AC-4: --browser both covers Chrome and Brave, and bad input is rejected', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(REPO, 'bin', 'grazer-sync.mjs'), 'register', '--browser', 'both', '--dry-run'],
    { cwd: REPO },
  );
  assert.match(stdout, /\[chrome\] would run/);
  assert.match(stdout, /\[brave\] would run/);
  assert.doesNotMatch(stdout, /\[edge\]/);

  await assert.rejects(
    () => promisify(execFile)(process.execPath, [join(REPO, 'bin', 'grazer-sync.mjs'), 'register', '--browser', 'firefox'], { cwd: REPO }),
    (err) => /--browser must be chrome, brave, edge, chromium, both, or all/.test(err.stderr),
  );
});

test('--browser all covers Chrome, Brave, Edge and Chromium', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(REPO, 'bin', 'grazer-sync.mjs'), 'register', '--browser', 'all', '--dry-run'],
    { cwd: REPO },
  );
  for (const browser of ['chrome', 'brave', 'edge', 'chromium']) {
    assert.match(stdout, new RegExp(`\\[${browser}\\] would run`));
  }
});

test('grazer sync register defaults to all four browsers', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [join(REPO, 'bin', 'grazer.mjs'), 'sync', 'register', '--dry-run'],
    { cwd: REPO },
  );
  assert.match(stdout, /\[edge\] would run: reg add "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com\.grazerai\.companion"/);
  assert.match(stdout, /\[chromium\] would run/);
});

test('the cmd wrapper points at the built host and passes Chrome argv through', () => {
  const cmd = readFileSync(join(REPO, 'bin', 'grazer-native-host.cmd'), 'utf8');
  assert.match(cmd, /^@node "%~dp0\.\.\\dist\\native-host\\host\.js" %\*/);
});
