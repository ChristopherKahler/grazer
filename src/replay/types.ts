/**
 * The CDP seam the replay modules run against.
 *
 * Same shape as the snapshot seam: one call, params, optional session. It
 * resolves with the `result` object rather than the whole frame, so the
 * modules read `response.cookies` instead of `response.result.cookies`.
 */
export type ReplaySend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<any>;

/** What one store contributed, or why it did not. */
export interface StoreOutcome {
  count: number;
  error?: string;
}

/** The result of replaying one origin out of a bundle. */
export interface OriginReplayResult {
  origin: string;
  cookies: StoreOutcome;
  localStorage: StoreOutcome;
  indexedDB: StoreOutcome;
}

export interface ReplayResult {
  origins: OriginReplayResult[];
  /** True when every store of every origin replayed without error. */
  ok: boolean;
}
