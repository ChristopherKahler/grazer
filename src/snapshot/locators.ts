import type { AxNode, DomIndex, DomNodeInfo } from "./types.js";

/**
 * Stable locators for ref'd nodes, in the grammar the harness parses
 * (`packages/harness/src/locator-query.ts`): `css:`, `role:` and `href:`.
 *
 * Every locator emitted here must actually resolve on the other side, so the
 * rules below mirror the harness's own resolution rather than the general
 * shape of a CSS or ARIA selector:
 *
 * - `css:#id` only when the id is unique across the document.
 * - `href:` only when exactly one `a[href]` resolves to that path, and the path
 *   is `pathname + search + hash` — the exact string the harness compares.
 * - `role:` only when the harness's own implicit-role mapping agrees with the
 *   accessibility role, the element is reachable from its candidate selector,
 *   and the (role, name) pair is unique among ref'd nodes.
 */

/** Candidate tags in `roleCandidateSelector()` keyed by their implicit role. */
const IMPLICIT_INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
};

export interface LocatorInput {
  node: AxNode;
  role: string;
  name: string;
}

export interface LocatorTables {
  /** How many ref'd nodes share each `role\nname` pair. */
  roleNameCounts: Map<string, number>;
  /** How many `a[href]` nodes resolve to each path. */
  hrefCounts: Map<string, number>;
}

/** Pre-compute the ambiguity tables a locator decision needs. */
export function buildLocatorTables(
  refCandidates: readonly LocatorInput[],
  domIndex: DomIndex,
): LocatorTables {
  const roleNameCounts = new Map<string, number>();
  for (const candidate of refCandidates) {
    const key = `${candidate.role}\n${candidate.name}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) ?? 0) + 1);
  }
  const hrefCounts = new Map<string, number>();
  for (const info of domIndex.byBackendNodeId.values()) {
    if (info.nodeName !== "A" || info.href === undefined) {
      continue;
    }
    const path = hrefPath(info.href, domIndex.documentUrl);
    if (path) {
      hrefCounts.set(path, (hrefCounts.get(path) ?? 0) + 1);
    }
  }
  return { roleNameCounts, hrefCounts };
}

/** The best stable locator for one ref'd node, or undefined when ambiguous. */
export function stableLocator(
  candidate: LocatorInput,
  domIndex: DomIndex,
  tables: LocatorTables,
): string | undefined {
  const info =
    candidate.node.backendNodeId === undefined
      ? undefined
      : domIndex.byBackendNodeId.get(candidate.node.backendNodeId);
  if (!info) {
    return undefined;
  }
  if (info.id && domIndex.idCounts.get(info.id) === 1) {
    return `css:#${cssEscape(info.id)}`;
  }
  if (info.nodeName === "A" && info.href !== undefined) {
    const path = hrefPath(info.href, domIndex.documentUrl);
    if (path && tables.hrefCounts.get(path) === 1) {
      return `href:${path}`;
    }
  }
  const roleLocator = roleNameLocator(candidate, info, tables);
  return roleLocator;
}

/** Absolute URL for a link, from the AX `url` property or the DOM href. */
export function absoluteUrl(
  node: AxNode,
  info: DomNodeInfo | undefined,
  documentUrl: string,
): string | undefined {
  if (node.props.url) {
    return node.props.url;
  }
  if (!info || info.href === undefined) {
    return undefined;
  }
  try {
    return new URL(info.href, documentUrl || undefined).href;
  } catch {
    return info.href || undefined;
  }
}

function roleNameLocator(
  candidate: LocatorInput,
  info: DomNodeInfo,
  tables: LocatorTables,
): string | undefined {
  const { role, name } = candidate;
  if (!name || !/^[A-Za-z0-9_-]+$/.test(role)) {
    return undefined;
  }
  if (tables.roleNameCounts.get(`${role}\n${name}`) !== 1) {
    return undefined;
  }
  if (harnessRole(info) !== role) {
    return undefined;
  }
  return `role:${role}[name=${quoteName(name)}]`;
}

/**
 * The role the harness will compute for this element, mirroring
 * `roleElementsExpression`. Returning undefined means the element is not even
 * reachable from `roleCandidateSelector()`, so a `role:` locator would match
 * nothing.
 */
function harnessRole(info: DomNodeInfo): string | undefined {
  const explicit = (info.roleAttr ?? "").split(/\s+/).filter(Boolean)[0];
  if (explicit) {
    return explicit;
  }
  const tag = info.nodeName;
  if (tag === "BUTTON") return "button";
  if (tag === "A") return info.href === undefined ? undefined : "link";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "SELECT") return "combobox";
  if (tag === "IMG") return info.alt === undefined ? undefined : "img";
  if (/^H[1-6]$/.test(tag)) return "heading";
  if (tag === "INPUT") {
    return IMPLICIT_INPUT_ROLES[(info.typeAttr ?? "").toLowerCase()] ?? "textbox";
  }
  return undefined;
}

/**
 * Quote a name so the harness's `parseLocatorString` reads it back verbatim.
 *
 * That parser strips a matching pair of quotes and only unescapes when the
 * result parses as JSON — so a backslash-escaped single quote would survive
 * into the match and break it. Plain names therefore use the house single-quote
 * style; anything with a quote, backslash or control character uses a JSON
 * double-quoted string, which round-trips exactly.
 */
function quoteName(name: string): string {
  if (!/["'\\\x00-\x1f]/.test(name)) {
    return `'${name}'`;
  }
  return JSON.stringify(name);
}

/** `pathname + search + hash`, the exact string `hrefElementsExpression` compares. */
function hrefPath(href: string, documentUrl: string): string | undefined {
  try {
    const url = new URL(href, documentUrl || undefined);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

/** CSS.escape for an identifier — the browser has it, Node does not. */
export function cssEscape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const char = value[i];
    if (code === 0) {
      out += "�";
    } else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)
    ) {
      out += `\\${code.toString(16)} `;
    } else if (code >= 0x80 || char === "-" || char === "_" || /[A-Za-z0-9]/.test(char)) {
      out += char;
    } else {
      out += `\\${char}`;
    }
  }
  if (out === "-") {
    return "\\-";
  }
  return out;
}
