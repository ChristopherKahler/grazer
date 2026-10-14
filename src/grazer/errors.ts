/**
 * Grazer transport error codes — the single source of truth for the failure
 * situations the transport can produce locally.
 *
 * These are the *local* failures: the CDP message never reached Chrome, so no
 * CDP response will ever arrive to settle the harness's pending entry. The
 * harness receives them through `onSendCDPMessageError(message, error_code)`,
 * which carries no request id, and rejects every in-flight request with a
 * `buildGrazerError` (packages/harness/src/browser-runtime.ts). The codes below
 * are a subset of `GRAZER_ERROR_CODES` in packages/harness/src/grazer-errors.ts;
 * that list is the contract, this file is what the transport actually emits.
 */

/** Local failure situations the transport reports. */
export type GrazerSendSituation =
  | "channel-unavailable"
  | "send-failed"
  | "host-disconnected"
  | "invalid-argument"
  | "space-not-selected"
  | "space-not-found"
  | "space-unavailable"
  | "space-user-in-control"
  | "space-inactive";

/** Stable code + owned wording for each situation. */
const SEND_ERRORS: Record<
  GrazerSendSituation,
  { error_code: string; message: string }
> = {
  // Socket never connected, or already closed, at the moment of the send.
  "channel-unavailable": {
    error_code: "GRAZER_CDP_CHANNEL_UNAVAILABLE",
    message: "CDP channel is not available.",
  },
  // The socket was open but `ws.send` threw.
  "send-failed": {
    error_code: "GRAZER_CDP_SEND_FAILED",
    message: "Failed to send CDP message.",
  },
  // The socket dropped while requests were in flight.
  "host-disconnected": {
    error_code: "GRAZER_TASK_HOST_DISCONNECTED",
    message: "CDP agent host is not available.",
  },
  // The payload is not JSON, or carries no `method`.
  "invalid-argument": {
    error_code: "GRAZER_INVALID_ARGUMENT",
    message: "Invalid CDP message payload.",
  },

  // --- Task spaces -------------------------------------------------------
  // These five carry only a short native message. For the two hard-stop codes
  // the harness substitutes its OWN multi-line guidance and ignores this text
  // entirely (grazer-errors.ts:48-65), so writing anything longer here would be
  // dead weight the agent never sees.
  "space-not-selected": {
    error_code: "GRAZER_TASK_SPACE_NOT_SELECTED",
    message: "Task space not selected",
  },
  "space-not-found": {
    error_code: "GRAZER_TASK_SPACE_NOT_FOUND",
    message: "Task space not found",
  },
  "space-unavailable": {
    error_code: "GRAZER_TASK_SPACE_UNAVAILABLE",
    message: "Task space is not available",
  },
  "space-user-in-control": {
    error_code: "GRAZER_TASK_SPACE_USER_IN_CONTROL",
    message: "The task is under user control",
  },
  "space-inactive": {
    error_code: "GRAZER_TASK_SPACE_INACTIVE",
    message:
      "Task space is not assigned to an agent. Claim this task space before sending CDP messages.",
  },
};

/**
 * An Error carrying a stable `error_code`, matching the shape the harness reads
 * via `grazerErrorCode()`.
 */
export class GrazerError extends Error {
  readonly error_code: string;

  constructor(message: string, error_code: string) {
    super(message);
    this.name = "GrazerError";
    this.error_code = error_code;
  }
}

/** The `{ message, error_code }` pair for a situation. */
export function sendErrorFor(situation: GrazerSendSituation): {
  message: string;
  error_code: string;
} {
  return { ...SEND_ERRORS[situation] };
}

/** A `GrazerError` for a situation — used where we throw rather than report. */
export function grazerErrorFor(situation: GrazerSendSituation): GrazerError {
  const { message, error_code } = SEND_ERRORS[situation];
  return new GrazerError(message, error_code);
}
