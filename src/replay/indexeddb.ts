/**
 * IndexedDB replay.
 *
 * CDP has no IndexedDB *write* API — `IndexedDB.requestData` reads, nothing
 * writes — so the only route is to run real IndexedDB calls inside a page on
 * the target origin. `index.ts` puts a page there without letting the real site
 * execute (a fulfilled blank navigation); this module supplies the script that
 * runs in it.
 *
 * The decoder below is inlined into that script on purpose: `Runtime.evaluate`
 * hands the page a source string, and a page has no module resolver, so it
 * cannot import `extension/lib/idb-codec.mjs`. `test/replay.unit.test.mjs`
 * pins this copy against that module over every codec tag, the same discipline
 * `page-dump.mjs` uses for the encoder half.
 */

import type { BundleIdbDatabase } from "./bundle.js";
import type { ReplaySend } from "./types.js";

/** The decoder, as page source. Mirrors `decode` in extension/lib/idb-codec.mjs. */
export const DECODER_SOURCE = `
const TYPED_ARRAYS = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array,
  BigInt64Array, BigUint64Array,
};
function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
function decode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decode);
  const tag = value.$t;
  if (typeof tag === 'string') {
    if (tag === 'undefined') return undefined;
    if (tag === 'Date') return new Date(value.v);
    if (tag === 'BigInt') return BigInt(value.v);
    if (tag === 'ArrayBuffer') return base64ToBytes(value.v).buffer;
    if (tag === 'Blob') {
      const bytes = base64ToBytes(value.v);
      return new Blob([bytes], { type: value.type || '' });
    }
    if (tag === 'Map') return new Map(value.v.map(([k, v]) => [decode(k), decode(v)]));
    if (tag === 'Set') return new Set(value.v.map(decode));
    if (tag === 'object') {
      const plain = {};
      for (const [k, v] of Object.entries(value.v)) plain[k] = decode(v);
      return plain;
    }
    if (tag in TYPED_ARRAYS) {
      const bytes = base64ToBytes(value.v);
      const Ctor = TYPED_ARRAYS[tag];
      return Ctor === Uint8Array
        ? bytes
        : new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = decode(v);
  return out;
}
`;

/**
 * Build the seed script for one origin's databases.
 *
 * Exported so a unit test can read the generated source without a browser.
 */
export function buildSeedScript(databases: readonly BundleIdbDatabase[]): string {
  return `(async () => {
${DECODER_SOURCE}
const databases = ${JSON.stringify(databases)};
let written = 0;

const openDatabase = (spec) => new Promise((resolve, reject) => {
  const request = indexedDB.open(spec.name, spec.version);
  request.onupgradeneeded = () => {
    const db = request.result;
    const tx = request.transaction;
    for (const store of spec.stores) {
      const existing = db.objectStoreNames.contains(store.name);
      const objectStore = existing
        ? tx.objectStore(store.name)
        : db.createObjectStore(store.name, {
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
          });
      for (const index of store.indexes) {
        if (!objectStore.indexNames.contains(index.name)) {
          objectStore.createIndex(index.name, index.keyPath, {
            unique: index.unique,
            multiEntry: index.multiEntry,
          });
        }
      }
    }
  };
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('open blocked: ' + spec.name));
  request.onsuccess = () => resolve(request.result);
});

for (const spec of databases) {
  const withStores = spec.stores.filter((store) => store.records.length > 0);
  const db = await openDatabase(spec);
  try {
    if (withStores.length === 0) continue;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(withStores.map((store) => store.name), 'readwrite');
      for (const store of withStores) {
        const objectStore = tx.objectStore(store.name);
        for (const record of store.records) {
          const value = decode(record.value);
          // An in-line store derives its key from the value; passing a key as
          // well is a DataError, so the key only travels for out-of-line stores.
          if (store.keyPath === null || store.keyPath === undefined) {
            objectStore.put(value, decode(record.key));
          } else {
            objectStore.put(value);
          }
          written += 1;
        }
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
return written;
})()`;
}

/**
 * Run the seed inside an already-navigated page session.
 *
 * Rejects with the page's own error text: an IndexedDB failure is the one thing
 * here a caller may genuinely need to read and act on.
 */
export async function replayIndexedDb(
  send: ReplaySend,
  sessionId: string,
  databases: readonly BundleIdbDatabase[],
): Promise<number> {
  const withRecords = databases.filter((db) =>
    db.stores.some((store) => store.records.length > 0 || store.indexes.length > 0),
  );
  if (withRecords.length === 0) {
    return 0;
  }
  const response = await send(
    "Runtime.evaluate",
    {
      expression: buildSeedScript(withRecords),
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (response?.exceptionDetails) {
    const details = response.exceptionDetails;
    throw new Error(
      details.exception?.description ?? details.text ?? "IndexedDB seed failed",
    );
  }
  const written = response?.result?.value;
  return typeof written === "number" ? written : 0;
}
