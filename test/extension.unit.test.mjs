// AC-1: codec round-trip and bundle assembly against a fake `chrome`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { encode, decode, CODEC_TAGS } from '../extension/lib/idb-codec.mjs';
import { siteOf, originOf, matchPatternFor } from '../extension/lib/site.mjs';
import { extensionIdFromKey, extensionIdFromManifest } from '../extension/lib/extension-id.mjs';
import { pageDump } from '../extension/lib/page-dump.mjs';
import {
  exportOrigins,
  summariseBundle,
  browserVersionFromUserAgent,
  waitForTabComplete,
  BUNDLE_VERSION,
} from '../extension/lib/bundle.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(REPO, 'extension', 'manifest.json'), 'utf8'));

// The id Chrome itself reported for this committed key (Extensions.loadUnpacked,
// Chrome 152 and Brave 152). If the key is ever rotated, this changes with it.
const EXPECTED_EXTENSION_ID = 'jcnpacffbkmlcfnoeddmgaeinofiijki';

const roundTrip = (value) => decode(JSON.parse(JSON.stringify(encode(value))));

// --------------------------------------------------------------- codec ----

test('codec round-trips every structured-clone kind through JSON', () => {
  const original = {
    when: new Date('2021-03-04T05:06:07.008Z'),
    buffer: new Uint8Array([1, 2, 3, 250]).buffer,
    bytes: new Uint8Array([9, 8, 7]),
    floats: new Float64Array([1.5, -2.25]),
    map: new Map([['a', 1], [2, new Date('1999-12-31T00:00:00.000Z')]]),
    set: new Set(['x', 42]),
    missing: undefined,
    nested: { list: [1, [2, { deep: new Date(0) }]] },
    plain: { keep: 'me', n: 7, yes: true, nothing: null },
  };
  const back = roundTrip(original);

  assert.ok(back.when instanceof Date);
  assert.equal(back.when.toISOString(), '2021-03-04T05:06:07.008Z');
  assert.ok(back.buffer instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(back.buffer)], [1, 2, 3, 250]);
  assert.ok(back.bytes instanceof Uint8Array);
  assert.deepEqual([...back.bytes], [9, 8, 7]);
  assert.ok(back.floats instanceof Float64Array);
  assert.deepEqual([...back.floats], [1.5, -2.25]);
  assert.ok(back.map instanceof Map);
  assert.equal(back.map.get('a'), 1);
  assert.ok(back.map.get(2) instanceof Date);
  assert.ok(back.set instanceof Set);
  assert.deepEqual([...back.set], ['x', 42]);
  assert.ok('missing' in back);
  assert.equal(back.missing, undefined);
  assert.ok(back.nested.list[1][1].deep instanceof Date);
  assert.deepEqual(back.plain, { keep: 'me', n: 7, yes: true, nothing: null });
});

test('codec preserves a plain object that happens to carry a $t key', () => {
  assert.deepEqual(roundTrip({ $t: 'Date', v: 'not really a date' }), {
    $t: 'Date',
    v: 'not really a date',
  });
});

test('codec refuses a circular structure with a clear error', () => {
  const loop = { name: 'loop' };
  loop.self = loop;
  assert.throws(() => encode(loop), /circular structure/);
});

test('the injected page dump carries the same codec tag set', () => {
  // page-dump.mjs cannot import idb-codec.mjs (executeScript serialises the
  // function and drops its scope), so guard the hand-copied encoder here.
  const source = pageDump.toString();
  for (const tag of CODEC_TAGS) {
    if (tag === 'object') continue; // encoder-side escape, emitted not named
    assert.ok(source.includes(tag), `page-dump.mjs is missing codec tag ${tag}`);
  }
});

// ---------------------------------------------------------------- site ----

