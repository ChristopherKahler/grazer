/**
 * Task-space operations against the browser.
 *
 * A space IS a browser context: `Target.createBrowserContext` gives it its own
 * cookie jar and storage, which is the whole isolation story. The store row is
 * bookkeeping on top of that — the context is the real object, and if the
 * context is gone the row is meaningless.
 *
 * Everything goes through the `CdpSend` seam so the unit tests can drive it
 * with 01-01's fake connection.
 */

import type { CdpSend, CdpTargetInfo } from "../cdp/types.js";
import {
  allocateId,
  findRow,
  removeRow,
  upsertRow,
  type SpaceOwnership,
  type SpaceRow,
  type SpacesStore,
} from "./store.js";

/** The shape the harness reads back (helpers.ts normalizeTaskSpace). */
export interface TaskSpaceView {
  taskId: string;
  id: number;
  name: string;
  createdBy: string;
  ownership: SpaceOwnership;
  state: string;
  recentTabTitles: string[];
}

/** Project a stored row into the harness's shape. */
export function toView(row: SpaceRow, recentTabTitles: string[] = []): TaskSpaceView {
  return {
    taskId: row.taskId,
    id: row.id,
    name: row.name,
    createdBy: row.createdBy,
    ownership: row.ownership,
    state: row.state,
    recentTabTitles,
  };
}

/** Page targets, grouped by the context they belong to. */
export async function pageTargetsByContext(
  connection: CdpSend,
): Promise<Map<string, CdpTargetInfo[]>> {
  const response = await connection.send("Target.getTargets");
  const infos = response.result?.targetInfos;
  const grouped = new Map<string, CdpTargetInfo[]>();
  if (!Array.isArray(infos)) return grouped;
  for (const info of infos as CdpTargetInfo[]) {
    if (info?.type !== "page") continue;
    const contextId = info.browserContextId ?? "";
    const bucket = grouped.get(contextId);
    if (bucket) bucket.push(info);
    else grouped.set(contextId, [info]);
  }
  return grouped;
}

/** The contexts the browser currently has. The default context is not listed. */
async function liveContextIds(connection: CdpSend): Promise<Set<string> | null> {
  try {
    const response = await connection.send("Target.getBrowserContexts");
    const ids = response.result?.browserContextIds;
    return Array.isArray(ids) ? new Set(ids as string[]) : null;
  } catch {
    // A failed query is NOT evidence that no contexts exist. Returning null
    // makes the caller skip pruning rather than delete every space.
    return null;
  }
}

/**
 * List spaces, reconciled against the browser.
 *
 * Rows whose context has vanished are dropped — the user closed the window, or
 * something disposed it — so the store never advertises a space that cannot be
 * used. Pruning is skipped entirely when the context query failed, because
 * "I could not ask" must never be read as "there are none".
 */
export async function listSpaces(
  connection: CdpSend,
  store: SpacesStore,
): Promise<{ views: TaskSpaceView[]; pruned: boolean }> {
  const live = await liveContextIds(connection);
  let pruned = false;
  if (live) {
    const kept = store.spaces.filter((row) => live.has(row.browserContextId));
    if (kept.length !== store.spaces.length) {
      store.spaces = kept;
      pruned = true;
    }
  }
  const grouped = await pageTargetsByContext(connection);
  const views = store.spaces.map((row) =>
    toView(
      row,
      (grouped.get(row.browserContextId) ?? []).map((target) => target.title ?? ""),
    ),
  );
  return { views, pruned };
}

/**
 * Create a space: a context plus its first tab.
 *
 * `disposeOnDetach: false` keeps the context alive when our WebSocket closes —
 * every heredoc is a new process with a new socket, so the default would throw
 * the space away between commands. `newWindow: true` means a headed user sees
 * one window per space rather than tabs piling into one frame.
 */
export async function createSpace(
  connection: CdpSend,
  store: SpacesStore,
  name: string,
): Promise<SpaceRow> {
  const context = await connection.send("Target.createBrowserContext", {
    disposeOnDetach: false,
  });
  const browserContextId = context.result?.browserContextId;
  if (typeof browserContextId !== "string" || !browserContextId) {
    throw new Error("Target.createBrowserContext returned no browserContextId");
  }
  await connection.send("Target.createTarget", {
    url: "about:blank",
    browserContextId,
    newWindow: true,
  });

  const id = allocateId(store);
  const row: SpaceRow = {
    id,
    taskId: String(id),
    name,
    browserContextId,
    ownership: "agent",
    state: "active",
    createdBy: "agent",
    createdAt: new Date().toISOString(),
  };
  upsertRow(store, row);
  return row;
}

/** Dispose a space's context and drop its row. Disposal failure is not fatal. */
export async function disposeSpace(
  connection: CdpSend,
  store: SpacesStore,
  id: number,
): Promise<boolean> {
  const row = findRow(store, id);
  if (!row) return false;
  try {
    await connection.send("Target.disposeBrowserContext", {
      browserContextId: row.browserContextId,
    });
  } catch {
    // The context may already be gone (user closed the window). Either way the
    // row must go, or the store keeps advertising an unusable space.
  }
  removeRow(store, id);
  return true;
}

/** The ownership/state transitions. Pure: the caller persists the result. */
export type SpaceOp =
  | "handOff"
  | "takeOver"
  | "complete"
  | "claim"
  | "userTakeover"
  | "end";

/**
 * Apply an operation to a row.
 *
 * `complete` deliberately leaves the page open and hands it to the user — the
 * agent finished, the human reviews the result. Closing it is `closeTaskSpace`,
 * a different verb.
 */
export function transition(row: SpaceRow, op: SpaceOp): SpaceRow {
  switch (op) {
    case "handOff":
      row.ownership = "agentDelegatedToUser";
      return row;
    case "takeOver":
      row.ownership = "agent";
      return row;
    case "complete":
      row.ownership = "agentDelegatedToUser";
      row.state = "completed";
      return row;
    case "claim":
      // Idempotent: claiming a space the agent already owns is a no-op, not an
      // error. The harness only calls it on user-owned spaces, but a CLI user
      // or a retry can reach it in any state.
      row.ownership = "agent";
      if (row.state === "ended") row.state = "active";
      return row;
    case "userTakeover":
      row.ownership = "user";
      return row;
    case "end":
      row.ownership = "user";
      row.state = "ended";
      return row;
  }
}
