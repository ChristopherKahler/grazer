/**
 * The `grazer` transport surface the harness calls.
 *
 * This is a thin adapter, deliberately. Everything the harness does routes
 * through `grazer.sendCDPMessage(jsonString)` and comes back by the runtime
 * CALLING `onCDPMessage(jsonString)` — never by return value
 * (packages/harness/src/browser-runtime.ts:45-70, 239).
 *
 * Two rules do the load-bearing work:
 *
 *   1. **sessionId is passthrough.** The harness attaches to targets itself
 *      (`ensureSession()` → `Target.attachToTarget { flatten: true }`) and puts
 *      the sessionId in the payload for page-level methods. The runtime never
 *      injects, replaces, or strips one.
 *   2. **Ids are passthrough.** The harness numbers its own requests and matches
 *      responses on `data.id`, so the frame is written with the caller's id and
 *      the response is handed back untouched.
 *
 * No task-space logic and no tab methods live here.
 */

import { CdpProtocolError } from "../cdp/connection.js";
import type { CdpEvent, CdpRequest, CdpSend } from "../cdp/types.js";
import { grazerHome } from "../companion/paths.js";
import { findRow, readStore } from "../spaces/store.js";
import type { TaskSpaceView } from "../spaces/manager.js";
import {
  GrazerError,
  grazerErrorFor,
  sendErrorFor,
  type GrazerSendSituation,
} from "./errors.js";
import * as spaces from "./spaces.js";
import type { SpaceEnv, SpaceResult, SpaceSelection } from "./spaces.js";
import {
  createTab,
  getBrowserVersion,
  listTabs,
  type ActiveTargetRef,
  type BrowserVersionResult,
  type CreateTabResult,
  type ListTabsResult,
} from "./tabs.js";

/**
 * Methods the harness sends to reach a target at all. Gating these would stop
 * `ensureSession()` — `listTabs` then `Target.attachToTarget` — before it could
 * even discover which space is under user control, so the gate would report
 * nothing and the agent would see a timeout instead of the guidance.
 */
function isBrowserLevel(method: string): boolean {
  return method.startsWith("Target.") || method.startsWith("Browser.");
}

/**
 * Browser-level methods that act on ONE browser context and take an optional
 * `browserContextId`, defaulting to the DEFAULT context when it is omitted.
 *
 * A task space is its own browser context, and the harness has no notion of
 * spaces — it omits `browserContextId` every time. Left alone, each of these
 * calls silently configures the default context while the agent's page lives in
 * the space's context. That is what cancelled every download inside a space:
 * `Page.downloadWillBegin` arrived with the right filename, then a `canceled`
 * progress, because "allow downloads to this directory" had been applied
 * somewhere else entirely.
 *
 * So this is a narrow, deliberate exception to the runtime's passthrough rule:
 * when a space is selected and the caller omitted `browserContextId`, it is
 * filled in with the space's. `sessionId` is never touched, and a caller that
 * names a context is always left alone — naming one means meaning it.
 */
const CONTEXT_SCOPED_METHODS: ReadonlySet<string> = new Set([
  // Downloads: the case that surfaced this.
  "Browser.setDownloadBehavior",
  "Browser.cancelDownload",
  // Permissions: granting in the default context leaves the space unchanged.
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
  // Cookies: login replay reads and writes these against a space.
  "Storage.getCookies",
  "Storage.setCookies",
  "Storage.clearCookies",
]);

/** True when this frame should inherit the selected space's browser context. */
export function needsContextScope(
  method: string,
  params: Record<string, unknown> | undefined,
): boolean {
  return (
    CONTEXT_SCOPED_METHODS.has(method) &&
    params?.browserContextId === undefined
  );
}

/** The default callbacks. Identity against these is how "not assigned yet" is detected. */
const NO_MESSAGE_CALLBACK = (_message: string): void => {};
const NO_ERROR_CALLBACK = (_message: string, _error_code: string): void => {};

