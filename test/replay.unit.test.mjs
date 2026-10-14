/**
 * Deterministic replay tests: bundle validation, the cookie mapper, the seed
 * script, and the inlined decoder. No browser.
 *
 * The decoder test is the important one. `indexeddb.ts` carries a COPY of the
 * extension's decoder because a page cannot import a module, and a copy that
 * silently drifts would restore Dates and typed arrays as plain objects — data
 * loss that looks like success. This pins the two together over every tag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLE_VERSION,
  buildSeedScript,
  bundlesDir,
  DECODER_SOURCE,
  loadBundle,
  newestBundlePath,
  parseBundle,
  toCookieParam,
} from "../dist/replay/index.js";
import { CODEC_TAGS, decode, encode } from "../extension/lib/idb-codec.mjs";
import { cleanHome } from "./support/clean-home.mjs";

/* --------------------------------------------------------------- fixtures */

const cookie = (over = {}) => ({
  name: "grz_http",
  value: "secret",
  domain: "127.0.0.1",
  path: "/",
  secure: false,
  httpOnly: true,
  sameSite: "unspecified",
  session: true,
  partitionKey: null,
  ...over,
});

const bundleWith = (over = {}) => ({
  version: BUNDLE_VERSION,
  createdAt: "2026-09-03T00:00:00.000Z",
  browser: { name: "chrome", version: "152.0.0.0" },
  origins: [
    {
      origin: "http://127.0.0.1:1234",
      site: "127.0.0.1",
      cookies: [cookie()],
      localStorage: { grz_ls: "1" },
      indexedDB: [],
      errors: [],
      ...over,
    },
  ],
});

/* ------------------------------------------------------- bundle validation */

test("parseBundle accepts a v1 bundle and normalises it", () => {
  const parsed = parseBundle(bundleWith());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.browser.name, "chrome");
  assert.equal(parsed.origins.length, 1);
  assert.equal(parsed.origins[0].origin, "http://127.0.0.1:1234");
  assert.deepEqual(parsed.origins[0].localStorage, { grz_ls: "1" });
});

test("parseBundle refuses a version it cannot read, naming it", () => {
  assert.throws(
    () => parseBundle({ version: 2, origins: [] }),
    /invalid bundle: unsupported version 2 \(this build reads v1\)/,
  );
});

test("parseBundle names the offending field rather than coercing", () => {
  assert.throws(() => parseBundle({ version: 1 }), /bundle\.origins must be an array/);
  assert.throws(
    () => parseBundle({ version: 1, origins: [{ site: "x" }] }),
    /bundle\.origins\[0\]\.origin must be a string/,
  );
  assert.throws(
    () => parseBundle({ version: 1, origins: [{ origin: "o", cookies: [{ value: "v" }] }] }),
    /bundle\.origins\[0\]\.cookies\[0\]\.name must be a string/,
  );
});

test("parseBundle drops a non-string localStorage value instead of stringifying it", () => {
  const parsed = parseBundle(bundleWith({ localStorage: { good: "1", bad: { a: 1 } } }));
  assert.deepEqual(parsed.origins[0].localStorage, { good: "1" });
});

test("parseBundle defaults an unknown sameSite to unspecified", () => {
  const parsed = parseBundle(bundleWith({ cookies: [cookie({ sameSite: "weird" })] }));
  assert.equal(parsed.origins[0].cookies[0].sameSite, "unspecified");
});

/* ------------------------------------------------------------ cookie mapper */

test("toCookieParam maps every sameSite spelling, omitting unspecified", () => {
  assert.equal(toCookieParam(cookie({ sameSite: "no_restriction" })).sameSite, "None");
  assert.equal(toCookieParam(cookie({ sameSite: "lax" })).sameSite, "Lax");
  assert.equal(toCookieParam(cookie({ sameSite: "strict" })).sameSite, "Strict");
  assert.ok(
    !Object.hasOwn(toCookieParam(cookie({ sameSite: "unspecified" })), "sameSite"),
    "unspecified omits the field so CDP keeps the browser default",
  );
});

test("toCookieParam carries expiry only for a non-session cookie", () => {
  assert.ok(
    !Object.hasOwn(
      toCookieParam(cookie({ session: true, expirationDate: 1893456000 })),
      "expires",
    ),
    "a session cookie must not outlive the session",
  );
  assert.equal(
    toCookieParam(cookie({ session: false, expirationDate: 1893456000 })).expires,
    1893456000,
  );
  assert.ok(!Object.hasOwn(toCookieParam(cookie({ session: false })), "expires"));
});

test("toCookieParam preserves httpOnly, secure and path, and defaults an empty path", () => {
  const param = toCookieParam(cookie({ httpOnly: true, secure: true, path: "" }));
  assert.equal(param.httpOnly, true);
  assert.equal(param.secure, true);
  assert.equal(param.path, "/");
});

