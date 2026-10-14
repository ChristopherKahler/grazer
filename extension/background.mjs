// Grazer Sync service worker.
//
// Two entry points, both reachable from the popup and from the live test via
// CDP Runtime.evaluate on this worker:
//   self.grazerExport(origins)  -> the v1 bundle, nothing leaves the browser
//   self.grazerSync(origins)    -> export, then hand the bundle to the
//                                  companion's native messaging host
//
// The bundle is never written to disk here and never crosses the network; the
// only sink is the native host, which Chrome brokers by extension id.

import { chromeDeps, exportOrigins, summariseBundle } from './lib/bundle.mjs';

const HOST_NAME = 'com.grazerai.companion';

/** sendNativeMessage returns a promise from Chrome 116; keep a callback path anyway. */
function sendNative(message) {
  const result = chrome.runtime.sendNativeMessage(HOST_NAME, message);
  if (result && typeof result.then === 'function') return result;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(reply);
    });
  });
}

/** Export the given origins into a v1 bundle. */
async function grazerExport(origins) {
  return exportOrigins(origins, chromeDeps(chrome));
}

/** Export and deliver. Resolves with the host's reply plus per-origin counts. */
async function grazerSync(origins) {
  const bundle = await grazerExport(origins);
  const summary = summariseBundle(bundle);
  const reply = await sendNative({ type: 'bundle', bundle });
  return { reply, summary };
}

self.grazerExport = grazerExport;
self.grazerSync = grazerSync;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'sync') {
    grazerSync(message.origins || []).then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true;
  }

  if (message.type === 'ping-host') {
    sendNative({ type: 'hello' }).then(
      (reply) => sendResponse({ ok: true, reply }),
      (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
    );
    return true;
  }

  return false;
});