export interface GrazerRuntimeStats {
  /** Events dropped because no `onCDPMessage` callback was assigned yet. */
  droppedEvents: number;
  /** Responses dropped because no `onCDPMessage` callback was assigned. */
  droppedResponses: number;
  /** Requests still awaiting a response. */
  inFlight: number;
}

export interface GrazerRuntime {
  /**
   * Write a harness-formed CDP payload. Returns undefined; the response is
   * delivered asynchronously through `onCDPMessage`.
   *
   * Throws synchronously (GRAZER_INVALID_ARGUMENT) when the payload is not JSON
   * or carries no `method` — the harness catches that and rejects just this
   * request. Local send failures instead call `onSendCDPMessageError`, which the
   * harness treats as task-level and applies to every in-flight request.
   */
  sendCDPMessage(payload: string): void;
  /** Assigned by the harness before every send. */
  onCDPMessage: (message: string) => void;
  /** Assigned by the harness before every send. */
  onSendCDPMessageError: (message: string, error_code: string) => void;
  /** `{ tabs: [{ targetId, title, url, active, index }] }` — driver/nav.ts:112-131. */
  listTabs(): Promise<ListTabsResult>;
  /** `{ targetId }` — driver/nav.ts:169-173. */
  createTab(url?: string): Promise<CreateTabResult>;
  /** `{ currentVersion, updateAvailable }` — update-notice.ts:27-33. */
  getBrowserVersion(): Promise<BrowserVersionResult>;

  // --- Task spaces (helpers.ts:100-420) ---------------------------------
  listTaskSpaces(): Promise<SpaceResult<{ taskSpaces: TaskSpaceView[] }>>;
  createTaskSpace(name: string): Promise<SpaceResult<TaskSpaceView>>;
  claimTaskSpace(id: number, name?: string): Promise<SpaceResult<TaskSpaceView>>;
  useTaskSpace(id: number): Promise<SpaceResult<Record<string, never>>>;
  handOffTaskSpace(): Promise<SpaceResult<Record<string, never>>>;
  takeOverTaskSpace(): Promise<SpaceResult<Record<string, never>>>;
  completeTaskSpace(): Promise<SpaceResult<Record<string, never>>>;
  closeTaskSpace(): Promise<SpaceResult<Record<string, never>>>;
  markTaskSpaceError(message: string): Promise<SpaceResult<Record<string, never>>>;
  setAgentTaskState(state: string): Promise<SpaceResult<Record<string, never>>>;
  deleteSpaces(options?: {
    scope?: "all" | "task";
    ids?: number[];
  }): Promise<SpaceResult<{ deleted: number[] }>>;
  listProfiles(): Promise<{ profiles: [] }>;
  animationHighlightMouseToPosition(): Promise<Record<string, never>>;

  /**
   * Throw a `GrazerError` when the selected space is not under agent control.
   *
   * The snapshot adapter (03-02) calls this before snapshotting, which is how
   * the harness's `waitForAgentControl` learns control came back — it probes
   * `grazer.snapshot` and reads the USER_IN_CONTROL code off the rejection.
   */
  assertAgentControl(): void;
  /** The space selected for this process, or null. */
  selectedSpaceId(): number | null;

  /** Stop forwarding frames (does not close the underlying connection). */
  dispose(): void;
  stats(): GrazerRuntimeStats;
}

export interface GrazerRuntimeOptions {
  /** Where `spaces.json` and `browser.json` live. Defaults to `grazerHome()`. */
  spacesHome?: string;
}

/** Parse and validate a harness payload into a well-formed CDP request. */
function parsePayload(payload: string): CdpRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw grazerErrorFor("invalid-argument");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { method?: unknown }).method !== "string" ||
    !(parsed as { method: string }).method
  ) {
    throw grazerErrorFor("invalid-argument");
  }
  return parsed as CdpRequest;
}

