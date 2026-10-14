// Bundle assembly: cookies + web storage for a set of origins.
//
// ============================ BUNDLE SCHEMA v1 =============================
// Frozen contract. Plan 04-02 (replay) consumes exactly this shape; additions
// go in a v2, never in place.
//
// {
//   "version": 1,
//   "createdAt": "<iso>",
//   "browser": { "name": "chrome|brave", "version": "<ua version>" },
//   "origins": [
//     {
//       "origin": "https://example.com",
//       "site": "example.com",
//       "cookies": [ { "name":"", "value":"", "domain":"", "path":"",
//                      "secure":true, "httpOnly":true,
//                      "sameSite":"lax|strict|no_restriction|unspecified",
//                      "expirationDate":0, "session":false,
//                      "partitionKey": { "topLevelSite": "" } } ],
//       "localStorage": { "key": "value" },
//       "indexedDB": [ { "name":"", "version":1, "stores":[
//                        { "name":"", "keyPath":null, "autoIncrement":false,
//                          "indexes":[ { "name":"", "keyPath":"",
//                                        "unique":false, "multiEntry":false } ],
//                          "records":[ { "key":{}, "value":{} } ],
//                          "truncated":false } ] } ],
//       "errors": [ { "stage":"cookies|localStorage|indexedDB|tab", "message":"" } ]
//     }
//   ]
// }
//
// `partitionKey` is always present on a cookie and is `null` when the cookie is
// unpartitioned — replay checks for null rather than for a missing key.
// Record keys and values are idb-codec tagged data; see `idb-codec.mjs`.
// ===========================================================================

import { siteOf, originOf, matchPatternFor } from './site.mjs';
import { pageDump, DEFAULT_MAX_STORE_BYTES } from './page-dump.mjs';

export const BUNDLE_VERSION = 1;

const TAB_LOAD_TIMEOUT_MS = 30000;

/** @param {string} userAgent */
export function browserVersionFromUserAgent(userAgent) {
  const match = /Chrom(?:e|ium)\/([\d.]+)/.exec(userAgent || '');
  return match ? match[1] : 'unknown';
}

/**
 * Build the dependency bag the export pipeline runs against. Every browser
 * touchpoint goes through here so unit tests can hand in a fake `chrome`.
 * @param {typeof chrome} api
 * @param {{ userAgent?: string, isBrave?: boolean, maxStoreBytes?: number }} [overrides]
 */
export function chromeDeps(api, overrides = {}) {
  const userAgent = overrides.userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const isBrave = overrides.isBrave
    ?? (typeof navigator !== 'undefined' && typeof navigator.brave === 'object');
  return {
    cookies: { getAll: (details) => api.cookies.getAll(details) },
    tabs: {
      query: (info) => api.tabs.query(info),
      create: (info) => api.tabs.create(info),
      remove: (tabId) => api.tabs.remove(tabId),
    },
    scripting: { executeScript: (injection) => api.scripting.executeScript(injection) },
    waitForComplete: (tabId) => waitForTabComplete(api, tabId),
    browser: { name: isBrave ? 'brave' : 'chrome', version: browserVersionFromUserAgent(userAgent) },
    maxStoreBytes: overrides.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES,
    now: () => new Date(),
  };
}

/**
 * Resolve once the tab reports status "complete".
 *
 * The onUpdated event is the fast path, but it is not sufficient on its own:
 * addListener registers asynchronously in the browser process, so a page that
 * finishes loading while that registration is in flight can dispatch its
 * "complete" update before this listener exists. A local page reaches complete
 * in well under 100ms, which is inside that window. Sampling tabs.get once is
 * not enough either — it can land while the tab is still "loading" and leave
 * nothing to catch the completion that already happened. So poll the tab's own
 * status as well, and let whichever notices first win.
 */
export function waitForTabComplete(api, tabId, { timeoutMs = TAB_LOAD_TIMEOUT_MS, pollMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearInterval(poll);
      api.tabs.onUpdated.removeListener(listener);
      if (err) reject(err);
      else resolve();
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') finish();
    };
    const check = () => {
      api.tabs.get(tabId).then(
        (tab) => { if (tab && tab.status === 'complete') finish(); },
        () => finish(new Error(`tab ${tabId} went away before it finished loading`)),
      );
    };

    const deadline = setTimeout(() => finish(new Error(`tab ${tabId} did not finish loading`)), timeoutMs);
    const poll = setInterval(check, pollMs);
    api.tabs.onUpdated.addListener(listener);
    check();
  });
}

const messageOf = (err) => String((err && err.message) || err);

/** Identity of a cookie for dedupe purposes. */
function cookieKey(cookie) {
  const partition = cookie.partitionKey?.topLevelSite ?? '';
  // A newline cannot appear in a cookie name, domain or path, so it separates
  // the parts without two different cookies ever colliding on one key.
  return [cookie.name, cookie.domain, cookie.path, partition].join('\n');
}

