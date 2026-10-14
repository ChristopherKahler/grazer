/**
 * Generates the agent-facing API documentation in skills/grazer/ from the
 * runtime itself.
 *
 * The defect this exists to prevent: SKILL.md 1.2.6 documented a flat helper
 * API (`cliLog`, `snapshotText`, `useOrCreateTaskSpace`, …) that the built
 * runtime does not install, so every Quick start example threw
 * `ReferenceError` on its first line. A hand-written API reference cannot be
 * kept honest by review; it has to be derived.
 *
 * Two sources, and neither is trusted alone:
 *
 *   1. `helperContext()` — what the runtime actually installs. This is the
 *      authority on whether a name exists. Walking it is cheap and offline:
 *      the facades are plain tables of function references, so building them
 *      neither connects to a browser nor starts a task space.
 *   2. `FUNCTION_DOCS` in format.ts — the signature, params, return and
 *      example per entry, and the same table `console.log` renders a helper
 *      from.
 *
 * Reconciling the two is the point. A name installed with no doc entry, or a
 * doc entry naming something not installed, is a defect the drift test fails
 * on rather than something this module papers over.
 */
import { FUNCTION_DOCS, type FunctionDoc } from "./format.js";
import { FACADE_HELP, helperContext } from "./helpers.js";

export const MARKERS = {
  index: {
    begin: "<!-- BEGIN GENERATED: api-index -->",
    end: "<!-- END GENERATED: api-index -->",
  },
  reference: {
    begin: "<!-- BEGIN GENERATED: api-reference -->",
    end: "<!-- END GENERATED: api-reference -->",
  },
} as const;

// Selector handed to page.locator() purely to obtain a locator object and read
// its method names off it. Never evaluated against a page.
const LOCATOR_PROBE_SELECTOR = "css=body";

export type ApiEntry = {
  path: string;
  facade: string;
  member: string;
  doc: FunctionDoc | undefined;
};

export type ApiFacade = {
  name: string;
  blurb: string | undefined;
  entries: ApiEntry[];
};

export type ApiModel = {
  facades: ApiFacade[];
  locator: { blurb: string | undefined; methods: string[] };
  /** Installed with no entry in FUNCTION_DOCS. Must be empty. */
  undocumented: string[];
  /** Documented in FUNCTION_DOCS but not installed. Must be empty. */
  phantom: string[];
};

/**
 * Walk the installed helper surface into a flat, ordered list of callable
 * paths. Order is the runtime's own declaration order, so a reordered facade
 * shows up as a documentation change rather than being silently normalised.
 */
export function collectInstalledPaths(
  context: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "function") {
        paths.push(path);
      } else if (value && typeof value === "object") {
        walk(value as Record<string, unknown>, path);
      }
    }
  };
  walk(context, "");
  return paths;
}

/**
 * Read the locator facade's method names off a real locator object. These
 * carry no FUNCTION_DOCS entries, so they are listed by name only — inventing
 * signatures for them here is exactly the failure this generator exists to
 * stop.
 */
export function collectLocatorMethods(
  context: Record<string, unknown>,
): string[] {
  const page = context.page as
    | { locator?: (selector: string) => Record<string, unknown> }
    | undefined;
  if (typeof page?.locator !== "function") {
    return [];
  }
  const probe = page.locator(LOCATOR_PROBE_SELECTOR);
  return Object.entries(probe)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name);
}

export function buildApiModel(
  context: Record<string, unknown> = helperContext(),
): ApiModel {
  const installed = collectInstalledPaths(context);
  const byFacade = new Map<string, ApiEntry[]>();

  for (const path of installed) {
    const segments = path.split(".");
    // A bare callable (cdp, help) is its own group; anything deeper belongs to
    // the facade named by its first segment.
    const facade = segments.length === 1 ? "" : segments[0];
    const member = segments.length === 1 ? path : segments.slice(1).join(".");
    const entry: ApiEntry = {
      path,
      facade,
      member,
      doc: FUNCTION_DOCS[path],
    };
    const bucket = byFacade.get(facade);
    if (bucket) bucket.push(entry);
    else byFacade.set(facade, [entry]);
  }

  const facades: ApiFacade[] = [...byFacade.entries()].map(
    ([name, entries]) => ({
      name,
      blurb: FACADE_HELP[name],
      entries,
    }),
  );

  const installedSet = new Set(installed);
  return {
    facades,
    locator: {
      blurb: FACADE_HELP.locator,
      methods: collectLocatorMethods(context),
    },
    undocumented: installed.filter((path) => !(path in FUNCTION_DOCS)),
    phantom: Object.keys(FUNCTION_DOCS).filter((key) => !installedSet.has(key)),
  };
}

/**
 * The compact index that lives in SKILL.md: every installed callable, with the
 * signature the runtime declares for it. No prose is truncated to fit — the
 * descriptions, params and examples live in references/api.md, so this block
 * stays a complete answer to "does this exist and how do I call it".
 */
