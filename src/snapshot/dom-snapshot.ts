import type { CdpSend, DomIndex, DomNodeInfo, Rect, Viewport } from "./types.js";

/**
 * One `DOMSnapshot.captureSnapshot` call yields every node's tag, attributes
 * and layout rect. That is the whole reason this fetcher exists: locators and
 * viewport scoping both need per-node DOM facts, and asking CDP per node
 * (`DOM.getBoxModel`, `DOM.getAttributes`) would cost hundreds of round trips.
 */
export async function fetchDomIndex(
  send: CdpSend,
  sessionId?: string,
): Promise<DomIndex> {
  const response = await send(
    "DOMSnapshot.captureSnapshot",
    { computedStyles: [], includeDOMRects: true },
    sessionId,
  );
  return buildDomIndex(response);
}

/** Visual viewport in document CSS pixels; only needed for viewport scope. */
export async function fetchViewport(
  send: CdpSend,
  sessionId?: string,
): Promise<Viewport | undefined> {
  const metrics = await send("Page.getLayoutMetrics", {}, sessionId);
  const viewport = metrics?.cssVisualViewport ?? metrics?.visualViewport;
  if (!viewport) {
    return undefined;
  }
  return {
    pageX: num(viewport.pageX),
    pageY: num(viewport.pageY),
    clientWidth: num(viewport.clientWidth),
    clientHeight: num(viewport.clientHeight),
  };
}

/**
 * Decode the string-table encoded capture into a backendNodeId lookup.
 *
 * Exported so the unit tests can decode a committed fixture without a browser.
 */
export function buildDomIndex(response: unknown): DomIndex {
  const { rootFrameId, byFrameId } = buildFrameDomIndexes(response);
  return (
    byFrameId.get(rootFrameId) ?? {
      byBackendNodeId: new Map<number, DomNodeInfo>(),
      idCounts: new Map<string, number>(),
      documentUrl: "",
    }
  );
}

/**
 * Decode EVERY document in one capture, keyed by frame id.
 *
 * `DOMSnapshot.captureSnapshot` returns one entry in `documents[]` per document
 * in the page's renderer process — the main frame plus every same-process
 * iframe. An out-of-process frame is simply absent, which is exactly how frames
 * get classified here without spending a `Page.getFrameTree` call on it.
 */
export function buildFrameDomIndexes(response: unknown): {
  rootFrameId: string;
  byFrameId: Map<string, DomIndex>;
} {
  const byFrameId = new Map<string, DomIndex>();
  const payload = response as Record<string, any> | null | undefined;
  const strings: string[] = Array.isArray(payload?.strings) ? payload!.strings : [];
  const documents: any[] = Array.isArray(payload?.documents) ? payload!.documents : [];
  const str = (i: unknown): string | undefined => {
    if (typeof i !== "number" || i < 0 || i >= strings.length) {
      return undefined;
    }
    return strings[i];
  };
  let rootFrameId = "";
  for (let d = 0; d < documents.length; d += 1) {
    const doc = documents[d];
    if (!doc) {
      continue;
    }
    const frameId = str(doc.frameId) ?? (d === 0 ? "" : `frame-${d}`);
    if (d === 0) {
      rootFrameId = frameId;
    }
    byFrameId.set(frameId, decodeDocument(doc, str));
  }
  return { rootFrameId, byFrameId };
}

function decodeDocument(
  doc: Record<string, any>,
  str: (i: unknown) => string | undefined,
): DomIndex {
  const index: DomIndex = {
    byBackendNodeId: new Map<number, DomNodeInfo>(),
    idCounts: new Map<string, number>(),
    documentUrl: str(doc.documentURL) ?? str(doc.baseURL) ?? "",
  };

  const nodes = doc.nodes ?? {};
  const backendNodeIds: number[] = Array.isArray(nodes.backendNodeId)
    ? nodes.backendNodeId
    : [];
  const nodeNames: unknown[] = Array.isArray(nodes.nodeName) ? nodes.nodeName : [];
  const attributes: unknown[] = Array.isArray(nodes.attributes) ? nodes.attributes : [];

  const byIndex: (DomNodeInfo | undefined)[] = new Array(backendNodeIds.length);
  for (let i = 0; i < backendNodeIds.length; i += 1) {
    const backendNodeId = backendNodeIds[i];
    if (typeof backendNodeId !== "number") {
      continue;
    }
    const attrs = decodeAttributes(attributes[i], str);
    const info: DomNodeInfo = {
      backendNodeId,
      nodeName: (str(nodeNames[i]) ?? "").toUpperCase(),
      classList: splitClasses(attrs.class),
    };
    if (attrs.id) {
      info.id = attrs.id;
      index.idCounts.set(attrs.id, (index.idCounts.get(attrs.id) ?? 0) + 1);
    }
    if (attrs.href !== undefined) {
      info.href = attrs.href;
    }
    if (attrs.alt !== undefined) {
      info.alt = attrs.alt;
    }
    if (attrs.role !== undefined) {
      info.roleAttr = attrs.role;
    }
    if (attrs.type !== undefined) {
      info.typeAttr = attrs.type;
    }
    byIndex[i] = info;
    index.byBackendNodeId.set(backendNodeId, info);
  }

  const layout = doc.layout ?? {};
  const layoutNodeIndex: number[] = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
  const bounds: unknown[] = Array.isArray(layout.bounds) ? layout.bounds : [];
  for (let i = 0; i < layoutNodeIndex.length; i += 1) {
    const info = byIndex[layoutNodeIndex[i]];
    const rect = toRect(bounds[i]);
    // Nodes without layout (display:none, detached) simply keep rect
    // undefined — the renderer treats that as "inherit the ancestor's
    // viewport decision" rather than an error.
    if (info && rect) {
      info.rect = rect;
    }
  }
  return index;
}

function decodeAttributes(
  raw: unknown,
  str: (i: unknown) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(raw)) {
    return out;
  }
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = str(raw[i]);
    const value = str(raw[i + 1]);
    if (name !== undefined) {
      out[name] = value ?? "";
    }
  }
  return out;
}

function splitClasses(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(/\s+/).filter(Boolean);
}

function toRect(raw: unknown): Rect | undefined {
  if (!Array.isArray(raw) || raw.length < 4) {
    return undefined;
  }
  const [x, y, width, height] = raw.map(num);
  if (width <= 0 && height <= 0) {
    return undefined;
  }
  return { x, y, width, height };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** One capture, decoded per frame — the multi-frame form of `fetchDomIndex`. */
export async function fetchFrameDomIndexes(
  send: CdpSend,
  sessionId?: string,
): Promise<{ rootFrameId: string; byFrameId: Map<string, DomIndex> }> {
  const response = await send(
    "DOMSnapshot.captureSnapshot",
    { computedStyles: [], includeDOMRects: true },
    sessionId,
  );
  return buildFrameDomIndexes(response);
}