export function createGrazerRuntime(
  connection: CdpSend,
  options: GrazerRuntimeOptions = {},
): GrazerRuntime {
  let droppedEvents = 0;
  let droppedResponses = 0;
  let disposed = false;
  const inFlight = new Set<number>();

  /**
   * The space selected for THIS process only. The harness's own docs say "for
   * the current Node invocation", and every heredoc is a new process, so this
   * deliberately never reaches the store.
   */
  const selection: SpaceSelection = { id: null };
  const home = options.spacesHome ?? grazerHome();
  const env: SpaceEnv = { connection, home, selection };

  /**
   * The gate. Returns the situation blocking the selected space, or null.
   *
   * The store is re-read on every call: another heredoc, or the human running
   * `grazer space takeover`, may have changed ownership since the last send,
   * and a cached answer would let commands through after the user took the
   * wheel — the exact failure this whole mechanism exists to prevent.
   */
  function blockedBy(): GrazerSendSituation | null {
    if (selection.id === null) return null;
    const row = findRow(readStore(home), selection.id);
    if (!row) return "space-not-found";
    if (row.state === "ended") return "space-inactive";
    // Note the asymmetry with useTaskSpace: selecting tolerates
    // `agentDelegatedToUser`, sending does not. Handing off means the human has
    // the wheel even though the space is still the agent's.
    if (row.ownership !== "agent") return "space-user-in-control";
    return null;
  }

  /** The selected space's context, for scoping tabs. */
  function selectedContextId(): string | undefined {
    if (selection.id === null) return undefined;
    return findRow(readStore(home), selection.id)?.browserContextId;
  }
  /**
   * Which tab `listTabs` should mark active.
   *
   * The harness never tells us directly — it activates a tab by sending
   * `Target.activateTarget` through `sendCDPMessage` (driver/nav.ts switchTab),
   * so the passthrough is the only place that intent is visible. Watching it
   * here is what keeps `active: true` on the tab the agent actually switched to.
   */
  const activeTarget: ActiveTargetRef = { value: null };

  const runtime: GrazerRuntime = {
    // A frame can arrive in the window before the harness's first assignment.
    onCDPMessage: NO_MESSAGE_CALLBACK,
    onSendCDPMessageError: NO_ERROR_CALLBACK,

    sendCDPMessage(payload: string): void {
      const message = parsePayload(payload);

      // Read-only observation of a passthrough frame: the harness switching tabs
      // is the only signal we get for which tab is active.
      if (message.method === "Target.activateTarget") {
        const targetId = message.params?.targetId;
        if (typeof targetId === "string" && targetId) {
          activeTarget.value = targetId;
        }
      }

      // The one place the runtime edits a frame: see CONTEXT_SCOPED_METHODS.
      // These methods default to the DEFAULT browser context, and the agent's
      // page lives in the selected space's context.
      if (needsContextScope(message.method, message.params)) {
        const contextId = selectedContextId();
        if (contextId) {
          message.params = { ...message.params, browserContextId: contextId };
        }
      }

      // Browser-level methods are exempt: the harness needs Target.getTargets
      // and Target.attachToTarget to reach a session at all, and blocking them
      // would replace the guidance with a 15s timeout.
      if (!isBrowserLevel(message.method)) {
        const blocked = blockedBy();
        if (blocked) {
          const { message: text, error_code } = sendErrorFor(blocked);
          runtime.onSendCDPMessageError(text, error_code);
          return;
        }
      }

      if (!connection.isOpen()) {
        const { message: text, error_code } =
          sendErrorFor("channel-unavailable");
        runtime.onSendCDPMessageError(text, error_code);
        return;
      }

      inFlight.add(message.id);
      connection
        .sendRaw(message)
        .then((response) => {
          inFlight.delete(message.id);
          deliver(response);
        })
        .catch((error: unknown) => {
          inFlight.delete(message.id);
          // A protocol error is a RESPONSE, not a transport failure: hand the
          // frame back untouched so the harness rejects the matching request
          // rather than waiting out its own 15s timeout.
          if (error instanceof CdpProtocolError) {
            deliver(error.response);
            return;
          }
          const code =
            error instanceof GrazerError ? error.error_code : undefined;
          if (
            code === "GRAZER_CDP_CHANNEL_UNAVAILABLE" ||
            code === "GRAZER_CDP_SEND_FAILED"
          ) {
            runtime.onSendCDPMessageError((error as Error).message, code);
            return;
          }
          // GRAZER_TASK_HOST_DISCONNECTED is reported once by the close handler,
          // and the connection's own timeout is a leak guard the harness's
          // shorter timeout has already beaten. Reporting either here would
          // fail every other in-flight request a second time.
        });
    },

    listTabs() {
      return listTabs(connection, activeTarget, selectedContextId());
    },

    createTab(url?: string) {
      // createTab is a page-level act even though its CDP method is Target.*:
      // it is how the agent gets somewhere to run commands, so a user-controlled
      // space must refuse it.
      const blocked = blockedBy();
      if (blocked) {
        const { message, error_code } = sendErrorFor(blocked);
        return Promise.resolve({ error: message, error_code });
      }
      return createTab(connection, activeTarget, url, selectedContextId());
    },

    getBrowserVersion() {
      return getBrowserVersion(connection);
    },

    listTaskSpaces: () => spaces.listTaskSpaces(env),
    createTaskSpace: (name: string) => spaces.createTaskSpace(env, name),
    claimTaskSpace: (id: number, name?: string) =>
      spaces.claimTaskSpace(env, id, name),
    useTaskSpace: (id: number) => spaces.useTaskSpace(env, id),
    handOffTaskSpace: () => spaces.handOffTaskSpace(env),
    takeOverTaskSpace: () => spaces.takeOverTaskSpace(env),
    completeTaskSpace: () => spaces.completeTaskSpace(env),
    closeTaskSpace: () => spaces.closeTaskSpace(env),
    markTaskSpaceError: (message: string) =>
      spaces.markTaskSpaceError(env, message),
    setAgentTaskState: (state: string) => spaces.setAgentTaskState(env, state),
    deleteSpaces: (opts?: { scope?: "all" | "task"; ids?: number[] }) =>
      spaces.deleteSpaces(env, opts),
    listProfiles: () => spaces.listProfiles(),
    animationHighlightMouseToPosition: () =>
      spaces.animationHighlightMouseToPosition(),

    assertAgentControl() {
      const blocked = blockedBy();
      if (blocked) throw grazerErrorFor(blocked);
    },

    selectedSpaceId() {
      return selection.id;
    },

    dispose() {
      disposed = true;
      unsubscribeEvents();
      unsubscribeClose();
    },

    stats() {
      return { droppedEvents, droppedResponses, inFlight: inFlight.size };
    },
  };

  /**
   * Hand a frame to the harness. Only ever reached from a promise callback or a
   * socket event, so it is never synchronous inside `sendCDPMessage` — the
   * harness has always registered its pending entry by then.
   */
  function deliver(frame: object): void {
    if (disposed) return;
    if (runtime.onCDPMessage === NO_MESSAGE_CALLBACK) {
      droppedResponses++;
      return;
    }
    runtime.onCDPMessage(JSON.stringify(frame));
  }

  const unsubscribeEvents = connection.onEvent((event: CdpEvent) => {
    if (disposed) return;
    // A closed tab must not stay "active", or listTabs would report an active
    // flag on nothing and the harness would attach to a dead target.
    if (
      event.method === "Target.targetDestroyed" &&
      event.params?.targetId === activeTarget.value
    ) {
      activeTarget.value = null;
    }
    if (runtime.onCDPMessage === NO_MESSAGE_CALLBACK) {
      // Nothing is listening yet; count it so a silent drop stays visible.
      droppedEvents++;
      return;
    }
    // Verbatim: flat-session frames already carry sessionId at the top level,
    // which is exactly where the harness reads it.
    runtime.onCDPMessage(JSON.stringify(event));
  });

  const unsubscribeClose = connection.onClose(() => {
    if (disposed) return;
    if (inFlight.size === 0) return;
    const { message, error_code } = sendErrorFor("host-disconnected");
    // Once, not per request: the harness rejects all of its own pending entries
    // from a single callback (browser-runtime.ts handleSendError).
    runtime.onSendCDPMessageError(message, error_code);
  });

  return runtime;
}
