/**
 * Cookie replay.
 *
 * `Storage.setCookies { cookies, browserContextId }` is a browser-session call
 * that writes straight into a context's cookie jar, which is what makes
 * HttpOnly cookies replayable at all — no page can set one, and no page-side
 * script is involved here.
 */

import type { BundleCookie } from "./bundle.js";
import type { ReplaySend } from "./types.js";
import { withContext } from "./context.js";

/** CDP `Network.CookieParam`, restricted to the fields a bundle can fill. */
export interface CdpCookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

/**
 * `chrome.cookies` spelling to CDP spelling.
 *
 * `unspecified` maps to *omitting* the field rather than to any value: CDP
 * treats an absent sameSite as the browser default, while sending a concrete
 * value would upgrade or downgrade the cookie's cross-site behaviour.
 */
const SAME_SITE: Record<string, CdpCookieParam["sameSite"]> = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
};

/**
 * Map one bundle cookie to a CDP CookieParam.
 *
 * Pure, and unit-tested, because every field here is a way to silently replay
 * a subtly different cookie than the user actually had.
 */
export function toCookieParam(cookie: BundleCookie): CdpCookieParam {
  const param: CdpCookieParam = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  const sameSite = SAME_SITE[cookie.sameSite];
  if (sameSite) {
    param.sameSite = sameSite;
  }
  // A session cookie has no expiry by definition; sending one would outlive
  // the browser run the user actually had.
  if (!cookie.session && typeof cookie.expirationDate === "number") {
    param.expires = cookie.expirationDate;
  }
  if (cookie.partitionKey) {
    // Grazer replays a top-level session, so the ancestor chain is same-site by
    // construction; the extension records no ancestor bit to carry over.
    param.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      hasCrossSiteAncestor: false,
    };
  }
  return param;
}

export interface CookieReplayResult {
  /** How many cookies were handed to CDP. */
  sent: number;
  /** How many of those `Storage.getCookies` reports back for the context. */
  verified: number;
}

/**
 * Write a bundle's cookies into a browser context and read them back.
 *
 * The read-back is not ceremony: `Storage.setCookies` resolves without telling
 * you which cookies it rejected (a bad domain, a `__Host-` prefix violation),
 * so counting what actually landed is the only honest report.
 */
export async function replayCookies(
  send: ReplaySend,
  cookies: readonly BundleCookie[],
  browserContextId: string | undefined,
): Promise<CookieReplayResult> {
  if (cookies.length === 0) {
    return { sent: 0, verified: 0 };
  }
  const params = cookies.map(toCookieParam);
  await send("Storage.setCookies", withContext({ cookies: params }, browserContextId));

  const stored = await send("Storage.getCookies", withContext({}, browserContextId));
  const present = new Set(
    (Array.isArray(stored?.cookies) ? stored.cookies : []).map(
      (cookie: { name?: string; domain?: string; path?: string }) =>
        `${cookie.name}\n${cookie.domain}\n${cookie.path}`,
    ),
  );
  const verified = params.filter((param) =>
    present.has(`${param.name}\n${param.domain}\n${param.path}`),
  ).length;
  return { sent: params.length, verified };
}
