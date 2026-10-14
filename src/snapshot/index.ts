import { fetchViewport } from "./dom-snapshot.js";
import { collectFrameGraph, type CollectFramesOptions } from "./frames.js";
import { parseSnapshotOptions } from "./options.js";
import { renderFrames } from "./render.js";
import type { CdpSend, SnapshotResult } from "./types.js";

export { parseSnapshotOptions, SNAPSHOT_DEFAULTS } from "./options.js";
export { fetchAxTree, buildAxTree } from "./ax-tree.js";
export {
  fetchDomIndex,
  fetchViewport,
  buildDomIndex,
  buildFrameDomIndexes,
  fetchFrameDomIndexes,
} from "./dom-snapshot.js";
export { renderSnapshot, renderFrames, INTERACTIVE_ROLES, CROSS_SITE_NOTE } from "./render.js";
export {
  collectFrameGraph,
  attachCrossProcessFrames,
  describeIframeFrames,
  findIframeNodes,
  isIframeRole,
  type CollectFramesOptions,
  type CdpEventSource,
} from "./frames.js";
export {
  attachSnapshot,
  type AttachSnapshotDeps,
  type SnapshotConnection,
  type SnapshotTarget,
} from "./install.js";
export * from "./types.js";

/**
 * Accessibility snapshot of a page and every frame inside it.
 *
 * A page with no iframes still costs exactly two CDP round trips (three under
 * viewport scope): frame discovery reuses the trees already fetched, and every
 * extra call is gated behind finding an `<iframe>` node.
 *
 * Rejects on failure — `grazer.snapshot` never resolves with an `{ error }`
 * shape, so a caller that gets a value can trust it.
 */
export async function snapshot(
  send: CdpSend,
  sessionId?: string,
  options?: unknown,
  frameOptions?: CollectFramesOptions,
): Promise<SnapshotResult> {
  const resolved = parseSnapshotOptions(options);
  try {
    const graph = await collectFrameGraph(send, sessionId, frameOptions ?? {});
    const viewport =
      resolved.scope === "only_within_viewport"
        ? await fetchViewport(send, sessionId)
        : undefined;
    return renderFrames(graph, viewport, resolved);
  } catch (err) {
    throw asSnapshotError(err);
  }
}

/** Wrap a failure once, so a nested call's prefix is never doubled. */
export function asSnapshotError(err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return reason.startsWith("snapshot failed:")
    ? (err as Error)
    : new Error(`snapshot failed: ${reason}`);
}
