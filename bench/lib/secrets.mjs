/**
 * The credential tripwire for result files.
 *
 * Lives here, not in run.mjs, so a test can exercise it without importing an
 * entry point — importing a runner should never be able to start a run.
 */

/** Field names or values whose presence in a result would mean a leak. */
const SECRET_PATTERNS = [/cookie/i, /authorization/i, /\btoken\b/i, /password/i];

/**
 * Throw rather than write a result that looks like it carries a credential.
 *
 * Deliberately blunt: it matches on the serialised record, so a cookie hidden
 * inside a nested field or quoted in the agent's own answer is caught too. A
 * false positive costs one run; a false negative publishes a live session.
 */
export function assertNoSecrets(record) {
  const text = JSON.stringify(record);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(
        `refusing to write a result matching ${pattern} — a benchmark that leaks a live session is worse than no benchmark`,
      );
    }
  }
}