test('siteOf resolves the registrable domain, including two-label suffixes', () => {
  assert.equal(siteOf('https://app.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('https://a.b.c.example.com'), 'example.com');
  assert.equal(siteOf('https://example.com'), 'example.com');
  assert.equal(siteOf('https://shop.example.com.au'), 'example.com.au');
  assert.equal(siteOf('http://127.0.0.1:8080'), '127.0.0.1');
  assert.equal(siteOf('http://localhost:3000'), 'localhost');
  assert.equal(originOf('https://example.com/some/path?q=1'), 'https://example.com');
  assert.equal(matchPatternFor('https://example.com'), 'https://example.com/*');
});

// -------------------------------------------------------- extension id ----

test('the extension id derives from the committed manifest key', async () => {
  assert.equal(await extensionIdFromManifest(manifest), EXPECTED_EXTENSION_ID);
  assert.equal(await extensionIdFromKey(manifest.key), EXPECTED_EXTENSION_ID);
  await assert.rejects(() => extensionIdFromKey(''), /extension key is missing/);
});

test('the extension is named Grazer Sync and asks for the export permissions', () => {
  assert.equal(manifest.name, 'Grazer Sync');
  assert.equal(manifest.manifest_version, 3);
  for (const permission of ['cookies', 'tabs', 'scripting', 'nativeMessaging', 'storage']) {
    assert.ok(manifest.permissions.includes(permission), `missing permission ${permission}`);
  }
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
});

// -------------------------------------------------------------- bundle ----

function fakeDeps({ getAll, dump = { localStorage: {}, indexedDB: [], errors: [] }, tabs = [] } = {}) {
  const calls = { getAll: [], executeScript: [], created: [], removed: [] };
  return {
    calls,
    deps: {
      cookies: {
        getAll: async (details) => {
          calls.getAll.push(details);
          return getAll(details);
        },
      },
      tabs: {
        query: async () => tabs,
        create: async (info) => {
          calls.created.push(info);
          return { id: 99, status: 'complete' };
        },
        remove: async (tabId) => { calls.removed.push(tabId); },
      },
      scripting: {
        executeScript: async (injection) => {
          calls.executeScript.push(injection);
          return [{ result: dump }];
        },
      },
      waitForComplete: async () => {},
      browser: { name: 'chrome', version: '152.0.0.0' },
      maxStoreBytes: 1024,
      now: () => new Date('2026-09-03T07:00:00.000Z'),
    },
  };
}

const cookie = (over) => ({
  name: 'a', value: '1', domain: '.example.co.uk', path: '/',
  secure: true, httpOnly: false, sameSite: 'lax', expirationDate: 1893456000,
  session: false, ...over,
});

test('bundle assembly keys cookies by site, dedupes, and partitions on the origin', async () => {
  const { deps, calls } = fakeDeps({
    getAll: (details) => {
      if (details.partitionKey) {
        return [
          cookie({ name: 'shared', value: 'partitioned', partitionKey: { topLevelSite: 'https://app.example.co.uk' } }),
          cookie({ name: 'only-partitioned', value: 'p', partitionKey: { topLevelSite: 'https://app.example.co.uk' } }),
        ];
      }
      return [
        cookie({ name: 'shared', value: 'plain' }),
        cookie({ name: 'shared', value: 'plain-again' }), // same identity: deduped
        cookie({ name: 'session-only', value: 's', expirationDate: undefined, session: true }),
      ];
    },
  });

  const bundle = await exportOrigins(['https://app.example.co.uk'], deps);

  assert.equal(bundle.version, BUNDLE_VERSION);
  assert.equal(bundle.createdAt, '2026-09-03T07:00:00.000Z');
  assert.deepEqual(bundle.browser, { name: 'chrome', version: '152.0.0.0' });
  assert.equal(bundle.origins.length, 1);

  const entry = bundle.origins[0];
  assert.equal(entry.origin, 'https://app.example.co.uk');
  assert.equal(entry.site, 'example.co.uk');
  assert.deepEqual(entry.errors, []);

  assert.deepEqual(calls.getAll, [
    { domain: 'example.co.uk' },
    { domain: 'example.co.uk', partitionKey: { topLevelSite: 'https://app.example.co.uk' } },
  ]);

  // Five cookies came back across the two passes; the two identical
  // unpartitioned "shared" rows are one cookie, while the partitioned "shared"
  // is a genuinely different cookie (the dedupe key carries topLevelSite).
  assert.equal(entry.cookies.length, 4);
  const names = entry.cookies.map((c) => c.name).sort();
  assert.deepEqual(names, ['only-partitioned', 'session-only', 'shared', 'shared']);

  const shared = entry.cookies.filter((c) => c.name === 'shared');
  assert.equal(shared.length, 2, 'the duplicate unpartitioned row collapsed');
  const unpartitioned = shared.find((c) => c.partitionKey === null);
  const partitioned = shared.find((c) => c.partitionKey !== null);
  assert.equal(unpartitioned.value, 'plain-again', 'last write wins within a pass');
  assert.equal(partitioned.value, 'partitioned');
  assert.deepEqual(partitioned.partitionKey, { topLevelSite: 'https://app.example.co.uk' });

  const plain = entry.cookies.find((c) => c.name === 'session-only');
  assert.equal(plain.partitionKey, null, 'unpartitioned cookies carry an explicit null');
  assert.equal(plain.session, true);
  assert.equal(plain.expirationDate, 0);
});

test('a partitionKey call that throws still ships the unpartitioned cookies', async () => {
  const { deps } = fakeDeps({
    getAll: (details) => {
      if (details.partitionKey) throw new Error('partitionKey is not supported');
      return [cookie({ name: 'grz_http', value: 'secret', httpOnly: true })];
    },
  });

  const bundle = await exportOrigins(['https://app.example.co.uk'], deps);
  const entry = bundle.origins[0];

  assert.equal(entry.cookies.length, 1);
  assert.equal(entry.cookies[0].name, 'grz_http');
  assert.equal(entry.cookies[0].httpOnly, true);
  assert.equal(entry.errors.length, 1);
  assert.equal(entry.errors[0].stage, 'cookies');
  assert.match(entry.errors[0].message, /partitionKey is not supported/);
});

test('web storage comes from a background tab that is opened and closed again', async () => {
  const { deps, calls } = fakeDeps({
    getAll: () => [],
    dump: {
      localStorage: { grz_ls: '1' },
      indexedDB: [{ name: 'grzdb', version: 2, stores: [{ name: 'items', keyPath: 'id', autoIncrement: false, indexes: [], records: [{ key: 1, value: { id: 1 } }], truncated: false }] }],
      errors: [{ stage: 'indexedDB', message: 'one store was unreadable' }],
    },
  });

  const bundle = await exportOrigins(['https://example.com'], deps);
  const entry = bundle.origins[0];

  assert.deepEqual(calls.created, [{ url: 'https://example.com/', active: false }]);
  assert.deepEqual(calls.removed, [99], 'a tab we opened is a tab we close');
  assert.deepEqual(entry.localStorage, { grz_ls: '1' });
  assert.equal(entry.indexedDB[0].name, 'grzdb');
  assert.deepEqual(entry.errors, [{ stage: 'indexedDB', message: 'one store was unreadable' }]);
  assert.equal(calls.executeScript[0].target.tabId, 99);
  assert.equal(calls.executeScript[0].func, pageDump);
});

test('an already-open tab is reused and left alone', async () => {
  const { deps, calls } = fakeDeps({
    getAll: () => [],
    tabs: [{ id: 7, status: 'complete' }],
  });

  await exportOrigins(['https://example.com'], deps);

  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.removed, [], 'the user keeps the tab they had open');
  assert.equal(calls.executeScript[0].target.tabId, 7);
});

test('one failing origin does not sink the rest of the bundle', async () => {
  const { deps } = fakeDeps({ getAll: () => [cookie({ name: 'ok' })] });
  const bundle = await exportOrigins(['not a url', 'https://example.com'], deps);

  assert.equal(bundle.origins.length, 2);
  assert.equal(bundle.origins[0].errors.length, 1);
  assert.deepEqual(bundle.origins[0].cookies, []);
  assert.equal(bundle.origins[1].cookies.length, 1);
});

test('summariseBundle reports the counts the popup shows', async () => {
  const { deps } = fakeDeps({
    getAll: (details) => (details.partitionKey ? [] : [cookie({ name: 'a' }), cookie({ name: 'b' })]),
    dump: {
      localStorage: { one: '1', two: '2' },
      indexedDB: [{ name: 'db', version: 1, stores: [{ name: 's', records: [{}, {}, {}] }] }],
      errors: [],
    },
  });
  const bundle = await exportOrigins(['https://example.com'], deps);
  assert.deepEqual(summariseBundle(bundle), [
    { origin: 'https://example.com', cookies: 2, localStorage: 2, indexedDB: 3, errors: 0 },
  ]);
});

// ------------------------------------------------- waiting for a tab ------

/** A fake chrome.tabs whose onUpdated can be made to miss its own event. */
function fakeTabs({ statuses, dropEvents = false, gone = false }) {
  const listeners = new Set();
  let index = 0;
  return {
    api: {
      tabs: {
        onUpdated: {
          addListener: (fn) => listeners.add(fn),
          removeListener: (fn) => listeners.delete(fn),
        },
        get: async (tabId) => {
          if (gone) throw new Error('No tab with id');
          const status = statuses[Math.min(index, statuses.length - 1)];
          index += 1;
          return { id: tabId, status };
        },
      },
    },
    emitComplete: (tabId) => {
      if (dropEvents) return;
      for (const fn of listeners) fn(tabId, { status: 'complete' });
    },
    get listenerCount() { return listeners.size; },
  };
}

test('a tab that completes is noticed through the onUpdated event', async () => {
  const fake = fakeTabs({ statuses: ['loading', 'loading', 'loading'] });
  const waiting = waitForTabComplete(fake.api, 5, { timeoutMs: 2000, pollMs: 10 });
  setTimeout(() => fake.emitComplete(5), 20);
  await waiting;
  assert.equal(fake.listenerCount, 0, 'the listener is removed once it resolves');
});

test('a completion that fired before the listener existed is still noticed', async () => {
  // The regression: addListener registers asynchronously in the browser
  // process, so a fast page can dispatch "complete" while that is in flight.
  // With no event ever delivered, only polling the tab's own status finds it.
  const fake = fakeTabs({ statuses: ['loading', 'complete'], dropEvents: true });
  await waitForTabComplete(fake.api, 7, { timeoutMs: 2000, pollMs: 10 });
  assert.equal(fake.listenerCount, 0);
});

test('a tab that goes away fails fast instead of waiting out the timeout', async () => {
  const fake = fakeTabs({ statuses: ['loading'], gone: true, dropEvents: true });
  await assert.rejects(
    () => waitForTabComplete(fake.api, 9, { timeoutMs: 5000, pollMs: 10 }),
    /went away before it finished loading/,
  );
});

test('a tab that never finishes loading times out with the tab in the message', async () => {
  const fake = fakeTabs({ statuses: ['loading'], dropEvents: true });
  await assert.rejects(
    () => waitForTabComplete(fake.api, 11, { timeoutMs: 120, pollMs: 10 }),
    /tab 11 did not finish loading/,
  );
  assert.equal(fake.listenerCount, 0, 'the listener is removed on timeout too');
});

test('cookies that differ only where one field ends and the next begins stay distinct', () => {
  // The dedupe key joins name, domain, path and topLevelSite. Joined with no
  // separator, ("ab", "c") and ("a", "bc") would collide.
  const deps = {
    cookies: {
      getAll: async (details) => (details.partitionKey ? [] : [
        cookie({ name: 'ab', domain: 'c.example.com', path: '/' }),
        cookie({ name: 'a', domain: 'bc.example.com', path: '/' }),
      ]),
    },
    tabs: { query: async () => [{ id: 1, status: 'complete' }], create: async () => ({ id: 1 }), remove: async () => {} },
    scripting: { executeScript: async () => [{ result: { localStorage: {}, indexedDB: [], errors: [] } }] },
    waitForComplete: async () => {},
    browser: { name: 'chrome', version: '1' },
    now: () => new Date(0),
  };
  return exportOrigins(['https://example.com'], deps).then((bundle) => {
    assert.equal(bundle.origins[0].cookies.length, 2, 'two different cookies, two entries');
  });
});

test('browser version is read out of the user agent', () => {
  assert.equal(
    browserVersionFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.66 Safari/537.36'),
    '152.0.7977.66',
  );
  assert.equal(browserVersionFromUserAgent('something else'), 'unknown');
});

/* ------------------------------------------ AC-1: CDP awaits have deadlines */
//
// A test that cannot finish is worse than a test that fails. On 2026-09-03 a
// silent `Extensions.loadUnpacked` hung a full node --test run for 18 minutes
// and took the detail of six other failures with it. These prove the deadline
// with a fake socket — no browser, so they cost nothing and always run.

/** A socket that answers whatever it is told to, and stays silent otherwise. */
function fakeSocket({ silentMethods = [], replies = {} } = {}) {
  const sent = [];
  const socket = {
    sent,
    closed: false,
    // A real socket opens; the deadline on `opened` is exercised separately.
    open() {
      queueMicrotask(() => socket.onopen?.());
    },
    send(raw) {
      const frame = JSON.parse(raw);
      sent.push(frame);
      if (silentMethods.includes(frame.method)) return; // never answers
      queueMicrotask(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            id: frame.id,
            result: replies[frame.method] ?? {},
          }),
        }),
      );
    },
    close() {
      socket.closed = true;
    },
  };
  queueMicrotask(() => socket.onopen?.());
  return socket;
}

