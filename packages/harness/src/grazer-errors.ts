/**
 * Shared handling for grazer-binding errors.
 *
 * Browser-side failures expose two signals (see the GrazerBindings JS API):
 *   - human-readable text (`error` on resolved results, `message` on rejected
 *     Errors), and
 *   - a stable `error_code` such as GRAZER_TASK_SPACE_USER_IN_CONTROL.
 *
 * The code is the durable contract; the wording can drift between builds. Branch
 * on the code (isGrazerUserControlError), not on the message. GRAZER_ERROR_MESSAGES is
 * where grazer owns its wording for the few codes an agent must act on; every
 * other code (and any unknown future code) defers to the native error message.
 *
 * Single source of truth — error handling was previously duplicated across
 * helpers.ts and driver/nav.ts.
 */

import { markHardStop } from "./output-sink.js";

/** Stable error codes emitted by the native grazer bindings. */
export const GRAZER_ERROR_CODES = [
  "GRAZER_UNAVAILABLE",
  "GRAZER_CDP_CHANNEL_UNAVAILABLE",
  "GRAZER_CDP_SEND_FAILED",
  "GRAZER_INVALID_ARGUMENT",
  "GRAZER_INVALID_RESULT_PAYLOAD",
  "GRAZER_OPERATION_FAILED",
  "GRAZER_RESULT_CONVERSION_FAILED",
  "GRAZER_SNAPSHOT_FAILED",
  "GRAZER_TASK_HOST_DISCONNECTED",
  "GRAZER_TASK_SPACE_INACTIVE",
  "GRAZER_TASK_SPACE_NOT_FOUND",
  "GRAZER_TASK_SPACE_NOT_SELECTED",
  "GRAZER_TASK_SPACE_UNAVAILABLE",
  "GRAZER_TASK_SPACE_USER_IN_CONTROL",
  "GRAZER_WEB_CONTENTS_UNAVAILABLE",
] as const;

export type GrazerErrorCode = (typeof GRAZER_ERROR_CODES)[number];

/**
 * Codes whose wording grazer owns. A listed code returns this static, id-less
 * message instead of the native error message — reserved for the two business signals
 * an agent must react to, not just report. Every other code is absent here and defers
 * to the native error message (and any unknown future code does too), which is more
 * specific than any static line.
 */
const GRAZER_ERROR_MESSAGES: Partial<Record<GrazerErrorCode, string>> = {
  GRAZER_TASK_SPACE_INACTIVE: [
    "The user has taken control of this task space and ended the task, so it is no longer assigned to the agent and browser commands are paused.",
    "This is a hard stop, not an obstacle to route around — do not retry and do not take ownership back on your own.",
    "Wait until the user explicitly asks you to continue, then claim the space and resume:",
    "  await taskSpaces.claim(id)",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
  ].join("\n"),
  GRAZER_TASK_SPACE_USER_IN_CONTROL: [
    "The user has taken control of this task space, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
    "Wait until the user explicitly asks you to continue, then take control back and resume:",
    "  await taskSpaces.takeOver()",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
  ].join("\n"),
};

/** Type guard for codes this build knows about. */
export function isGrazerErrorCode(value: unknown): value is GrazerErrorCode {
  return (
    typeof value === "string" &&
    (GRAZER_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Pull the stable error_code out of any grazer error shape: resolved
 * `{ error, error_code }` objects, rejected/thrown Errors carrying `.error_code`,
 * or a bare known code string. Returns the raw code (which may be one this build
 * does not know about yet) or undefined when none is present.
 */
export function grazerErrorCode(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isGrazerErrorCode(err) ? err : undefined;
  }
  if (err && typeof err === "object") {
    const code = (err as Record<string, unknown>).error_code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

/**
 * Resolve any grazer error into a stable `{ code, message }` pair.
 *
 * For a code grazer owns wording for, `message` is that owned wording.
 * Otherwise (a code not owned here, or an unknown future code) it falls back to
 * the native error message the binding returned, then the bare code, then a
 * generic string. `code` is the stable classifier and may be undefined.
 */
export function resolveGrazerError(err: unknown): {
  code?: string;
  message: string;
} {
  const code = grazerErrorCode(err);
  const message =
    (isGrazerErrorCode(code) ? GRAZER_ERROR_MESSAGES[code] : undefined) ??
    nativeErrorText(err) ??
    code ??
    "Unknown grazer error";
  return { code, message };
}

/** Whether an grazer error means the task is currently under user control. */
export function isGrazerUserControlError(err: unknown): boolean {
  return grazerErrorCode(err) === "GRAZER_TASK_SPACE_USER_IN_CONTROL";
}

/**
 * Codes that halt the whole agent task rather than mark a routable obstacle: a task
 * space the user has taken back, or one that is inactive / not assigned to this agent.
 * Both require the user to explicitly hand control back before work can resume.
 */
function isGrazerHardStopCode(code: string | undefined): boolean {
  return (
    code === "GRAZER_TASK_SPACE_USER_IN_CONTROL" ||
    code === "GRAZER_TASK_SPACE_INACTIVE"
  );
}

/** Whether an grazer error is a hard stop the agent must not retry or route around. */
export function isGrazerHardStopError(err: unknown): boolean {
  return isGrazerHardStopCode(grazerErrorCode(err));
}

/**
 * Build an Error carrying the resolved message and stable error_code from any grazer
 * error shape. `op`, when given, prefixes the message with the failing operation.
 * Shared by assertNoGrazerError (which throws it) and the CDP-send failure path (which
 * rejects pending requests with it) so every grazer failure surfaces an identical
 * Error shape.
 */
export function buildGrazerError(
  err: unknown,
  op?: string,
): Error & { error_code?: string } {
  const { code, message } = resolveGrazerError(err);
  if (isGrazerHardStopCode(code)) {
    // buildGrazerError is the single birthplace of every grazer error — assertNoGrazerError and
    // the CDP-send failure path both route through it — so recording the hard stop here
    // catches it even when the agent's own try/catch later swallows the thrown Error.
    // The op-less owned message is the one the agent should see, regardless of which
    // operation surfaced it.
    markHardStop(message);
  }
  const error: Error & { error_code?: string } = new Error(
    op ? `${op}: ${message}` : message,
  );
  if (code) error.error_code = code;
  return error;
}

export function assertNoGrazerError(result, op?: string) {
  if (
    result &&
    typeof result === "object" &&
    "error" in result &&
    result.error != null
  ) {
    throw buildGrazerError(result, op);
  }
  return result;
}

/**
 * The native error message from any grazer error shape — the binding's runtime
 * `error`/`message` text (dynamic, may vary across builds). Ignores bare codes.
 */
function nativeErrorText(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isGrazerErrorCode(err) ? undefined : err;
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (obj.error != null) return formatGrazerError(obj.error);
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return undefined;
}

export function formatGrazerError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
