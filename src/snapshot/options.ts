import type { ResolvedSnapshotOptions, SnapshotScope } from "./types.js";

const SCOPES: readonly SnapshotScope[] = ["full_page", "only_within_viewport"];

export const SNAPSHOT_DEFAULTS: ResolvedSnapshotOptions = {
  scope: "full_page",
  includeActionMarks: true,
  interactiveOnly: false,
  includeStableLocator: true,
  maxResultLength: 0,
};

/**
 * Coerce caller-supplied snapshot options into a fully resolved shape.
 *
 * Never throws: an unknown scope, a non-object, or a garbage value for any
 * field falls back to the default. The agent-facing surface is a text
 * observation, so a bad option must degrade to a usable snapshot rather than
 * turn into an error the agent has to reason about.
 */
export function parseSnapshotOptions(input: unknown): ResolvedSnapshotOptions {
  const raw =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    scope: SCOPES.includes(raw.scope as SnapshotScope)
      ? (raw.scope as SnapshotScope)
      : SNAPSHOT_DEFAULTS.scope,
    includeActionMarks: bool(raw.includeActionMarks, SNAPSHOT_DEFAULTS.includeActionMarks),
    interactiveOnly: bool(raw.interactiveOnly, SNAPSHOT_DEFAULTS.interactiveOnly),
    includeStableLocator: bool(
      raw.includeStableLocator,
      SNAPSHOT_DEFAULTS.includeStableLocator,
    ),
    maxResultLength: positiveInt(raw.maxResultLength, SNAPSHOT_DEFAULTS.maxResultLength),
  };
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
