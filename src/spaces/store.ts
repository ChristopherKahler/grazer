/**
 * The task-space store: `<GRAZER_HOME>/spaces.json`.
 *
 * Every `grazer nodejs` heredoc is a fresh process, so no in-memory copy of
 * this file can be trusted for longer than one operation — another heredoc, or
 * the `grazer space` CLI, may have written it in between. **Every read re-reads
 * the file.** There is deliberately no cache.
 *
 * The whole module is synchronous because the CDP send gate consults it inline,
 * before deciding whether a message may go to the browser.
 *
 * Lifetime is tied to the browser's. A space IS a `Target.createBrowserContext`,
 * and contexts die with the browser process, so a store written under a previous
 * browser describes contexts that no longer exist. `browser.json`'s `startedAt`
 * is the epoch marker: when it moves, the store is stale and resets to empty.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "../companion/atomic-json.js";

/** Ownership, exactly as the harness models it (helpers.ts:117-133). */
export type SpaceOwnership = "agent" | "agentDelegatedToUser" | "user";

/** `completed` keeps the page for the user; `ended` means the user took the task back. */
export type SpaceState = "active" | "completed" | "ended";

export interface SpaceRow {
  id: number;
  taskId: string;
  name: string;
  browserContextId: string;
  ownership: SpaceOwnership;
  state: SpaceState;
  createdBy: "agent";
  createdAt: string;
  agentState?: string;
  lastError?: string;
}

export interface SpacesStore {
  /** The `startedAt` of the browser these contexts live in. */
  browserStartedAt: string;
  /** Monotonic within one browser life; never reused while a process may hold it. */
  nextId: number;
  spaces: SpaceRow[];
}

export function spacesStorePath(home: string): string {
  return join(home, "spaces.json");
}

/** `browser.json`'s `startedAt`, or "" when no browser is recorded. */
export function browserEpoch(home: string): string {
  try {
    const raw = readFileSync(join(home, "browser.json"), "utf8");
    const parsed = JSON.parse(raw) as { startedAt?: string };
    return typeof parsed?.startedAt === "string" ? parsed.startedAt : "";
  } catch {
    return "";
  }
}

function emptyStore(browserStartedAt: string): SpacesStore {
  return { browserStartedAt, nextId: 1, spaces: [] };
}

/**
 * The epoch recorded in `spaces.json` as it sits on disk, WITHOUT the staleness
 * reset `readStore` applies.
 *
 * Callers use it to notice that the store they just read is a reset one and
 * persist it, so the file on disk stops describing a browser that is gone.
 * `readStore` cannot do that itself: the CDP send gate calls it inline on every
 * message, and writing from there would put a file write in the hot path.
 */
export function persistedEpoch(home: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(spacesStorePath(home), "utf8"),
    ) as SpacesStore;
    return typeof parsed?.browserStartedAt === "string"
      ? parsed.browserStartedAt
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the store, resetting it when the browser has restarted since it was
 * written.
 *
 * `epoch` is injectable so the unit tests can drive the stale path without
 * fabricating a `browser.json`; in production it always comes from that file.
 */
export function readStore(home: string, epoch = browserEpoch(home)): SpacesStore {
  const path = spacesStorePath(home);
  if (!existsSync(path)) return emptyStore(epoch);
  let parsed: SpacesStore;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as SpacesStore;
  } catch {
    // A corrupt store is indistinguishable from no store: the contexts it named
    // are unreachable either way.
    return emptyStore(epoch);
  }
  if (
    !parsed ||
    typeof parsed.browserStartedAt !== "string" ||
    !Array.isArray(parsed.spaces) ||
    typeof parsed.nextId !== "number"
  ) {
    return emptyStore(epoch);
  }
  if (parsed.browserStartedAt !== epoch) {
    // The browser restarted: every browserContextId in here is dead.
    return emptyStore(epoch);
  }
  return parsed;
}

export function writeStore(home: string, store: SpacesStore): void {
  mkdirSync(home, { recursive: true });
  writeJsonAtomic(spacesStorePath(home), store);
}

/**
 * Take the next id.
 *
 * Ids are never reused within a browser life, even after a space is closed: a
 * heredoc still running may hold the old id, and handing it to a different space
 * would silently redirect that process's commands.
 */
export function allocateId(store: SpacesStore): number {
  const id = store.nextId;
  store.nextId = id + 1;
  return id;
}

/** Find by numeric id, by name, or by a numeric string — the harness passes all three. */
export function findRow(
  store: SpacesStore,
  idOrName: number | string,
): SpaceRow | undefined {
  if (typeof idOrName === "number") {
    return store.spaces.find((row) => row.id === idOrName);
  }
  const byName = store.spaces.find(
    (row) => row.name === idOrName || row.taskId === idOrName,
  );
  if (byName) return byName;
  if (/^\d+$/.test(idOrName)) {
    const id = Number(idOrName);
    return Number.isFinite(id)
      ? store.spaces.find((row) => row.id === id)
      : undefined;
  }
  return undefined;
}

/** Insert or replace a row by id. */
export function upsertRow(store: SpacesStore, row: SpaceRow): void {
  const index = store.spaces.findIndex((candidate) => candidate.id === row.id);
  if (index >= 0) store.spaces[index] = row;
  else store.spaces.push(row);
}

/** Drop a row by id. Returns the row that was removed, if any. */
export function removeRow(
  store: SpacesStore,
  id: number,
): SpaceRow | undefined {
  const index = store.spaces.findIndex((row) => row.id === id);
  if (index < 0) return undefined;
  return store.spaces.splice(index, 1)[0];
}
