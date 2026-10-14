/**
 * localStorage replay.
 *
 * `DOMStorage.setDOMStorageItem` needs a live renderer that already holds the
 * origin's security context — the origin has to exist in a page before it can
 * be written to. The seeding tab in `index.ts` is what provides that, which is
 * why this runs after the fulfilled navigation and not before it.
 */

import type { ReplaySend } from "./types.js";

interface StorageId {
  securityOrigin: string;
  isLocalStorage: boolean;
}

function storageId(origin: string): StorageId {
  return { securityOrigin: origin, isLocalStorage: true };
}

/**
 * Write every entry, then read the store back and count what survived.
 *
 * Returns the verified count rather than the attempted one: a quota rejection
 * resolves quietly, and reporting keys that are not actually there would make
 * a half-replayed login look complete.
 */
export async function replayLocalStorage(
  send: ReplaySend,
  sessionId: string,
  origin: string,
  entries: Record<string, string>,
): Promise<number> {
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return 0;
  }
  await send("DOMStorage.enable", {}, sessionId);
  const id = storageId(origin);
  for (const key of keys) {
    await send(
      "DOMStorage.setDOMStorageItem",
      { storageId: id, key, value: entries[key] },
      sessionId,
    );
  }
  const stored = await send("DOMStorage.getDOMStorageItems", { storageId: id }, sessionId);
  const present = new Set(
    (Array.isArray(stored?.entries) ? stored.entries : [])
      .filter((entry: unknown): entry is string[] => Array.isArray(entry))
      .map((entry: string[]) => entry[0]),
  );
  return keys.filter((key) => present.has(key)).length;
}
