import { replayCookies } from "./cookies.js";
import { withContext } from "./context.js";
import { replayIndexedDb } from "./indexeddb.js";
import { replayLocalStorage } from "./web-storage.js";
import type { Bundle, BundleOrigin } from "./bundle.js";
import type {
  OriginReplayResult,
  ReplayResult,
  ReplaySend,
  StoreOutcome,
} from "./types.js";

export * from "./bundle.js";
export * from "./types.js";
export { toCookieParam, replayCookies } from "./cookies.js";
export { replayLocalStorage } from "./web-storage.js";
export { replayIndexedDb, buildSeedScript, DECODER_SOURCE } from "./indexeddb.js";

export interface ReplayOptions {
  send: ReplaySend;
  /** The context to replay into. Omit to target the DEFAULT browser context. */
  browserContextId?: string;
  /** Subscribe to CDP events; needed to answer the fulfilled navigation. */
  onEvent: (listener: (event: CdpEventLike) => void) => () => void;
  /** How long to wait for the seeding page to be intercepted. */
  navigationTimeoutMs?: number;
}

export interface CdpEventLike {
  method: string;
  params?: Record<string, any>;
  sessionId?: string;
}

const DEFAULT_NAV_TIMEOUT_MS = 15_000;

/**
 * Replay a bundle into a browser context.
 *
 * Cookies go straight into the context's jar. localStorage and IndexedDB need a
 * renderer that holds the origin, so each origin gets a short-lived seeding tab
 * that is navigated to the origin with the document request FULFILLED as an
 * empty page — the real site never executes during seeding, which keeps a
 * logged-in session from running its own startup code against half-restored
 * state, and keeps the seed offline and deterministic.
 *
 * One failing store never stops the rest: every store's outcome is captured and
 * reported, so a partial replay is visible rather than silent.
 */
export async function replay(
  bundle: Bundle,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const origins: OriginReplayResult[] = [];
  for (const origin of bundle.origins) {
    origins.push(await replayOrigin(origin, options));
  }
  return {
    origins,
    ok: origins.every(
      (entry) => !entry.cookies.error && !entry.localStorage.error && !entry.indexedDB.error,
    ),
  };
}

async function replayOrigin(
  origin: BundleOrigin,
  options: ReplayOptions,
): Promise<OriginReplayResult> {
  const { send, browserContextId } = options;
  const result: OriginReplayResult = {
    origin: origin.origin,
    cookies: { count: 0 },
    localStorage: { count: 0 },
    indexedDB: { count: 0 },
  };

  result.cookies = await capture(async () => {
    const { verified } = await replayCookies(send, origin.cookies, browserContextId);
    return verified;
  });

  const needsPage =
    Object.keys(origin.localStorage).length > 0 || origin.indexedDB.length > 0;
  if (!needsPage) {
    return result;
  }

  let tab: SeedingTab | undefined;
  try {
    tab = await openSeedingTab(origin.origin, options);
  } catch (error) {
    const message = messageOf(error);
    result.localStorage = { count: 0, error: message };
    result.indexedDB = { count: 0, error: message };
    return result;
  }

  try {
    result.localStorage = await capture(() =>
      replayLocalStorage(send, tab.sessionId, origin.origin, origin.localStorage),
    );
    result.indexedDB = await capture(() =>
      replayIndexedDb(send, tab.sessionId, origin.indexedDB),
    );
  } finally {
    await tab.close();
  }
  return result;
}

/** Run one store's replay, turning a throw into a reported outcome. */
async function capture(run: () => Promise<number>): Promise<StoreOutcome> {
  try {
    return { count: await run() };
  } catch (error) {
    return { count: 0, error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SeedingTab {
  sessionId: string;
  targetId: string;
  close: () => Promise<void>;
}

/**
 * A tab in the context, sitting on `origin` with an empty document.
 *
 * `Fetch.enable` + `Fetch.fulfillRequest` is what makes this offline: the
 * navigation commits the origin (so localStorage and IndexedDB resolve to the
 * right partition) without a single byte coming from the real server.
 */
async function openSeedingTab(
  origin: string,
  options: ReplayOptions,
): Promise<SeedingTab> {
  const { send, browserContextId } = options;
  const timeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;

  const created = await send(
    "Target.createTarget",
    withContext({ url: "about:blank" }, browserContextId),
  );
  const targetId = created?.targetId;
  if (typeof targetId !== "string" || !targetId) {
    throw new Error("Target.createTarget returned no targetId for the seeding tab");
  }
  const attached = await send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("Target.attachToTarget returned no sessionId for the seeding tab");
  }

  const close = async (): Promise<void> => {
    try {
      await send("Fetch.disable", {}, sessionId);
    } catch {
      // The tab may already be gone; closing it is what matters.
    }
    try {
      await send("Target.closeTarget", { targetId });
    } catch {
      // A context torn down underneath us is not a replay failure.
    }
  };

  try {
    await send("Page.enable", {}, sessionId);
    await send("Fetch.enable", { patterns: [{ requestStage: "Request" }] }, sessionId);

    const settled = interceptOnce(origin, options, sessionId, timeoutMs);
    await send("Page.navigate", { url: `${origin}/` }, sessionId);
    await settled;
    return { sessionId, targetId, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Answer the seeding navigation with an empty 200, then wait for the load.
 *
 * Every paused request is answered — the document with an empty page, anything
 * else (a favicon the blank page still asks for) failed — because leaving one
 * paused would hang the renderer with `Fetch` enabled.
 */
function interceptOnce(
  origin: string,
  options: ReplayOptions,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const { send, onEvent } = options;
  const emptyBody = Buffer.from(
    "<!doctype html><meta charset=\"utf-8\"><title>grazer seed</title>",
    "utf8",
  ).toString("base64");

  return new Promise<void>((resolve, reject) => {
    let documentFulfilled = false;
    let loaded = false;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `seeding navigation to ${origin} did not complete within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );

    const unsubscribe = onEvent((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      if (event.method === "Fetch.requestPaused") {
        const requestId = event.params?.requestId;
        const isDocument = event.params?.resourceType === "Document";
        const answer = isDocument
          ? send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [
                  { name: "content-type", value: "text/html; charset=utf-8" },
                  { name: "cache-control", value: "no-store" },
                ],
                body: emptyBody,
              },
              sessionId,
            )
          : send("Fetch.failRequest", { requestId, errorReason: "Aborted" }, sessionId);
        answer.catch(() => {
          // A request that vanished before we answered it cannot hang anything.
        });
        if (isDocument) {
          documentFulfilled = true;
          if (loaded) finish();
        }
        return;
      }
      if (event.method === "Page.loadEventFired") {
        loaded = true;
        if (documentFulfilled) finish();
      }
    });
  });
}
