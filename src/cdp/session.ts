/**
 * Page target discovery and attach.
 *
 * These are helpers for tests and later plans. The grazer runtime itself never
 * calls them: the harness does its own attaching (`ensureSession()` →
 * `Target.attachToTarget { flatten: true }`) and puts the resulting sessionId in
 * the payload, so anything here reaching into the transport would be the
 * session injection the contract forbids.
 */

import type { CdpConnection } from "./connection.js";
import type { CdpTargetInfo } from "./types.js";

/**
 * The page targets a browser currently has.
 *
 * A fresh profile reports component-extension `service_worker`,
 * `background_page` and `browser_ui` targets alongside the real page, so the
 * type filter is not optional.
 */
export async function findPageTargets(
  connection: CdpConnection,
): Promise<CdpTargetInfo[]> {
  const response = await connection.send("Target.getTargets");
  const infos = response.result?.targetInfos;
  if (!Array.isArray(infos)) return [];
  return (infos as CdpTargetInfo[]).filter((info) => info?.type === "page");
}

/**
 * Attach to a page target in flat-session mode and return its sessionId.
 *
 * `flatten: true` is what makes Chrome put `sessionId` at the top level of
 * every page-scoped frame instead of wrapping it in
 * `Target.receivedMessageFromTarget` — which is where the harness reads it.
 */
export async function attachToPage(
  connection: CdpConnection,
  targetId: string,
): Promise<string> {
  const response = await connection.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const sessionId = response.result?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error(`Target.attachToTarget returned no sessionId for ${targetId}`);
  }
  return sessionId;
}
