import {
  absoluteUrl,
  buildLocatorTables,
  stableLocator,
  type LocatorInput,
} from "./locators.js";
import type {
  AxNode,
  DomIndex,
  FrameBundle,
  FrameGraph,
  DomNodeInfo,
  Rect,
  ResolvedSnapshotOptions,
  SnapshotRef,
  SnapshotResult,
  Viewport,
} from "./types.js";

/**
 * Roles that can be acted on. These drive both ref assignment and the
 * `interactiveOnly` filter.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "switch",
  "treeitem",
]);

/**
 * Navigation anchors: ref'd for orientation, never "interactive".
 *
 * `iframe` belongs here because the ELEMENT lives in the parent document, so
 * its backendNodeId resolves on the page session even when the frame it hosts
 * is out-of-process and read-only.
 */
const NAVIGATION_ROLES: ReadonlySet<string> = new Set([
  "iframe",
  "heading",
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);

/**
 * Structural wrappers that carry no meaning of their own. They are not
 * rendered; their children are promoted to the wrapper's own depth. A node here
 * that earns a ref (a focusable `<div>`, say) is rendered anyway.
 */
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set([
  "rootwebarea",
  "webarea",
  "generic",
  "none",
  "presentation",
  "genericcontainer",
  "labeltext",
]);

/**
 * Blink-internal nodes that only duplicate what a rendered sibling already
 * says: `InlineTextBox` repeats its `StaticText` parent one line-box at a time,
 * and `ListMarker` is the bullet glyph. Dropped with their subtrees.
 */
const DROPPED_ROLES: ReadonlySet<string> = new Set([
  "inlinetextbox",
  "listmarker",
  "linebreak",
]);

/** Roles that never earn a ref, however focusable Chrome reports them. */
const NEVER_REF_ROLES: ReadonlySet<string> = new Set([
  "rootwebarea",
  "webarea",
  "document",
  "statictext",
]);

const TEXT_ROLE = "statictext";
const IFRAME_ROLE = "iframe";

/**
 * Shown once directly under a cross-site iframe line.
 *
 * Measured, not assumed: an OOPIF's backendNodeIds restart at 1 in its own
 * renderer, and `DOM.resolveNode { backendNodeId: 9 }` on the page session
 * rejects with "No node with given id found". The harness keys its ref map by
 * `String(backendNodeId)` and resolves through the page session
 * (`packages/harness/src/element-resolver.ts:158-175`), so an OOPIF ref would
 * either fail or — where the number happens to exist in the main frame —
 * silently resolve to the WRONG element. Rendering the content without refs is
 * the honest envelope: the agent can read it and knows it cannot click it.
 */
export const CROSS_SITE_NOTE = "note: cross-site frame, elements are read-only";

interface RenderItem {
  depth: number;
  role: string;
  name: string;
  node: AxNode;
  ref?: number;
  interactive: boolean;
  /** Frame the item came from; OOPIF items never earn a ref. */
  crossProcess: boolean;
  domIndex: DomIndex;
  /** Emitted verbatim instead of a node line (the cross-site note). */
  literal?: string;
}

/**
 * Render a normalised AX tree into the agent-facing text surface.
 *
 * Pure: everything it needs has already been fetched, so the whole format is
 * testable against committed fixtures with no browser in the loop.
 */
export function renderSnapshot(
  tree: AxNode | undefined,
  domIndex: DomIndex,
  viewport: Viewport | undefined,
  options: ResolvedSnapshotOptions,
): SnapshotResult {
  if (!tree) {
    return { content: "", refs: [] };
  }
  const frameId = "";
  const graph: FrameGraph = {
    rootFrameId: frameId,
    bundles: new Map([
      [
        frameId,
        {
          frameId,
          url: domIndex.documentUrl,
          crossProcess: false,
          tree,
          domIndex,
          childFrames: new Map<number, string>(),
          offsetX: 0,
          offsetY: 0,
        },
      ],
    ]),
  };
  return renderFrames(graph, viewport, options);
}

/**
 * Render a whole frame graph: each `<iframe>` line is followed by its child
 * frame's tree, indented one level deeper.
 */
export function renderFrames(
  graph: FrameGraph,
  viewport: Viewport | undefined,
  options: ResolvedSnapshotOptions,
): SnapshotResult {
  const root = graph.bundles.get(graph.rootFrameId);
  if (!root?.tree) {
    return { content: "", refs: [] };
  }
  const clip =
    options.scope === "only_within_viewport" && viewport ? toClip(viewport) : undefined;
  const items = collectFrame(root, graph, clip, options, 0, new Set());

  const refItems = items.filter((item) => item.ref !== undefined);
  const candidates: LocatorInput[] = refItems.map((item) => ({
    node: item.node,
    role: item.role,
    name: item.name,
  }));
  // Locator ambiguity is judged per frame: two documents may each hold an
  // element with the same id without either being ambiguous in its own frame.
  const tablesByIndex = new Map<DomIndex, ReturnType<typeof buildLocatorTables>>();
  for (const item of refItems) {
    if (tablesByIndex.has(item.domIndex)) {
      continue;
    }
    const perFrame = refItems
      .filter((other) => other.domIndex === item.domIndex)
      .map((other) => ({ node: other.node, role: other.role, name: other.name }));
    tablesByIndex.set(item.domIndex, buildLocatorTables(perFrame, item.domIndex));
  }
  const tablesFor = (domIndex: DomIndex) =>
    tablesByIndex.get(domIndex) ?? buildLocatorTables([], domIndex);

  const visible = options.interactiveOnly
    ? items.filter((item) => item.interactive && item.ref !== undefined)
    : items;

  const lines = visible.map((item) =>
    item.literal !== undefined
      ? `${"  ".repeat(options.interactiveOnly ? 0 : item.depth)}- ${item.literal}`
      : renderLine(
          item,
          options.interactiveOnly ? 0 : item.depth,
          item.domIndex,
          tablesFor(item.domIndex),
          options,
        ),
  );

  // refs always covers every ref'd node that survived the viewport filter, even
  // when the marks or non-interactive lines are hidden — the harness turns this
  // array into its refMap, and a missing entry is what produces "Unknown ref".
  const refs: SnapshotRef[] = candidates.map((candidate) => ({
    backendNodeId: candidate.node.backendNodeId as number,
    role: candidate.role,
    name: candidate.name,
  }));

  return { content: truncate(lines.join("\n"), options.maxResultLength), refs };
}

/**
 * Walk one frame, descending into child frames wherever an `<iframe>` node
 * carries a frame we managed to fetch.
 *
 * `seen` guards against a cyclic frame graph (a frame that somehow reports an
 * ancestor as its child) turning the walk into infinite recursion.
 */
function collectFrame(
  bundle: FrameBundle,
  graph: FrameGraph,
  clip: Rect | undefined,
  options: ResolvedSnapshotOptions,
  baseDepth: number,
  seen: ReadonlySet<string>,
): RenderItem[] {
  const items: RenderItem[] = [];
  if (!bundle.tree) {
    return items;
  }
  const { domIndex, crossProcess } = bundle;
  const nextSeen = new Set(seen).add(bundle.frameId);

  const visit = (node: AxNode, depth: number, ancestorVisible: boolean): void => {
    const role = node.role;
    const key = role.toLowerCase();
    if (DROPPED_ROLES.has(key) || node.props.hidden === true) {
      return;
    }
    const info =
      node.backendNodeId === undefined
        ? undefined
        : domIndex.byBackendNodeId.get(node.backendNodeId);
    const inViewport = clip
      ? info?.rect
        ? intersects(shift(info.rect, bundle.offsetX, bundle.offsetY), clip)
        : ancestorVisible
      : true;

    // A cross-site frame's nodes are readable but not addressable; see
    // CROSS_SITE_NOTE for the measurement behind that.
    const ref = inViewport && !crossProcess ? refFor(node, key, options) : undefined;
    const isIframe = IFRAME_ROLE === key;
    const rendered =
      inViewport && (ref !== undefined || isIframe || !isTransparent(node, key));

    if (rendered) {
      items.push({
        depth,
        role: isIframe ? IFRAME_ROLE : role,
        name: collapse(node.name),
        node,
        ref,
        interactive: INTERACTIVE_ROLES.has(key),
        crossProcess,
        domIndex,
      });
    }
    const childDepth = rendered ? depth + 1 : depth;

    if (isIframe && node.backendNodeId !== undefined && inViewport) {
      const childFrameId = bundle.childFrames.get(node.backendNodeId);
      const child = childFrameId ? graph.bundles.get(childFrameId) : undefined;
      if (child && !nextSeen.has(child.frameId)) {
        if (child.crossProcess) {
          items.push({
            depth: childDepth,
            role: "note",
            name: "",
            node,
            interactive: false,
            crossProcess: true,
            domIndex: child.domIndex,
            literal: CROSS_SITE_NOTE,
          });
        }
        items.push(...collectFrame(child, graph, clip, options, childDepth, nextSeen));
      }
    }

    for (const child of node.children) {
      visit(child, childDepth, inViewport);
    }
  };

  visit(bundle.tree, baseDepth, true);
  return items;
}

function isTransparent(node: AxNode, key: string): boolean {
  // An ignored node is a pass-through parent: Chrome walks its children into
  // the tree but the node itself is not part of the accessible view.
  return node.ignored || TRANSPARENT_ROLES.has(key);
}

function refFor(
  node: AxNode,
  key: string,
  options: ResolvedSnapshotOptions,
): number | undefined {
  if (node.backendNodeId === undefined || node.ignored || NEVER_REF_ROLES.has(key)) {
    return undefined;
  }
  if (INTERACTIVE_ROLES.has(key) || node.props.focusable === true) {
    return node.backendNodeId;
  }
  if (options.includeActionMarks && NAVIGATION_ROLES.has(key)) {
    return node.backendNodeId;
  }
  return undefined;
}

function renderLine(
  item: RenderItem,
  depth: number,
  domIndex: DomIndex,
  tables: ReturnType<typeof buildLocatorTables>,
  options: ResolvedSnapshotOptions,
): string {
  const indent = "  ".repeat(depth);
  if (item.role.toLowerCase() === TEXT_ROLE) {
    return `${indent}- text: ${item.name}`;
  }
  let line = `${indent}- ${item.role}`;
  if (item.name) {
    line += ` "${item.name}"`;
  }
  const mark = actionMark(item, domIndex, tables, options);
  if (mark) {
    line += ` ${mark}`;
  }
  for (const flag of stateFlags(item.node)) {
    line += ` [${flag}]`;
  }
  return line;
}

function actionMark(
  item: RenderItem,
  domIndex: DomIndex,
  tables: ReturnType<typeof buildLocatorTables>,
  options: ResolvedSnapshotOptions,
): string | undefined {
  if (!options.includeActionMarks || item.ref === undefined) {
    return undefined;
  }
  const parts = [`ref=${item.ref}`];
  if (options.includeStableLocator) {
    const loc = stableLocator(
      { node: item.node, role: item.role, name: item.name },
      domIndex,
      tables,
    );
    if (loc) {
      parts.push(`loc=${loc}`);
    }
  }
  if (item.role.toLowerCase() === "link") {
    const info: DomNodeInfo | undefined =
      item.node.backendNodeId === undefined
        ? undefined
        : domIndex.byBackendNodeId.get(item.node.backendNodeId);
    const url = absoluteUrl(item.node, info, domIndex.documentUrl);
    if (url) {
      parts.push(`url=${url}`);
    }
  }
  return `[${parts.join(", ")}]`;
}

function stateFlags(node: AxNode): string[] {
  const flags: string[] = [];
  const { props } = node;
  if (typeof props.level === "number" && Number.isFinite(props.level)) {
    flags.push(`level=${props.level}`);
  }
  if (props.checked && props.checked !== "false") {
    flags.push(props.checked === "true" ? "checked" : `checked=${props.checked}`);
  }
  if (props.disabled) {
    flags.push("disabled");
  }
  if (props.expanded !== undefined) {
    flags.push(props.expanded ? "expanded" : "collapsed");
  }
  if (props.selected) {
    flags.push("selected");
  }
  if (props.required) {
    flags.push("required");
  }
  if (props.invalid && props.invalid !== "false") {
    flags.push("invalid");
  }
  return flags;
}

/** Cut on a line boundary and say what was dropped — never silently shorten. */
function truncate(content: string, maxResultLength: number): string {
  if (maxResultLength <= 0 || content.length <= maxResultLength) {
    return content;
  }
  const total = content.length;
  const boundary = content.lastIndexOf("\n", maxResultLength);
  const kept = content.slice(0, boundary > 0 ? boundary : maxResultLength);
  return `${kept}\n[truncated: ${kept.length} of ${total} chars]`;
}

function toClip(viewport: Viewport): Rect {
  return {
    x: viewport.pageX,
    y: viewport.pageY,
    width: viewport.clientWidth,
    height: viewport.clientHeight,
  };
}

function shift(rect: Rect, dx: number, dy: number): Rect {
  return dx === 0 && dy === 0 ? rect : { ...rect, x: rect.x + dx, y: rect.y + dy };
}

function intersects(rect: Rect, clip: Rect): boolean {
  return (
    rect.x < clip.x + clip.width &&
    rect.x + rect.width > clip.x &&
    rect.y < clip.y + clip.height &&
    rect.y + rect.height > clip.y
  );
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
