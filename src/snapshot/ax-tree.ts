import type { AxNode, AxProps, CdpSend } from "./types.js";

/**
 * Fetch and normalise the accessibility tree for one frame.
 *
 * `frameId` is accepted (and forwarded) so iframe/OOPIF recursion can reuse
 * this fetcher unchanged; this plan only ever calls it for the main frame.
 */
export async function fetchAxTree(
  send: CdpSend,
  sessionId?: string,
  frameId?: string,
): Promise<AxNode | undefined> {
  // Accessibility.enable is idempotent, and Chrome will not populate a full
  // tree until it has been called at least once on the session.
  await send("Accessibility.enable", {}, sessionId);
  const params: Record<string, unknown> = {};
  if (frameId) {
    params.frameId = frameId;
  }
  const response = await send("Accessibility.getFullAXTree", params, sessionId);
  return buildAxTree(response?.nodes);
}

/**
 * Build a parent→children tree from CDP's flat `nodes[]` array.
 *
 * Exported for tests: the renderer is pure, and so is this, so both are
 * exercised against committed fixtures without a browser.
 */
export function buildAxTree(rawNodes: unknown): AxNode | undefined {
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    return undefined;
  }
  const byId = new Map<string, AxNode>();
  const childIds = new Map<string, string[]>();
  const claimed = new Set<string>();

  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const node = raw as Record<string, any>;
    const axNodeId = String(node.nodeId ?? "");
    if (!axNodeId || byId.has(axNodeId)) {
      continue;
    }
    byId.set(axNodeId, {
      axNodeId,
      backendNodeId:
        typeof node.backendDOMNodeId === "number" ? node.backendDOMNodeId : undefined,
      role: readValue(node.role) ?? "",
      name: readValue(node.name) ?? "",
      ignored: node.ignored === true,
      props: readProps(node.properties),
      frameId: typeof node.frameId === "string" ? node.frameId : undefined,
      children: [],
    });
    const ids = Array.isArray(node.childIds) ? node.childIds.map(String) : [];
    childIds.set(axNodeId, ids);
  }

  for (const [parentId, ids] of childIds) {
    const parent = byId.get(parentId);
    if (!parent) {
      continue;
    }
    for (const childId of ids) {
      const child = byId.get(childId);
      // A child can be missing (partial trees) or already attached elsewhere;
      // both would otherwise produce a cycle or a duplicated subtree.
      if (!child || claimed.has(childId) || childId === parentId) {
        continue;
      }
      claimed.add(childId);
      parent.children.push(child);
    }
  }

  for (const raw of rawNodes) {
    const axNodeId = String((raw as Record<string, any>)?.nodeId ?? "");
    const node = byId.get(axNodeId);
    if (node && !claimed.has(axNodeId)) {
      return node;
    }
  }
  return undefined;
}

function readValue(field: unknown): string | undefined {
  if (!field || typeof field !== "object") {
    return undefined;
  }
  const value = (field as Record<string, unknown>).value;
  return value === undefined || value === null ? undefined : String(value);
}

function readProps(properties: unknown): AxProps {
  const props: AxProps = {};
  if (!Array.isArray(properties)) {
    return props;
  }
  for (const entry of properties) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const name = String((entry as Record<string, any>).name ?? "");
    const value = (entry as Record<string, any>).value?.value;
    if (value === undefined || value === null) {
      continue;
    }
    switch (name) {
      case "focusable":
      case "hidden":
      case "hiddenRoot":
      case "expanded":
      case "disabled":
      case "selected":
      case "required":
        props[name] = value === true || value === "true";
        break;
      case "level":
        props.level = Number(value);
        break;
      case "checked":
      case "invalid":
        props[name] = String(value);
        break;
      case "url":
        props.url = String(value);
        break;
      default:
        break;
    }
  }
  return props;
}
