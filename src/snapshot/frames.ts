import { fetchAxTree } from "./ax-tree.js";
import { fetchFrameDomIndexes } from "./dom-snapshot.js";
import type { AxNode, CdpSend, DomIndex, FrameBundle, FrameGraph } from "./types.js";

/**
 * Frame discovery and per-frame fetch.
 *
 * Three measured facts about Chrome shape everything here:
 *
 * 1. `DOMSnapshot.captureSnapshot` returns one entry in `documents[]` for the
 *    main frame AND every same-process iframe, each tagged with its frame id.
 *    An out-of-process frame is simply absent. That single response therefore
 *    classifies every child frame, so no `Page.getFrameTree` call is needed on
 *    the common path.
 * 2. An out-of-process frame does NOT appear in the parent's
 *    `Page.getFrameTree` at all, so the frame tree could not have been used to
 *    find one anyway. `Target.setAutoAttach` is the only route, and it attaches
 *    retroactively — calling it after load still yields an
 *    `Target.attachedToTarget` for an OOPIF that already exists.
 * 3. The `<iframe>` element is an AX node in the PARENT tree with no children
 *    of its own. `DOM.describeNode` on it returns `node.frameId`, which is the
 *    only join between the element and the child document.
 */

/** Blink names the role `Iframe`; treat any casing as the same thing. */
const IFRAME_ROLES: ReadonlySet<string> = new Set(["iframe", "iframepresentational"]);

export function isIframeRole(role: string): boolean {
  return IFRAME_ROLES.has(role.toLowerCase());
}

export interface CdpEventLike {
  method: string;
  params?: Record<string, any>;
  sessionId?: string;
}

/** Subscribe to CDP events; returns an unsubscribe function. */
export type CdpEventSource = (listener: (event: CdpEventLike) => void) => () => void;

export interface CollectFramesOptions {
  onEvent?: CdpEventSource;
  /** Stop collecting attach events after this long with no new one. */
  attachQuietMs?: number;
  /** Hard ceiling on the whole attach phase. */
  attachMaxMs?: number;
}

const DEFAULT_QUIET_MS = 500;
const DEFAULT_MAX_MS = 2_500;

/** Every `<iframe>` element node in one frame's tree, in document order. */
export function findIframeNodes(tree: AxNode | undefined): AxNode[] {
  const found: AxNode[] = [];
  const visit = (node: AxNode): void => {
    if (isIframeRole(node.role) && node.backendNodeId !== undefined) {
      found.push(node);
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  if (tree) {
    visit(tree);
  }
  return found;
}

/** Join `<iframe>` elements to the frame ids of the documents they host. */
export async function describeIframeFrames(
  send: CdpSend,
  sessionId: string | undefined,
  backendNodeIds: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const backendNodeId of backendNodeIds) {
    try {
      const described = await send("DOM.describeNode", { backendNodeId }, sessionId);
      const frameId = described?.node?.frameId;
      if (typeof frameId === "string" && frameId) {
        out.set(backendNodeId, frameId);
      }
    } catch {
      // A frame torn down between the AX fetch and this call is a normal race,
      // not a snapshot failure: the iframe line simply renders without content.
    }
  }
  return out;
}

export interface AttachedFrame {
  frameId: string;
  sessionId: string;
  url: string;
}

/**
 * Attach to every out-of-process frame under a page session.
 *
 * Bounded twice over — `attachQuietMs` after the last event and `attachMaxMs`
 * overall — because a page can always host one more frame and a snapshot must
 * not wait for a page to stop changing. Auto-attach is repeated on each newly
 * attached session so nested OOPIFs are reached too.
 */
export async function attachCrossProcessFrames(
  send: CdpSend,
  pageSessionId: string | undefined,
  options: CollectFramesOptions = {},
): Promise<AttachedFrame[]> {
  const { onEvent } = options;
  if (!onEvent) {
    return [];
  }
  const quietMs = options.attachQuietMs ?? DEFAULT_QUIET_MS;
  const maxMs = options.attachMaxMs ?? DEFAULT_MAX_MS;

  const sessions: string[] = [];
  let lastEventAt = Date.now();
  const unsubscribe = onEvent((event) => {
    if (event.method !== "Target.attachedToTarget") {
      return;
    }
    const params = event.params ?? {};
    if (params.targetInfo?.type !== "iframe" || typeof params.sessionId !== "string") {
      return;
    }
    lastEventAt = Date.now();
    if (!sessions.includes(params.sessionId)) {
      sessions.push(params.sessionId);
    }
  });

  const autoAttach = async (sessionId: string | undefined): Promise<void> => {
    try {
      await send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      );
    } catch {
      // A session that went away mid-attach yields no frames; that is a
      // rendering gap, never a reason to fail the whole snapshot.
    }
  };

  const deadline = Date.now() + maxMs;
  const armed = new Set<string>();
  try {
    await autoAttach(pageSessionId);
    for (;;) {
      for (const sessionId of sessions) {
        if (!armed.has(sessionId)) {
          armed.add(sessionId);
          await autoAttach(sessionId);
        }
      }
      const now = Date.now();
      if (now >= deadline || now - lastEventAt >= quietMs) {
        break;
      }
      await delay(Math.min(50, deadline - now));
    }
  } finally {
    unsubscribe();
  }

  const attached: AttachedFrame[] = [];
  for (const sessionId of sessions) {
    try {
      const tree = await send("Page.getFrameTree", {}, sessionId);
      const frame = tree?.frameTree?.frame;
      if (frame?.id) {
        attached.push({ frameId: String(frame.id), sessionId, url: String(frame.url ?? "") });
      }
    } catch {
      // Same reasoning as above: skip the frame, keep the snapshot.
    }
  }
  return attached;
}

