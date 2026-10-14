/**
 * Shared types for the Grazer single-frame accessibility snapshot.
 *
 * The CDP transport lives behind {@link CdpSend} so the snapshot builds and
 * tests without a real connection: unit tests hand it a function backed by
 * committed fixtures, the live test hands it a WebSocket client.
 */

/** Minimal CDP seam: one method call, optional params, optional session. */
export type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<any>;

export type SnapshotScope = "full_page" | "only_within_viewport";

export interface SnapshotOptions {
  /** Whole document (default) or only what intersects the visual viewport. */
  scope?: SnapshotScope;
  /** Emit the `[ref=N, loc=..., url=...]` block on ref'd lines. Default true. */
  includeActionMarks?: boolean;
  /** Emit only interactive ref'd lines, flat and unindented. Default false. */
  interactiveOnly?: boolean;
  /** Emit `loc=` inside the action mark. Default true. */
  includeStableLocator?: boolean;
  /** Truncate content to roughly this many characters. 0 disables. Default 0. */
  maxResultLength?: number;
}

export type ResolvedSnapshotOptions = Required<SnapshotOptions>;

/** One entry of the ref map the harness turns into `@N` targets. */
export interface SnapshotRef {
  backendNodeId: number;
  role: string;
  name: string;
}

export interface SnapshotResult {
  content: string;
  refs: SnapshotRef[];
}

/** Accessibility node properties this renderer understands. */
export interface AxProps {
  focusable?: boolean;
  hidden?: boolean;
  hiddenRoot?: boolean;
  level?: number;
  checked?: string;
  expanded?: boolean;
  disabled?: boolean;
  selected?: boolean;
  required?: boolean;
  invalid?: string;
  url?: string;
}

/** Normalised `Accessibility.getFullAXTree` node with resolved children. */
export interface AxNode {
  /** CDP AX node id (string), kept for debugging and child resolution. */
  axNodeId: string;
  /** CDP `backendDOMNodeId` — the number that becomes `@N`. */
  backendNodeId?: number;
  role: string;
  name: string;
  ignored: boolean;
  props: AxProps;
  frameId?: string;
  children: AxNode[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One DOM node as seen through `DOMSnapshot.captureSnapshot`. */
export interface DomNodeInfo {
  backendNodeId: number;
  /** Upper-case tag name, e.g. `BUTTON`. */
  nodeName: string;
  id?: string;
  classList: string[];
  /** Raw `href` attribute, unresolved. */
  href?: string;
  /** Raw `alt` attribute — the harness needs it to match `img[alt]`. */
  alt?: string;
  /** Explicit `role` attribute, when the author set one. */
  roleAttr?: string;
  /** `type` attribute — decides an `<input>`'s implicit role. */
  typeAttr?: string;
  /** Document-relative CSS-pixel bounds, when the node was laid out. */
  rect?: Rect;
}

export interface DomIndex {
  byBackendNodeId: Map<number, DomNodeInfo>;
  /** How many nodes carry each `id` — an id is only a locator when unique. */
  idCounts: Map<string, number>;
  /** Absolute document URL, used to resolve relative hrefs. */
  documentUrl: string;
}

/** Visual viewport in document CSS pixels (`Page.getLayoutMetrics`). */
export interface Viewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}

/** One frame's fetched state: what the renderer needs to draw it. */
export interface FrameBundle {
  frameId: string;
  /** Undefined for the page session, set for an out-of-process frame. */
  sessionId?: string;
  url: string;
  /** True when the frame lives in its own renderer process (OOPIF). */
  crossProcess: boolean;
  tree?: AxNode;
  domIndex: DomIndex;
  /** `<iframe>` element backendNodeId (in THIS frame) -> child frame id. */
  childFrames: Map<number, string>;
  /**
   * Document-relative origin of this frame's `<iframe>` element in the page's
   * coordinate space. Child rects are relative to the child document, so
   * viewport tests add this offset first.
   */
  offsetX: number;
  offsetY: number;
}

/** Everything a nested render needs, keyed by frame. */
export interface FrameGraph {
  rootFrameId: string;
  bundles: Map<string, FrameBundle>;
}
