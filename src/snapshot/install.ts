import { attachToPage } from "../cdp/session.js";
import { asSnapshotError, snapshot } from "./index.js";
import type { CdpEventLike, CollectFramesOptions } from "./frames.js";
import type { CdpSend, SnapshotResult } from "./types.js";

/**
 * Attach `snapshot(options)` to the grazer runtime from the outside.
 *
 * The runtime is the transport's file and is not edited here; the harness
 * re-exposes every own enumerable function key of the runtime object
 * (`packages/harness/src/index.ts:321-343`), so a plain assignment is all it
 * takes for `grazer.snapshot(...)` to exist.
 */

/** The slice of a CDP connection this adapter needs. */
export interface SnapshotConnection {
  isOpen(): boolean;
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<{ result?: Record<string, unknown> }>;
  onEvent(listener: (event: CdpEventLike) => void): () => void;
}

export interface AttachSnapshotDeps {
  connection: SnapshotConnection;
  /**
   * Override the page session to snapshot. Without it the adapter observes the
   * harness's own attaches, which needs no change on the host side.
   */
  currentSessionId?: () => string | undefined;
  frameOptions?: Omit<CollectFramesOptions, "onEvent">;
}

/** The `listTabs` entry fields this adapter reads. */
export interface GrazerTabLike {
  targetId: string;
  active?: boolean;
}

export interface SnapshotTarget {
  snapshot?: (options?: unknown) => Promise<SnapshotResult>;
  assertAgentControl?: () => void;
  listTabs?: () => Promise<{ tabs?: GrazerTabLike[]; error?: string }>;
  [key: string]: unknown;
}

export function attachSnapshot(
  runtime: SnapshotTarget,
  deps: AttachSnapshotDeps,
): () => void {
  const { connection } = deps;

  // The harness attaches to its own page target and puts that sessionId in
  // every page-level payload. In flat mode Chrome also emits
  // Target.attachedToTarget for those attaches, so observing events tracks the
  // harness's session without the host having to hand it over. The targetId is
  // kept alongside it because the session alone cannot be re-validated.
  let observed: { sessionId: string; targetId: string } | undefined;
  const unsubscribe = connection.onEvent((event) => {
    if (event.method !== "Target.attachedToTarget") {
      return;
    }
    const params = event.params ?? {};
    const targetInfo = params.targetInfo;
    if (
      targetInfo?.type === "page" &&
      typeof params.sessionId === "string" &&
      typeof targetInfo.targetId === "string"
    ) {
      observed = { sessionId: params.sessionId, targetId: targetInfo.targetId };
    }
  });

  /** Resolve `result` rather than the full frame — the shape the fetchers read. */
  const send: CdpSend = async (method, params, sessionId) =>
    (await connection.send(method, params ?? {}, sessionId)).result ?? {};

  /**
   * The tabs of the SELECTED task space, via the runtime's own `listTabs`.
   *
   * Not `Target.getTargets`: since 02-01 `listTabs` is scoped to the selected
   * space's browser context, and a browser-wide target list would happily hand
   * back a page belonging to a different space.
   */
  async function spaceTabs(): Promise<GrazerTabLike[]> {
    if (typeof runtime.listTabs !== "function") {
      return [];
    }
    const result = await runtime.listTabs();
    if (result?.error) {
      throw new Error(result.error);
    }
    return Array.isArray(result?.tabs) ? result.tabs : [];
  }

  /**
   * Pick the session to snapshot, re-validating a remembered one every call.
   *
   * Switching task spaces invalidates the harness's page session, and a
   * snapshot can be the very FIRST call after that switch — with no send in
   * between to refresh anything. A remembered session whose target is no
   * longer in the space's tab list is therefore discarded and re-resolved,
   * rather than quietly snapshotting the previous space's page. (Found by the
   * transport builder during 02-02: `useOrCreate` then `page.snapshot` as the
   * first action returned an empty string with no error.)
   */
  async function resolveSessionId(): Promise<string | undefined> {
    const supplied = deps.currentSessionId?.();
    if (supplied) {
      return supplied;
    }
    const tabs = await spaceTabs();
    if (observed && tabs.some((tab) => tab.targetId === observed?.targetId)) {
      return observed.sessionId;
    }
    observed = undefined;
    if (tabs.length === 0) {
      throw new Error("no page target in the selected task space");
    }
    const tab = tabs.find((candidate) => candidate.active) ?? tabs[tabs.length - 1];
    const sessionId = await attachToPage(connection as never, tab.targetId);
    observed = { sessionId, targetId: tab.targetId };
    return sessionId;
  }

  const run = async (options?: unknown): Promise<SnapshotResult> => {
    // Before anything else, and never wrapped: the harness's
    // waitForAgentControl reads this GrazerError's code to learn the user has
    // taken the wheel, so re-labelling it as a snapshot failure would hide it.
    if (typeof runtime.assertAgentControl === "function") {
      runtime.assertAgentControl();
    }
    try {
      if (!connection.isOpen()) {
        throw new Error("CDP channel is not available.");
      }
      const sessionId = await resolveSessionId();
      return await snapshot(send, sessionId, options, {
        ...deps.frameOptions,
        onEvent: (listener) => connection.onEvent(listener),
      });
    } catch (err) {
      throw asSnapshotError(err);
    }
  };

  // Assignment, not defineProperty: the harness re-exposes own ENUMERABLE
  // function keys, and a defineProperty default would be invisible to it.
  runtime.snapshot = run;

  return () => {
    unsubscribe();
    if (runtime.snapshot === run) {
      delete runtime.snapshot;
    }
  };
}