/**
 * Fetch every frame reachable from the page session, parent before child.
 *
 * A page with no iframes costs exactly the two CDP calls 03-01 already made:
 * the iframe scan happens on the tree that was fetched anyway, and every extra
 * call below is gated behind finding at least one `<iframe>` node.
 */
export async function collectFrameGraph(
  send: CdpSend,
  pageSessionId: string | undefined,
  options: CollectFramesOptions = {},
): Promise<FrameGraph> {
  const bundles = new Map<string, FrameBundle>();
  const scopes = new Map<string, Map<string, DomIndex>>();
  const scopeKey = (sessionId: string | undefined) => sessionId ?? "";

  const [tree, indexes] = await Promise.all([
    fetchAxTree(send, pageSessionId),
    fetchFrameDomIndexes(send, pageSessionId),
  ]);
  const rootFrameId = indexes.rootFrameId;
  scopes.set(scopeKey(pageSessionId), indexes.byFrameId);

  const rootDomIndex = indexes.byFrameId.get(rootFrameId);
  const root: FrameBundle = {
    frameId: rootFrameId,
    sessionId: pageSessionId,
    url: rootDomIndex?.documentUrl ?? "",
    crossProcess: false,
    tree,
    domIndex: rootDomIndex ?? emptyIndex(),
    childFrames: new Map(),
    offsetX: 0,
    offsetY: 0,
  };
  bundles.set(rootFrameId, root);

  interface PendingCrossProcess {
    frameId: string;
    offsetX: number;
    offsetY: number;
  }
  const pending: PendingCrossProcess[] = [];
  const queue: FrameBundle[] = [root];
  /**
   * Every OOPIF session seen so far, across attach rounds.
   *
   * `Target.setAutoAttach` only emits `attachedToTarget` for a target that is
   * not already attached, so a grandchild picked up while arming its parent
   * would be lost if each round only kept the frames it was looking for at the
   * time. Caching them is what makes depth beyond one level work.
   */
  const attachedFrames = new Map<string, AttachedFrame>();

  // Two loops on purpose. The inner one drains every frame reachable without a
  // new attach; the outer one then attaches whatever OOPIFs that pass turned
  // up and feeds them back in. Draining the pending list inside the inner loop
  // would miss any OOPIF discovered while another frame was still queued.
  for (;;) {
    while (queue.length > 0) {
      const bundle = queue.shift() as FrameBundle;
      const iframeNodes = findIframeNodes(bundle.tree);
      if (iframeNodes.length === 0) {
        continue;
      }
      const sameProcess = scopes.get(scopeKey(bundle.sessionId)) ?? new Map();
      const frameIds = await describeIframeFrames(
        send,
        bundle.sessionId,
        iframeNodes.map((node) => node.backendNodeId as number),
      );
      for (const [backendNodeId, childFrameId] of frameIds) {
        bundle.childFrames.set(backendNodeId, childFrameId);
        if (bundles.has(childFrameId)) {
          continue;
        }
        const rect = bundle.domIndex.byBackendNodeId.get(backendNodeId)?.rect;
        const offsetX = bundle.offsetX + (rect?.x ?? 0);
        const offsetY = bundle.offsetY + (rect?.y ?? 0);
        const childIndex = sameProcess.get(childFrameId);
        if (!childIndex) {
          pending.push({ frameId: childFrameId, offsetX, offsetY });
          continue;
        }
        const childTree = await fetchAxTree(send, bundle.sessionId, childFrameId);
        const child: FrameBundle = {
          frameId: childFrameId,
          sessionId: bundle.sessionId,
          url: childIndex.documentUrl,
          crossProcess: bundle.crossProcess,
          tree: childTree,
          domIndex: childIndex,
          childFrames: new Map(),
          offsetX,
          offsetY,
        };
        bundles.set(childFrameId, child);
        queue.push(child);
      }
    }

    if (pending.length === 0) {
      break;
    }
    // Drain first: a frame that never attached must not be retried on the next
    // pass, or an unreachable OOPIF would loop forever.
    const wanted = pending.splice(0, pending.length);
    // Only pay for another attach round when something wanted is still unknown.
    if (wanted.some((entry) => !attachedFrames.has(entry.frameId))) {
      for (const frame of await attachCrossProcessFrames(send, pageSessionId, options)) {
        attachedFrames.set(frame.frameId, frame);
      }
    }
    let added = 0;
    for (const want of wanted) {
      const frame = attachedFrames.get(want.frameId);
      if (!frame || bundles.has(frame.frameId)) {
        continue;
      }
      const [childTree, childIndexes] = await Promise.all([
        fetchAxTree(send, frame.sessionId),
        fetchFrameDomIndexes(send, frame.sessionId),
      ]);
      scopes.set(scopeKey(frame.sessionId), childIndexes.byFrameId);
      const rootIndex = childIndexes.byFrameId.get(childIndexes.rootFrameId);
      const child: FrameBundle = {
        frameId: frame.frameId,
        sessionId: frame.sessionId,
        url: frame.url || rootIndex?.documentUrl || "",
        crossProcess: true,
        tree: childTree,
        domIndex: rootIndex ?? emptyIndex(),
        childFrames: new Map(),
        offsetX: want.offsetX,
        offsetY: want.offsetY,
      };
      bundles.set(frame.frameId, child);
      queue.push(child);
      added += 1;
    }
    if (added === 0) {
      break;
    }
  }

  return { rootFrameId, bundles };
}

function emptyIndex(): DomIndex {
  return {
    byBackendNodeId: new Map(),
    idCounts: new Map(),
    documentUrl: "",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
