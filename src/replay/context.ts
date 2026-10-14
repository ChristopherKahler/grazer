/**
 * Building CDP params that target a browser context, or the default one.
 *
 * Every CDP call that takes an optional `browserContextId` acts on the DEFAULT
 * browser context when the field is omitted — and omitted means the key is
 * ABSENT from the frame. `{ browserContextId: undefined }` is not the same
 * thing: it survives as a key through most JSON serialisers' object handling
 * and Chrome rejects the call rather than defaulting. So the choice is made
 * here once, and no caller builds the field by hand.
 */

/**
 * Add `browserContextId` only when there is one.
 * @param params the call's own parameters
 * @param browserContextId the context to target, or undefined for the default
 */
export function withContext<T extends Record<string, unknown>>(
  params: T,
  browserContextId: string | undefined,
): T & { browserContextId?: string } {
  if (browserContextId === undefined) return params;
  return { ...params, browserContextId };
}
