// Origin/site helpers shared by the export pipeline.
//
// Cookies are keyed by registrable domain (eTLD+1), not origin, so the export
// asks `chrome.cookies.getAll({ domain: siteOf(origin) })`. A full public
// suffix list is overkill here; a short two-label table covers the suffixes a
// logged-in user is realistically holding cookies on.

const TWO_LABEL_SUFFIXES = new Set([
  'co.uk',
  'com.au',
  'co.jp',
  'com.br',
  'co.nz',
  'org.uk',
  'gov.uk',
  'ac.uk',
]);

/** True for IP literals and single-label hosts (localhost, intranet names). */
function isNonRegistrableHost(host) {
  if (host.includes(':') || host.startsWith('[')) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal
  return !host.includes('.');
}

/**
 * Registrable domain (eTLD+1) of an origin's host.
 * IP literals and single-label hosts come back unchanged so a fixture on
 * 127.0.0.1 is not mangled into "0.1".
 * @param {string} origin e.g. "https://app.example.co.uk"
 * @returns {string} e.g. "example.co.uk"
 */
export function siteOf(origin) {
  const host = new URL(origin).hostname;
  if (isNonRegistrableHost(host)) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * Normalised origin of any URL. Throws on urls without one (about:, chrome:).
 * @param {string} url
 * @returns {string}
 */
export function originOf(url) {
  const parsed = new URL(url);
  if (parsed.origin === 'null' || !parsed.origin) {
    throw new Error(`url has no origin: ${url}`);
  }
  return parsed.origin;
}

/** Match pattern selecting every tab on an origin. */
export function matchPatternFor(origin) {
  return `${originOf(origin)}/*`;
}
