// Tagged JSON codec for structured-clone values.
//
// IndexedDB keys and values are structured-clone data, so a plain
// JSON.stringify silently destroys Dates, binary, Maps and Sets. Every
// non-JSON kind gets a `$t` tag; plain objects, arrays, strings, numbers,
// booleans and null pass through untouched.
//
//   { "$t": "Date",        "v": "<iso>" }
//   { "$t": "ArrayBuffer", "v": "<base64>" }
//   { "$t": "Uint8Array",  "v": "<base64>" }   // one tag per typed-array kind
//   { "$t": "Blob", "type": "<mime>", "v": "<base64>" }
//   { "$t": "Map",         "v": [[k, v], ...] }
//   { "$t": "Set",         "v": [...] }
//   { "$t": "undefined" }
//
// A plain object that genuinely carries a "$t" key is escaped as
// { "$t": "object", "v": { ... } } so decode never mistakes data for a tag.
//
// NOTE: `page-dump.mjs` carries an inlined copy of the *encoder* because
// chrome.scripting.executeScript serialises the injected function and drops
// every import. Anything added here must be added there; the unit suite
// asserts the two agree on the tag set.

const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

export const CODEC_TAGS = Object.freeze([
  'Date',
  'ArrayBuffer',
  'Blob',
  'Map',
  'Set',
  'BigInt',
  'undefined',
  'object',
  ...Object.keys(TYPED_ARRAYS),
]);

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encode a structured-clone value into JSON-safe data.
 * Blob is async-only, so it is not handled here; the injected page dump reads
 * Blob bytes before calling into JSON. Circular structures throw.
 * @param {unknown} value
 * @returns {unknown}
 */
export function encode(value, seen = new Set()) {
  if (value === undefined) return { $t: 'undefined' };
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value) ? value : { $t: 'undefined' };
  if (kind === 'bigint') return { $t: 'BigInt', v: value.toString() };
  if (kind === 'function' || kind === 'symbol') return { $t: 'undefined' };

  if (value instanceof Date) return { $t: 'Date', v: value.toISOString() };
  if (value instanceof ArrayBuffer) {
    return { $t: 'ArrayBuffer', v: bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const tag = value.constructor?.name;
    if (tag && tag in TYPED_ARRAYS) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { $t: tag, v: bytesToBase64(bytes) };
    }
  }
  if (value instanceof DataView) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $t: 'ArrayBuffer', v: bytesToBase64(bytes) };
  }

  if (seen.has(value)) throw new Error('circular structure cannot be encoded');
  seen.add(value);
  try {
    if (value instanceof Map) {
      return { $t: 'Map', v: [...value].map(([k, v]) => [encode(k, seen), encode(v, seen)]) };
    }
    if (value instanceof Set) {
      return { $t: 'Set', v: [...value].map((v) => encode(v, seen)) };
    }
    if (Array.isArray(value)) return value.map((v) => encode(v, seen));

    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v, seen);
    if (Object.hasOwn(out, '$t')) return { $t: 'object', v: out };
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Decode what `encode` produced back into live values.
 * @param {unknown} value
 * @returns {unknown}
 */
export function decode(value) {
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
      return typeof Blob === 'function'
        ? new Blob([bytes], { type: value.type || '' })
        : { type: value.type || '', bytes };
    }
    if (tag === 'Map') return new Map(value.v.map(([k, v]) => [decode(k), decode(v)]));
    if (tag === 'Set') return new Set(value.v.map(decode));
    if (tag === 'object') {
      // An escaped plain object: decode its fields, but never re-read the
      // object itself as a tag.
      const plain = {};
      for (const [k, v] of Object.entries(value.v)) plain[k] = decode(v);
      return plain;
    }
    if (tag in TYPED_ARRAYS) {
      const bytes = base64ToBytes(value.v);
      const Ctor = TYPED_ARRAYS[tag];
      return Ctor === Uint8Array ? bytes : new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
    }
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = decode(v);
  return out;
}