export function renderApiIndex(model: ApiModel): string {
  const lines: string[] = [];
  lines.push(
    "*Generated from the runtime by `npm run skill:doc` in `packages/harness`. Do not edit by hand.*",
    "",
    `Every name below is installed as a global in the \`grazer nodejs\` runtime. Full parameters, returns and examples: \`references/api.md\`.`,
  );

  for (const facade of model.facades) {
    lines.push("", `### ${facade.name ? `\`${facade.name}\`` : "Top level"}`);
    if (facade.blurb) {
      lines.push("", `> ${facade.blurb}`);
    }
    lines.push("");
    for (const entry of facade.entries) {
      lines.push(`- \`${signatureOf(entry)}\``);
    }
  }

  if (model.locator.methods.length > 0) {
    lines.push("", "### `Locator`");
    if (model.locator.blurb) {
      lines.push("", `> ${model.locator.blurb}`);
    }
    lines.push(
      "",
      "`page.locator(...)` and every `page.getBy*(...)` return a Locator carrying these methods. The runtime declares no signatures for them, so they are listed by name only — call `console.log(help('locator'))` for usage.",
      "",
      model.locator.methods.map((name) => `\`${name}\``).join(", "),
    );
  }

  return lines.join("\n");
}

/** The long-form reference that lives in references/api.md. */
export function renderApiReference(model: ApiModel): string {
  const lines: string[] = [];
  lines.push(
    "*Generated from the runtime by `npm run skill:doc` in `packages/harness`. Do not edit by hand.*",
    "",
    "Every entry is a global in the `grazer nodejs` runtime. Durations are milliseconds unless the parameter name says otherwise.",
  );

  for (const facade of model.facades) {
    lines.push("", `## ${facade.name ? `\`${facade.name}\`` : "Top level"}`);
    if (facade.blurb) {
      lines.push("", `> ${facade.blurb}`);
    }
    for (const entry of facade.entries) {
      lines.push("", `### \`${signatureOf(entry)}\``);
      const doc = entry.doc;
      if (!doc) {
        // buildApiModel reports this in `undocumented` and the drift test fails
        // on it, so this branch should be unreachable in a committed tree.
        lines.push(
          "",
          "The runtime installs this but declares no documentation for it.",
        );
        continue;
      }
      lines.push("", doc.description);
      if (doc.params?.length) {
        lines.push("");
        for (const param of doc.params) {
          const required = param.required ? "required" : "optional";
          const description = param.description ? ` ${param.description}` : "";
          lines.push(
            `- \`${param.name}\` — \`${param.type}\`, ${required}.${description}`,
          );
        }
      }
      if (doc.returns) {
        lines.push("", `Returns \`${doc.returns}\`.`);
      }
      if (doc.example) {
        lines.push("", "```js", doc.example, "```");
      }
    }
  }

  if (model.locator.methods.length > 0) {
    lines.push("", "## `Locator`");
    if (model.locator.blurb) {
      lines.push("", `> ${model.locator.blurb}`);
    }
    lines.push(
      "",
      "Returned by `page.locator(...)` and every `page.getBy*(...)`. The runtime's doc table carries no entries for these methods, so this list is names only, read off a live locator object. Do not assume a signature — `console.log(help('locator'))` is the runtime's own description.",
      "",
    );
    for (const name of model.locator.methods) {
      lines.push(`- \`${name}\``);
    }
  }

  return lines.join("\n");
}

/**
 * Replace the body between a marker pair, keeping the markers and every
 * hand-written line outside them untouched. Throws rather than appending when
 * the markers are missing, so a mangled file fails loudly instead of growing a
 * second copy of the reference.
 */
export function spliceBlock(
  markdown: string,
  marker: { begin: string; end: string },
  body: string,
): string {
  const begin = markdown.indexOf(marker.begin);
  const end = markdown.indexOf(marker.end);
  if (begin === -1 || end === -1) {
    throw new Error(
      `spliceBlock: missing marker pair ${marker.begin} … ${marker.end}`,
    );
  }
  if (end < begin) {
    throw new Error(`spliceBlock: ${marker.end} precedes ${marker.begin}`);
  }
  const head = markdown.slice(0, begin + marker.begin.length);
  const tail = markdown.slice(end);
  return `${head}\n\n${body}\n\n${tail}`;
}

/** Extract the current body between a marker pair, for drift comparison. */
export function extractBlock(
  markdown: string,
  marker: { begin: string; end: string },
): string {
  const begin = markdown.indexOf(marker.begin);
  const end = markdown.indexOf(marker.end);
  if (begin === -1 || end === -1) {
    throw new Error(
      `extractBlock: missing marker pair ${marker.begin} … ${marker.end}`,
    );
  }
  return markdown.slice(begin + marker.begin.length, end).trim();
}

function signatureOf(entry: ApiEntry): string {
  return entry.doc?.signature ?? `${entry.path}(…)`;
}
