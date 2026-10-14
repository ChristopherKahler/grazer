/**
 * The `grazer.*TaskSpace*` methods the harness calls.
 *
 * Every one of these is awaited by a harness helper and passed through
 * `assertNoGrazerError`, so **failures RESOLVE with `{ error, error_code }`**.
 * A rejection would escape that check as a bare Error with no stable code, and
 * the agent would lose the hard-stop guidance the harness owns for
 * USER_IN_CONTROL and INACTIVE.
 *
 * Two different rules live here, and conflating them is the easiest way to get
 * this wrong:
 *
 *   - **Selecting** a space (`useTaskSpace`) fails on an ended space (INACTIVE)
 *     or a user-owned one (USER_IN_CONTROL), but NOT on `agentDelegatedToUser`
 *     — that is still agent-owned (helpers.ts `isAgentOwned`), so
 *     `switchTaskSpace` on a handed-off space must succeed.
 *   - **Sending** a CDP page command fails when ownership is anything other
 *     than `"agent"` — that check lives in runtime.ts and is what actually
 *     surfaces USER_IN_CONTROL to an agent working in a handed-off space.
 *
 * Selection is per process ("for the current Node invocation"): it lives in the
 * runtime object, not in the store.
 */

import type { CdpSend } from "../cdp/types.js";
import {
  createSpace,
  disposeSpace,
  listSpaces,
  toView,
  transition,
  type SpaceOp,
  type TaskSpaceView,
} from "../spaces/manager.js";
import {
  findRow,
  persistedEpoch,
  readStore,
  writeStore,
} from "../spaces/store.js";
import { sendErrorFor, type GrazerSendSituation } from "./errors.js";

/** A resolved grazer error — the shape `assertNoGrazerError` reads. */
export interface GrazerErrorResult {
  error: string;
  error_code: string;
}

export type SpaceResult<T> = T | GrazerErrorResult;

/** Where a runtime keeps its per-process space selection. */
export interface SpaceSelection {
  id: number | null;
}

export interface SpaceEnv {
  connection: CdpSend;
  home: string;
  selection: SpaceSelection;
}

function errorFor(situation: GrazerSendSituation): GrazerErrorResult {
  const { message, error_code } = sendErrorFor(situation);
  return { error: message, error_code };
}

function failed(error: unknown): GrazerErrorResult {
  return {
    error: error instanceof Error ? error.message : String(error ?? "unknown"),
    error_code: "GRAZER_OPERATION_FAILED",
  };
}

/** Every method re-reads the store; nothing here is cached across calls. */
export async function listTaskSpaces(
  env: SpaceEnv,
): Promise<SpaceResult<{ taskSpaces: TaskSpaceView[] }>> {
  try {
    const store = readStore(env.home);
    // A store read after a browser restart is a reset one; persist it so the
    // file stops describing contexts that died with the previous browser.
    const stale = persistedEpoch(env.home) !== store.browserStartedAt;
    const { views, pruned } = await listSpaces(env.connection, store);
    if (pruned || stale) writeStore(env.home, store);
    return { taskSpaces: views };
  } catch (error) {
    return failed(error);
  }
}

export async function createTaskSpace(
  env: SpaceEnv,
  name: string,
): Promise<SpaceResult<TaskSpaceView>> {
  try {
    const store = readStore(env.home);
    // Mirrors the behaviour the harness's own double encodes
    // (taskspace-e2e.test.mjs): a duplicate name is an error, not a second space.
    if (findRow(store, name)) {
      return {
        error: `Task space already exists: ${name}`,
        error_code: "GRAZER_TASK_SPACE_UNAVAILABLE",
      };
    }
    const created = await createSpace(env.connection, store, name);
    writeStore(env.home, store);
    env.selection.id = created.id;
    return toView(created);
  } catch (error) {
    return failed(error);
  }
}

/**
 * Select a space for this process.
 *
 * Two refusals, in this order — the same order the send gate uses, because an
 * ended task and a paused one need different guidance and different recovery:
 *
 *   - `state === "ended"` -> INACTIVE. The user ended the task, so it is no
 *     longer assigned to the agent; the harness's guidance for this code tells
 *     the agent to call `taskSpaces.claim(id)`, which is the only way back.
 *   - `ownership === "user"` -> USER_IN_CONTROL. The task is still the agent's,
 *     the human just has the wheel.
 *
 * `agentDelegatedToUser` selects fine: it is still agent-owned (helpers.ts
 * `isAgentOwned`), and it is the send gate, not selection, that stops commands.
 *
 * The harness's `switchTaskSpace` refuses non-agent-owned spaces before calling
 * us at all, so an ended space is reached through `useOrCreate` or `claim`.
 */