/** Trim a chrome cookie down to the frozen schema fields. */
function normaliseCookie(cookie) {
  const partitionKey = cookie.partitionKey?.topLevelSite
    ? { topLevelSite: cookie.partitionKey.topLevelSite }
    : null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite ?? 'unspecified',
    expirationDate: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : 0,
    session: cookie.session === true || typeof cookie.expirationDate !== 'number',
    partitionKey,
  };
}

/**
 * Cookies for an origin: one pass by registrable domain, one partitioned pass
 * keyed on this origin. Partitioned cookies (CHIPS) need the second call and it
 * throws outright on Chrome < 119, so a failure there is recorded and the
 * unpartitioned set still ships.
 */
async function collectCookies(origin, site, deps, errors) {
  const byKey = new Map();
  try {
    for (const cookie of await deps.cookies.getAll({ domain: site })) {
      byKey.set(cookieKey(cookie), normaliseCookie(cookie));
    }
  } catch (err) {
    errors.push({ stage: 'cookies', message: messageOf(err) });
  }
  try {
    const partitioned = await deps.cookies.getAll({
      domain: site,
      partitionKey: { topLevelSite: origin },
    });
    for (const cookie of partitioned) {
      byKey.set(cookieKey(cookie), normaliseCookie(cookie));
    }
  } catch (err) {
    errors.push({ stage: 'cookies', message: `partitioned: ${messageOf(err)}` });
  }
  return [...byKey.values()];
}

/**
 * Run the page dump in a tab of the origin, opening a background tab when the
 * user has none open and closing only what we opened.
 */
async function collectWebStorage(origin, deps, errors) {
  let tabId = null;
  let opened = false;
  try {
    const existing = await deps.tabs.query({ url: matchPatternFor(origin) });
    const usable = (existing || []).find((tab) => tab && tab.id != null && !tab.discarded);
    if (usable) {
      tabId = usable.id;
      if (usable.status !== 'complete') await deps.waitForComplete(tabId);
    } else {
      const tab = await deps.tabs.create({ url: `${origin}/`, active: false });
      tabId = tab.id;
      opened = true;
      await deps.waitForComplete(tabId);
    }
  } catch (err) {
    errors.push({ stage: 'tab', message: messageOf(err) });
    return { localStorage: {}, indexedDB: [] };
  }

  try {
    const results = await deps.scripting.executeScript({
      target: { tabId },
      func: pageDump,
      args: [deps.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES],
    });
    const dump = results && results[0] && results[0].result;
    if (!dump) throw new Error('page dump returned no result');
    for (const entry of dump.errors || []) errors.push(entry);
    return { localStorage: dump.localStorage || {}, indexedDB: dump.indexedDB || [] };
  } catch (err) {
    errors.push({ stage: 'tab', message: messageOf(err) });
    return { localStorage: {}, indexedDB: [] };
  } finally {
    if (opened && tabId != null) {
      try {
        await deps.tabs.remove(tabId);
      } catch {
        /* the user may have closed it first */
      }
    }
  }
}

/**
 * Export every origin into one v1 bundle. One bad origin never sinks the rest —
 * its failure lands in that origin's `errors` array.
 * @param {string[]} origins
 * @param {ReturnType<typeof chromeDeps>} deps
 */
export async function exportOrigins(origins, deps) {
  const entries = [];
  for (const raw of origins) {
    const errors = [];
    let origin;
    try {
      origin = originOf(raw);
    } catch (err) {
      entries.push({
        origin: String(raw),
        site: '',
        cookies: [],
        localStorage: {},
        indexedDB: [],
        errors: [{ stage: 'tab', message: messageOf(err) }],
      });
      continue;
    }
    const site = siteOf(origin);
    // Web storage first: when no tab of the origin is open we load one, and
    // that load can set cookies. Reading cookies afterwards means the bundle
    // reflects the browser at the end of the export rather than the start.
    const storage = await collectWebStorage(origin, deps, errors);
    const cookies = await collectCookies(origin, site, deps, errors);
    entries.push({
      origin,
      site,
      cookies,
      localStorage: storage.localStorage,
      indexedDB: storage.indexedDB,
      errors,
    });
  }

  const now = deps.now ? deps.now() : new Date();
  return {
    version: BUNDLE_VERSION,
    createdAt: now.toISOString(),
    browser: { name: deps.browser?.name ?? 'chrome', version: deps.browser?.version ?? 'unknown' },
    origins: entries,
  };
}

/** Per-origin counts the popup and the CLI report back to the user. */
export function summariseBundle(bundle) {
  return (bundle.origins || []).map((entry) => ({
    origin: entry.origin,
    cookies: (entry.cookies || []).length,
    localStorage: Object.keys(entry.localStorage || {}).length,
    indexedDB: (entry.indexedDB || []).reduce(
      (total, db) => total + (db.stores || []).reduce((n, store) => n + (store.records || []).length, 0),
      0,
    ),
    errors: (entry.errors || []).length,
  }));
}
