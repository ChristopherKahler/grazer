// The extension id Chrome derives from manifest.json's `key`.
//
// A packed extension's id is the first 128 bits of sha256 over the DER-encoded
// SPKI public key, rendered in a 16-letter alphabet: hex digit 0-f maps to
// a-p. Committing the public key in `key` pins the id, which matters because
// the native messaging host manifest names it in `allowed_origins` — so the
// registration command computes it here rather than asking anyone to copy it
// out of chrome://extensions.
//
// WebCrypto, so this one implementation runs both in Node (registration) and
// in the service worker.

const ID_ALPHABET_OFFSET = 'a'.charCodeAt(0);

function base64ToBytes(base64) {
  const normalised = base64.replace(/\s+/g, '');
  if (typeof Buffer === 'function') return new Uint8Array(Buffer.from(normalised, 'base64'));
  const binary = atob(normalised);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * @param {string} base64Spki manifest.json's `key` value
 * @returns {Promise<string>} the 32-character extension id
 */
export async function extensionIdFromKey(base64Spki) {
  if (typeof base64Spki !== 'string' || base64Spki.length === 0) {
    throw new Error('extension key is missing');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', base64ToBytes(base64Spki)),
  );
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    id += String.fromCharCode(ID_ALPHABET_OFFSET + (digest[i] >> 4));
    id += String.fromCharCode(ID_ALPHABET_OFFSET + (digest[i] & 0x0f));
  }
  return id;
}

/**
 * Read `key` out of a manifest object and derive the id from it.
 * @param {{ key?: string }} manifest
 * @returns {Promise<string>}
 */
export async function extensionIdFromManifest(manifest) {
  return extensionIdFromKey(manifest?.key);
}