test('AC-1: a method that is never answered rejects, naming it and the elapsed ms', async () => {
  const { createCdpClient, CDP_TIMEOUT } = await import('./support/cdp-deadline.mjs');
  const socket = fakeSocket({ silentMethods: ['Extensions.loadUnpacked'] });
  const cdp = createCdpClient(socket, { timeoutMs: 120 });

  const startedAt = Date.now();
  const failure = await cdp
    .call('Extensions.loadUnpacked', { path: 'x' })
    .then(() => null, (error) => error);
  const elapsed = Date.now() - startedAt;

  assert.ok(failure, 'a silent reply resolved instead of rejecting — this is the hang');
  assert.match(failure.message, /Extensions\.loadUnpacked timed out after \d+ ms/);
  assert.equal(failure.code, CDP_TIMEOUT, 'a timeout must be distinguishable from a protocol error');
  assert.ok(elapsed < 5000, `rejected after ${elapsed} ms, which is not a deadline`);
  assert.equal(cdp.pendingCount, 0, 'the timed-out waiter was left in the pending map');
});

test('AC-1: a method that IS answered still resolves normally', async () => {
  const { createCdpClient } = await import('./support/cdp-deadline.mjs');
  const socket = fakeSocket({
    silentMethods: ['Extensions.loadUnpacked'],
    replies: { 'Target.getTargets': { targetInfos: [{ type: 'page' }] } },
  });
  const cdp = createCdpClient(socket, { timeoutMs: 120 });

  const result = await cdp.call('Target.getTargets', {});
  assert.deepEqual(result, { targetInfos: [{ type: 'page' }] });
  assert.equal(cdp.pendingCount, 0);
});