export async function useTaskSpace(
  env: SpaceEnv,
  id: number,
): Promise<SpaceResult<Record<string, never>>> {
  const store = readStore(env.home);
  const row = findRow(store, id);
  if (!row) return errorFor("space-not-found");
  if (row.state === "ended") return errorFor("space-inactive");
  if (row.ownership === "user") return errorFor("space-user-in-control");
  env.selection.id = row.id;
  return {};
}

export async function claimTaskSpace(
  env: SpaceEnv,
  id: number,
  name?: string,
): Promise<SpaceResult<TaskSpaceView>> {
  const store = readStore(env.home);
  const row = findRow(store, id);
  if (!row) return errorFor("space-not-found");
  if (name !== undefined && name !== "") {
    row.name = name;
  }
  transition(row, "claim");
  writeStore(env.home, store);
  env.selection.id = row.id;
  return toView(row);
}

/** Apply an ownership op to the selected space. */
async function applyToSelected(
  env: SpaceEnv,
  op: SpaceOp,
): Promise<SpaceResult<Record<string, never>>> {
  if (env.selection.id === null) return errorFor("space-not-selected");
  const store = readStore(env.home);
  const row = findRow(store, env.selection.id);
  if (!row) return errorFor("space-not-found");
  transition(row, op);
  writeStore(env.home, store);
  return {};
}

export function handOffTaskSpace(env: SpaceEnv) {
  return applyToSelected(env, "handOff");
}

export function takeOverTaskSpace(env: SpaceEnv) {
  return applyToSelected(env, "takeOver");
}

/** Finish the task but leave the page open — the human reviews the result. */
export function completeTaskSpace(env: SpaceEnv) {
  return applyToSelected(env, "complete");
}

/** Close the space entirely: dispose the context and drop the row. */
export async function closeTaskSpace(
  env: SpaceEnv,
): Promise<SpaceResult<Record<string, never>>> {
  if (env.selection.id === null) return errorFor("space-not-selected");
  const store = readStore(env.home);
  const id = env.selection.id;
  if (!findRow(store, id)) return errorFor("space-not-found");
  try {
    await disposeSpace(env.connection, store, id);
    writeStore(env.home, store);
    env.selection.id = null;
    return {};
  } catch (error) {
    return failed(error);
  }
}

/** Record the agent's last error on the space, for the human-facing surfaces. */
export async function markTaskSpaceError(
  env: SpaceEnv,
  message: string,
): Promise<SpaceResult<Record<string, never>>> {
  if (env.selection.id === null) return errorFor("space-not-selected");
  const store = readStore(env.home);
  const row = findRow(store, env.selection.id);
  if (!row) return errorFor("space-not-found");
  row.lastError = String(message ?? "");
  writeStore(env.home, store);
  return {};
}

/** Record what the agent says it is doing, for the same surfaces. */
export async function setAgentTaskState(
  env: SpaceEnv,
  state: string,
): Promise<SpaceResult<Record<string, never>>> {
  if (env.selection.id === null) return errorFor("space-not-selected");
  const store = readStore(env.home);
  const row = findRow(store, env.selection.id);
  if (!row) return errorFor("space-not-found");
  row.agentState = String(state ?? "");
  writeStore(env.home, store);
  return {};
}

/**
 * Delete spaces wholesale.
 *
 * `scope: "task"` means the selected space only; `scope: "all"` and an explicit
 * `ids` list are the CLI's bulk paths.
 */
export async function deleteSpaces(
  env: SpaceEnv,
  options: { scope?: "all" | "task"; ids?: number[] } = {},
): Promise<SpaceResult<{ deleted: number[] }>> {
  try {
    const store = readStore(env.home);
    let targets: number[];
    if (Array.isArray(options.ids)) {
      targets = options.ids;
    } else if (options.scope === "task") {
      if (env.selection.id === null) return errorFor("space-not-selected");
      targets = [env.selection.id];
    } else {
      targets = store.spaces.map((row) => row.id);
    }
    const deleted: number[] = [];
    for (const id of targets) {
      if (await disposeSpace(env.connection, store, id)) deleted.push(id);
      if (env.selection.id === id) env.selection.id = null;
    }
    writeStore(env.home, store);
    return { deleted };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Grazer has no profile concept: logins arrive through Grazer Sync, not by
 * pointing the browser at a set of OS profiles. The method exists because the
 * harness may call it; an empty list is the honest answer, not a stub.
 */
export async function listProfiles(): Promise<{ profiles: [] }> {
  return { profiles: [] };
}

/** A no-op on this transport: there is no overlay to draw a cursor on yet. */
export async function animationHighlightMouseToPosition(): Promise<
  Record<string, never>
> {
  return {};
}
