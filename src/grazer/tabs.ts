/**
 * The three non-CDP `grazer` methods the harness calls outside task spaces.
 *
 * Unlike `sendCDPMessage`, these return values — the harness `await`s them and
 * runs the result through `assertNoGrazerError`, which throws when the object
 * carries a non-null `error`. So a failure here RESOLVES with
 * `{ error, error_code }` rather than rejecting: that is the shape the harness
 * knows how to classify (packages/harness/src/grazer-errors.ts).
 *
 * Shapes are fixed by the harness's readers and must match exactly:
 *   listTabs()          -> { tabs: [{ targetId, title, url, active, index }] }   (driver/nav.ts:112-131)
 *   createTab(url)      -> { targetId }                                          (driver/nav.ts:169-173)
 *   getBrowserVersion() -> { currentVersion, updateAvailable, ... }              (update-notice.ts:27-33)
 */

import type { CdpSend, CdpTargetInfo } from "../cdp/types.js";
import { sendErrorFor } from "./errors.js";

/** One entry of the `listTabs` result. */
export interface GrazerTab {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
  index: number;
}

export interface ListTabsResult {
  tabs?: GrazerTab[];
  error?: string;
  error_code?: string;
}

export interface CreateTabResult {
  targetId?: string;
  error?: string;
  error_code?: string;
}

export interface BrowserVersionResult {
  currentVersion?: string;
  updateAvailable?: boolean;
  latestVersion?: string;
  mandatory?: boolean;
  error?: string;
  error_code?: string;
}

/** The mutable active-tab pointer shared between the runtime and these methods. */
export interface ActiveTargetRef {
  value: string | null;
}

/** A resolved (not rejected) grazer error, which is what assertNoGrazerError reads. */
function resolvedError(
  situation: Parameters<typeof sendErrorFor>[0],
  detail?: string,
): { error: string; error_code: string } {
  const { message, error_code } = sendErrorFor(situation);
  return { error: detail ? `${message} ${detail}` : message, error_code };
}

/**
 * Classify a thrown transport failure into the resolved-error shape.
 *
 * A dead socket is the common case and gets the channel-unavailable code the
 * harness already understands; anything else keeps its own message under
 * GRAZER_OPERATION_FAILED, which the harness passes through verbatim.
 */
function failureResult(
  connection: CdpSend,
  error: unknown,
): { error: string; error_code: string } {
  if (!connection.isOpen()) return resolvedError("channel-unavailable");
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return { error: message, error_code: "GRAZER_OPERATION_FAILED" };
}

/**
 * List the browser's page targets.
 *
 * Only `type === "page"` survives: a fresh profile also reports
 * `service_worker`, `background_page` and `browser_ui` targets. Internal URLs
 * (chrome://, devtools://) are NOT filtered here — `nav.listTabs` does that
 * itself via `includeChrome`, and doing it twice would hide tabs the caller
 * explicitly asked for.
 */
export async function listTabs(
  connection: CdpSend,
  activeTarget: ActiveTargetRef,
  browserContextId?: string,
): Promise<ListTabsResult> {
  try {
    const response = await connection.send("Target.getTargets");
    const infos = response.result?.targetInfos;
    const pages = (Array.isArray(infos) ? (infos as CdpTargetInfo[]) : []).filter(
      (info) =>
        info?.type === "page" &&
        // With a task space selected, the space's context is the whole world:
        // the harness attaches to whatever this returns, so scoping here is
        // what makes a space real to it.
        (browserContextId === undefined ||
          info.browserContextId === browserContextId),
    );

    // Exactly one tab carries active: true. The harness falls back to the LAST
    // tab when none does (browser-runtime.ts:121-122), so the fallback here
    // deliberately agrees with it rather than picking the first.
    const activeId =
      activeTarget.value &&
      pages.some((page) => page.targetId === activeTarget.value)
        ? activeTarget.value
        : (pages.at(-1)?.targetId ?? null);

    const tabs: GrazerTab[] = pages.map((page, index) => ({
      targetId: page.targetId,
      title: page.title ?? "",
      url: page.url ?? "",
      active: page.targetId === activeId,
      index,
    }));
    return { tabs };
  } catch (error) {
    return failureResult(connection, error);
  }
}

/** Open a new tab and make it the active one. */
export async function createTab(
  connection: CdpSend,
  activeTarget: ActiveTargetRef,
  url = "about:blank",
  browserContextId?: string,
): Promise<CreateTabResult> {
  try {
    const response = await connection.send("Target.createTarget", {
      url,
      // A tab opened while a space is selected belongs to that space, or the
      // isolation it promises is a lie the very first time an agent opens a tab.
      ...(browserContextId ? { browserContextId } : {}),
    });
    const targetId = response.result?.targetId;
    if (typeof targetId !== "string" || !targetId) {
      return {
        error: "Target.createTarget returned no targetId.",
        error_code: "GRAZER_INVALID_RESULT_PAYLOAD",
      };
    }
    activeTarget.value = targetId;
    return { targetId };
  } catch (error) {
    return failureResult(connection, error);
  }
}

/**
 * The running browser's version.
 *
 * `updateAvailable: false` always — Grazer drives a browser the user installed
 * and updates through their own channel, so there is no newer build for Grazer
 * to point at. The field exists because the harness's update notice reads it.
 */
export async function getBrowserVersion(
  connection: CdpSend,
): Promise<BrowserVersionResult> {
  try {
    const response = await connection.send("Browser.getVersion");
    const product = response.result?.product;
    return {
      currentVersion: typeof product === "string" ? product : "",
      updateAvailable: false,
    };
  } catch (error) {
    return failureResult(connection, error);
  }
}