test('AC-1: a CDP protocol error is not reported as a timeout', async () => {
  const { createCdpClient, CDP_TIMEOUT } = await import('./support/cdp-deadline.mjs');
  const socket = fakeSocket();
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    socket.sent.push(frame);
    queueMicrotask(() =>
      socket.onmessage?.({
        data: JSON.stringify({ id: frame.id, error: { message: "wasn't found" } }),
      }),
    );
  };
  const cdp = createCdpClient(socket, { timeoutMs: 120 });

  const failure = await cdp.call('Extensions.loadUnpacked', {}).then(() => null, (error) => error);
  assert.match(failure.message, /Extensions\.loadUnpacked: wasn't found/);
  assert.notEqual(
    failure.code,
    CDP_TIMEOUT,
    'a refusal must stay distinguishable, or the fallback path cannot tell them apart',
  );
});

test('AC-1: a socket that never opens does not hang either', async () => {
  const { withDeadline, CDP_TIMEOUT } = await import('./support/cdp-deadline.mjs');
  const failure = await withDeadline(new Promise(() => {}), 'ws open', { timeoutMs: 80 })
    .then(() => null, (error) => error);
  assert.match(failure.message, /ws open timed out after \d+ ms/);
  assert.equal(failure.code, CDP_TIMEOUT);
});

test('AC-1: the deadline timer does not keep the process alive', async () => {
  const { withDeadline } = await import('./support/cdp-deadline.mjs');
  // Resolving before the deadline must clear the timer; an uncleared 10-minute
  // timer would keep node alive long after the tests finished.
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await withDeadline(Promise.resolve('done'), 'fast', { timeoutMs: 600_000 });
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.ok(after <= before, `a timer was left pending (${before} -> ${after})`);
});