test("toCookieParam maps a partition key and omits it when unpartitioned", () => {
  const partitioned = toCookieParam(
    cookie({ partitionKey: { topLevelSite: "https://top.example" } }),
  );
  assert.deepEqual(partitioned.partitionKey, {
    topLevelSite: "https://top.example",
    hasCrossSiteAncestor: false,
  });
  assert.ok(!Object.hasOwn(toCookieParam(cookie()), "partitionKey"));
});

/* ------------------------------------------------------------ bundle files */

test("loadBundle and newestBundlePath read the host's directory", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "grazer-replay-unit-"));
  t.after(() => cleanHome(home));

  assert.equal(await newestBundlePath(home), null, "no bundles dir yet");
  await mkdir(bundlesDir(home), { recursive: true });
  assert.equal(await newestBundlePath(home), null, "empty bundles dir");

  await writeFile(join(bundlesDir(home), "site-20260101-000000.json"), "{}");
  await writeFile(
    join(bundlesDir(home), "site-20260903-072526.json"),
    JSON.stringify(bundleWith()),
  );
  await writeFile(join(bundlesDir(home), "notes.txt"), "ignored");

  const newest = await newestBundlePath(home);
  assert.match(newest, /site-20260903-072526\.json$/, "newest by timestamped name");
  const loaded = await loadBundle(newest);
  assert.equal(loaded.origins[0].cookies[0].name, "grz_http");

  await assert.rejects(() => loadBundle(join(home, "missing.json")), /cannot read bundle/);
  await writeFile(join(home, "broken.json"), "{not json");
  await assert.rejects(() => loadBundle(join(home, "broken.json")), /is not valid JSON/);
});

/* --------------------------------------------------------- inlined decoder */

/** The page-side decoder, evaluated the way `Runtime.evaluate` would run it. */
const inlineDecode = new Function(`${DECODER_SOURCE}\nreturn decode;`)();

test("the inlined decoder agrees with the extension codec on every tag", () => {
  const samples = {
    Date: new Date("2024-05-06T07:08:09.000Z"),
    ArrayBuffer: new Uint8Array([1, 2, 3]).buffer,
    Uint8Array: new Uint8Array([1, 2, 3, 4, 5]),
    Int8Array: new Int8Array([-1, 2]),
    Uint8ClampedArray: new Uint8ClampedArray([9, 8]),
    Int16Array: new Int16Array([-300, 300]),
    Uint16Array: new Uint16Array([1, 65535]),
    Int32Array: new Int32Array([-70000, 70000]),
    Uint32Array: new Uint32Array([1, 4294967295]),
    Float32Array: new Float32Array([1.5, -2.5]),
    Float64Array: new Float64Array([1.25, -8.5]),
    BigInt64Array: new BigInt64Array([1n, -2n]),
    BigUint64Array: new BigUint64Array([1n, 2n]),
    Map: new Map([["a", 1]]),
    Set: new Set([1, 2]),
    BigInt: 42n,
    undefined: undefined,
    object: { $t: "not-a-tag", real: 1 },
  };
  // Every tag the codec declares must be exercised here, so a new tag upstream
  // fails this test rather than silently escaping the comparison.
  const covered = new Set(Object.keys(samples));
  const missing = CODEC_TAGS.filter((tag) => !covered.has(tag) && tag !== "Blob");
  assert.deepEqual(missing, [], `codec tags with no sample: ${missing.join(", ")}`);

  for (const [tag, value] of Object.entries(samples)) {
    const encoded = JSON.parse(JSON.stringify(encode(value)));
    const fromExtension = decode(encoded);
    const fromPage = inlineDecode(encoded);
    assert.deepEqual(fromPage, fromExtension, `tag ${tag} decoded differently`);
  }
});

test("the inlined decoder restores real types, not lookalikes", () => {
  const encoded = JSON.parse(
    JSON.stringify(
      encode({
        at: new Date("2024-05-06T07:08:09.000Z"),
        bytes: new Uint8Array([1, 2, 3, 4, 5]),
        nested: [new Map([["k", new Set([1])]])],
      }),
    ),
  );
  const decoded = inlineDecode(encoded);
  assert.ok(decoded.at instanceof Date);
  assert.equal(decoded.at.toISOString(), "2024-05-06T07:08:09.000Z");
  assert.ok(decoded.bytes instanceof Uint8Array);
  assert.deepEqual([...decoded.bytes], [1, 2, 3, 4, 5]);
  assert.ok(decoded.nested[0] instanceof Map);
  assert.ok(decoded.nested[0].get("k") instanceof Set);
});

/* ------------------------------------------------------------- seed script */

const storeSpec = (over = {}) => ({
  name: "items",
  keyPath: "id",
  autoIncrement: false,
  indexes: [{ name: "by_label", keyPath: "label", unique: false, multiEntry: false }],
  records: [{ key: 1, value: { id: 1, label: "plain" } }],
  truncated: false,
  ...over,
});

