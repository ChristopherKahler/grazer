// The function injected into a page's isolated world to read its web storage.
//
// chrome.scripting.executeScript serialises this function with toString() and
// evaluates it in the target frame, so it CANNOT close over imports, module
// scope, or anything else in this file. Everything it needs — including a copy
// of the idb-codec encoder — lives inside the function body. Keep the tag set
// in step with `idb-codec.mjs`; the unit suite asserts they agree.

export const DEFAULT_MAX_STORE_BYTES = 50 * 1024 * 1024;

/**
 * Dump localStorage and every IndexedDB database for the page's own origin.
 * Runs in the page. Returns JSON-safe data only.
 *
 * @param {number} maxStoreBytes per-object-store budget; records past it are
 *   dropped and the store is marked `truncated`.
 * @param {number} openTimeoutMs how long to wait on a blocked or slow db open.
 * @returns {Promise<{ localStorage: Record<string,string>,
 *                     indexedDB: Array<object>,
 *                     errors: Array<{stage:string, message:string}> }>}
 */
export async function pageDump(maxStoreBytes, openTimeoutMs) {
  const budget = typeof maxStoreBytes === 'number' && maxStoreBytes > 0
    ? maxStoreBytes
    : 50 * 1024 * 1024;
  const openTimeout = typeof openTimeoutMs === 'number' && openTimeoutMs > 0
    ? openTimeoutMs
    : 10000;
  const errors = [];

  // ---- inlined encoder (mirror of extension/lib/idb-codec.mjs) ----
  const TYPED = {
    Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, Int16Array: 1,
    Uint16Array: 1, Int32Array: 1, Uint32Array: 1, Float32Array: 1,
    Float64Array: 1, BigInt64Array: 1, BigUint64Array: 1,
  };
  const b64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };
  const enc = async (value, seen) => {
    if (value === undefined) return { $t: 'undefined' };
    if (value === null) return null;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean') return value;
    if (kind === 'number') return Number.isFinite(value) ? value : { $t: 'undefined' };
    if (kind === 'bigint') return { $t: 'BigInt', v: value.toString() };
    if (kind === 'function' || kind === 'symbol') return { $t: 'undefined' };
    if (value instanceof Date) return { $t: 'Date', v: value.toISOString() };
    if (value instanceof ArrayBuffer) return { $t: 'ArrayBuffer', v: b64(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const tag = value.constructor && value.constructor.name;
      if (tag && TYPED[tag]) {
        return { $t: tag, v: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      }
    }
    if (value instanceof DataView) {
      return { $t: 'ArrayBuffer', v: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (typeof Blob === 'function' && value instanceof Blob) {
      const buf = await value.arrayBuffer();
      return { $t: 'Blob', type: value.type || '', v: b64(new Uint8Array(buf)) };
    }
    if (seen.has(value)) throw new Error('circular structure cannot be encoded');
    seen.add(value);
    try {
      if (value instanceof Map) {
        const pairs = [];
        for (const [k, v] of value) pairs.push([await enc(k, seen), await enc(v, seen)]);
        return { $t: 'Map', v: pairs };
      }
      if (value instanceof Set) {
        const items = [];
        for (const v of value) items.push(await enc(v, seen));
        return { $t: 'Set', v: items };
      }
      if (Array.isArray(value)) {
        const out = [];
        for (const v of value) out.push(await enc(v, seen));
        return out;
      }
      const out = {};
      for (const k of Object.keys(value)) out[k] = await enc(value[k], seen);
      return Object.prototype.hasOwnProperty.call(out, '$t') ? { $t: 'object', v: out } : out;
    } finally {
      seen.delete(value);
    }
  };
  const encode = (value) => enc(value, new Set());
  // ---- end inlined encoder ----

  const settleRequest = (request, what) => new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(what + ' timed out'));
    }, openTimeout);
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || new Error(what + ' failed'));
    request.onblocked = () => finish(reject, new Error(what + ' blocked'));
  });

  // ---- localStorage ----
  const local = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key === null) continue;
      local[key] = localStorage.getItem(key);
    }
  } catch (err) {
    errors.push({ stage: 'localStorage', message: String((err && err.message) || err) });
  }

  // ---- IndexedDB ----
  const databases = [];
  try {
    if (!self.indexedDB || typeof indexedDB.databases !== 'function') {
      throw new Error('indexedDB.databases() unavailable');
    }
    const listed = await indexedDB.databases();
    for (const info of listed) {
      if (!info || !info.name) continue;
      let db = null;
      try {
        db = await settleRequest(indexedDB.open(info.name), 'open ' + info.name);
        const storeNames = Array.from(db.objectStoreNames);
        const stores = [];
        for (const storeName of storeNames) {
          const store = db.transaction(storeName, 'readonly').objectStore(storeName);
          const indexes = Array.from(store.indexNames).map((indexName) => {
            const idx = store.index(indexName);
            return {
              name: idx.name,
              keyPath: idx.keyPath,
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            };
          });
          const records = [];
          let bytes = 0;
          let truncated = false;
          try {
            const entries = await new Promise((resolve, reject) => {
              const acc = [];
              const req = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
              const timer = setTimeout(() => reject(new Error('cursor ' + storeName + ' timed out')), openTimeout);
              req.onerror = () => {
                clearTimeout(timer);
                reject(req.error || new Error('cursor failed'));
              };
              req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                  clearTimeout(timer);
                  resolve(acc);
                  return;
                }
                acc.push({ key: cursor.key, value: cursor.value });
                cursor.continue();
              };
            });
            for (const entry of entries) {
              const encoded = { key: await encode(entry.key), value: await encode(entry.value) };
              bytes += JSON.stringify(encoded).length;
              if (bytes > budget) {
                truncated = true;
                break;
              }
              records.push(encoded);
            }
          } catch (err) {
            errors.push({
              stage: 'indexedDB',
              message: info.name + '/' + storeName + ': ' + String((err && err.message) || err),
            });
          }
          stores.push({
            name: store.name,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes,
            records,
            truncated,
          });
        }
        databases.push({ name: db.name, version: db.version, stores });
      } catch (err) {
        errors.push({
          stage: 'indexedDB',
          message: info.name + ': ' + String((err && err.message) || err),
        });
      } finally {
        if (db) {
          try {
            db.close();
          } catch {
            /* already closed */
          }
        }
      }
    }
  } catch (err) {
    errors.push({ stage: 'indexedDB', message: String((err && err.message) || err) });
  }

  return { localStorage: local, indexedDB: databases, errors };
}
