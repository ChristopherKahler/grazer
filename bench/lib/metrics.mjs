/**
 * Turn one `claude --print --output-format json` result into the benchmark's
 * metrics.
 *
 * The whole reason this file exists is a trap measured on 2026-09-03:
 *
 *   usage.input_tokens              10
 *   usage.cache_creation_input_tokens  20925
 *   usage.cache_read_input_tokens      15209
 *
 * `input_tokens` was 10 while the run's real billable input was 36,144. A
 * benchmark reading that field alone reports ~10 input tokens for every driver
 * and is pure noise. Input is the SUM of all three.
 *
 * Absent is not zero. Every field that is missing records `null`, so a report
 * can say "not measured" instead of quietly claiming a driver used nothing.
 */

/** Sum of the three input-token fields, or null when none is present. */
export function inputTokensOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].filter((value) => typeof value === "number");
  return parts.length === 0 ? null : parts.reduce((a, b) => a + b, 0);
}

function numberOr(value, fallback = null) {
  return typeof value === "number" ? value : fallback;
}

function add(a, b) {
  return a === null || b === null ? null : a + b;
}

/**
 * Metrics from a parsed result object.
 *
 * `fixedTokens` is the FIRST turn's input — the driver's tool schemas, skill
 * text and system prompt, paid before the agent has read the task. It comes
 * from `usage.iterations[0]` when the CLI reports per-turn usage; when it does
 * not, it is null rather than guessed, and the report shows the split as
 * unavailable rather than inventing one.
 *
 * Note the schemas are not a one-off: they land in cache_creation on turn one
 * and cache_read on every turn after, so a large tool schema is a recurring
 * per-turn cost. That is why the split is measured, not subtracted.
 */
export function metricsFrom(result) {
  const usage = result?.usage;
  const inputTokens = inputTokensOf(usage);
  const outputTokens = numberOr(usage?.output_tokens);

  const first = Array.isArray(usage?.iterations) ? usage.iterations[0] : undefined;
  const fixedTokens = first ? inputTokensOf(first) : null;
  const taskTokens =
    fixedTokens === null || inputTokens === null ? null : inputTokens - fixedTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens: add(inputTokens, outputTokens),
    fixedTokens,
    taskTokens,
    costUsd: numberOr(result?.total_cost_usd),
    apiMs: numberOr(result?.duration_api_ms),
    numTurns: numberOr(result?.num_turns),
    isError: typeof result?.is_error === "boolean" ? result.is_error : null,
    terminalReason: typeof result?.terminal_reason === "string" ? result.terminal_reason : null,
    permissionDenials: Array.isArray(result?.permission_denials)
      ? result.permission_denials.length
      : null,
  };
}

/** The agent's final answer. `result` is the CLI's field for it. */
export function finalAnswerOf(result) {
  if (typeof result?.result === "string") return result.result;
  return null;
}

/** Parse the CLI's stdout, tolerating any leading noise before the JSON object. */
export function parseCliJson(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  if (start < 0) return { ok: false, error: "no JSON object in stdout", result: null };
  try {
    return { ok: true, error: null, result: JSON.parse(text.slice(start)) };
  } catch (error) {
    return { ok: false, error: `unparseable JSON: ${error.message}`, result: null };
  }
}