test("buildSeedScript passes a key only for an out-of-line store", () => {
  const inline = buildSeedScript([{ name: "db", version: 2, stores: [storeSpec()] }]);
  assert.match(inline, /store\.keyPath === null \|\| store\.keyPath === undefined/);
  // Both branches are present in the script; the runtime picks per store.
  assert.match(inline, /objectStore\.put\(value, decode\(record\.key\)\)/);
  assert.match(inline, /objectStore\.put\(value\);/);
});

test("buildSeedScript embeds the recorded version, stores and indexes", () => {
  const script = buildSeedScript([
    {
      name: "grzdb",
      version: 7,
      stores: [storeSpec({ keyPath: null, autoIncrement: true })],
    },
  ]);
  assert.match(script, /indexedDB\.open\(spec\.name, spec\.version\)/);
  assert.ok(script.includes('"version":7'), "the recorded version travels");
  assert.ok(script.includes('"autoIncrement":true'));
  assert.ok(script.includes('"by_label"'));
  assert.match(script, /createIndex\(index\.name, index\.keyPath, \{/);
  assert.match(script, /unique: index\.unique/);
  assert.match(script, /multiEntry: index\.multiEntry/);
});

test("buildSeedScript produces syntactically valid page source", () => {
  const script = buildSeedScript([{ name: "db", version: 1, stores: [storeSpec()] }]);
  // Compiles as an expression, which is what Runtime.evaluate is handed.
  assert.doesNotThrow(() => new Function(`return ${script};`));
});

/* ------------------------------------------- AC-1: the default context ---- */
//
// Every CDP call that takes an optional `browserContextId` acts on the DEFAULT
// browser context when the key is ABSENT. Present-with-undefined is a different
// frame and Chrome rejects it, so these tests check for absence with `in`
// rather than for an undefined value — `assert.equal(x.browserContextId,
// undefined)` would pass on exactly the frame that breaks.

/** A fake `send` that records every frame and answers the calls replay makes. */
function recordingSend({ cookiesBack = [] } = {}) {
  const frames = [];
  const send = async (method, params = {}, sessionId) => {
    frames.push({ method, params, sessionId });
    if (method === "Target.createTarget") return { targetId: "T-1" };
    if (method === "Target.attachToTarget") return { sessionId: "S-1" };
    if (method === "Storage.getCookies") return { cookies: cookiesBack };
    return {};
  };
  return { frames, send };
}

/** Frames that carry a context id, by CDP contract. */
const CONTEXT_BEARING = new Set([
  "Storage.setCookies",
  "Storage.getCookies",
  "Target.createTarget",
]);

async function runReplay(browserContextId) {
  const { replay } = await import("../dist/replay/index.js");
  const { frames, send } = recordingSend({
    cookiesBack: [{ name: "grz_http", domain: "127.0.0.1", path: "/" }],
  });
  const options = {
    send,
    onEvent: () => () => {},
    navigationTimeoutMs: 50,
  };
  if (browserContextId !== undefined) options.browserContextId = browserContextId;
  await replay(bundleWith(), options).catch(() => {});
  return frames;
}

test("AC-1: with no browserContextId, the key is absent from every frame", async () => {
  const frames = await runReplay(undefined);
  assert.ok(frames.length > 0, "replay sent nothing at all");

  for (const frame of frames) {
    assert.equal(
      "browserContextId" in frame.params,
      false,
      `${frame.method} carried a browserContextId key; omitted must mean absent, not undefined`,
    );
  }

  // And it really did try the calls that would otherwise carry one.
  const sent = new Set(frames.map((frame) => frame.method));
  assert.ok(
    [...CONTEXT_BEARING].some((method) => sent.has(method)),
    `none of the context-bearing calls were made; frames were ${[...sent].join(", ")}`,
  );
});

test("AC-1: with a browserContextId, every context-bearing frame carries it", async () => {
  const frames = await runReplay("CTX-SPACE");
  assert.ok(frames.length > 0, "replay sent nothing at all");

  const bearing = frames.filter((frame) => CONTEXT_BEARING.has(frame.method));
  assert.ok(bearing.length > 0, "no context-bearing frame was sent");
  for (const frame of bearing) {
    assert.equal(
      frame.params.browserContextId,
      "CTX-SPACE",
      `${frame.method} lost the caller's browserContextId`,
    );
  }
});

test("AC-1: withContext adds the key only when there is one", async () => {
  const { withContext } = await import("../dist/replay/context.js");
  assert.equal("browserContextId" in withContext({ a: 1 }, undefined), false);
  assert.deepEqual(withContext({ a: 1 }, undefined), { a: 1 });
  assert.deepEqual(withContext({ a: 1 }, "CTX"), { a: 1, browserContextId: "CTX" });
  // The caller's object is never mutated.
  const original = { a: 1 };
  withContext(original, "CTX");
  assert.deepEqual(original, { a: 1 });
});
