/**
 * Fixture capture + shared live-browser plumbing for the snapshot tests.
 *
 * `node test/support/capture-ax.mjs` launches headless Chromium against
 * test/fixtures/snapshot/page.html and rewrites the three CDP payloads the
 * renderer consumes into committed JSON fixtures. The unit tests then exercise
 * the whole pipeline with no browser at all.
 *
 * No socket client lives here any more: everything talks CDP through
 * `dist/cdp/*`, the one client in the repo.
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "../../dist/cdp/connection.js";
import { launchChromium as launchBrowser } from "../../dist/cdp/launch.js";
import { attachToPage } from "../../dist/cdp/session.js";
import { findChromium, makeProfileDir, removeProfileDir } from "./chromium.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "..", "fixtures", "snapshot");
export const FIXTURE_ORIGIN = "http://fixture.local";
export const FIXTURE_FRAME_ID = "FIXTUREFRAME00000000000000000000";

/** Distinct hostnames, because Chrome isolates by site — a port is not a site. */
export const OUTER_HOST = "outer.test";
export const INNER_HOST = "inner.test";
export const DEEP_HOST = "deep.test";
const HOST_RESOLVER_RULE = `--host-resolver-rules=MAP *.test 127.0.0.1`;

/**
 * Launch flags shared by every fixture capture and live test.
 *
 * `--window-size` is load-bearing: `layout-metrics.json` records the resulting
 * viewport, so changing it changes a committed fixture.
 */
const BROWSER_ARGS = [
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--window-size=900,700",
];

export { findChromium };

/** Serve one HTML body on a random loopback port. */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Serve page.html (plus a /nav-target the fixture link points at). */
export async function startFixtureServer() {
  const html = await readFile(join(FIXTURE_DIR, "page.html"), "utf8");
  return listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      (req.url || "/").startsWith("/nav-target")
        ? "<!doctype html><title>Nav target</title><h1>Nav target</h1>"
        : html,
    );
  });
}

/**
 * Two listeners for the iframe fixture: the outer page plus a second origin
 * Chrome will put in its own renderer process.
 *
 * Different ports are the SAME site to Chrome, so a second port alone produces
 * a same-process iframe. Distinct `.test` hostnames (resolved to loopback by
 * HOST_RESOLVER_RULE) are what actually force an out-of-process frame.
 */
export async function startFramesServers() {
  const frames = await readFile(join(FIXTURE_DIR, "frames.html"), "utf8");
  const child = await readFile(join(FIXTURE_DIR, "child.html"), "utf8");
  const serveChild = (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(child);
  };
  const inner = await listen(serveChild);
  const outer = await listen((req, res) => {
    if ((req.url || "/").startsWith("/child.html")) {
      serveChild(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      frames
        .split("__CROSS_ORIGIN__")
        .join(`http://${INNER_HOST}:${inner.port}`),
    );
  });
  return {
    outerOrigin: `http://${OUTER_HOST}:${outer.port}`,
    innerOrigin: `http://${INNER_HOST}:${inner.port}`,
    async close() {
      await outer.close();
      await inner.close();
    },
  };
}

/**
 * Three listeners for the nested fixture: outer.test hosts the page, inner.test
 * an out-of-process child, and deep.test an out-of-process grandchild INSIDE
 * that child. Each hop is a distinct site, so Chrome gives each its own
 * renderer and the walk has to auto-attach twice to reach the bottom.
 */
export async function startNestedFramesServers() {
  const outerHtml = await readFile(join(FIXTURE_DIR, "frames-nested.html"), "utf8");
  const childHtml = await readFile(join(FIXTURE_DIR, "nested-child.html"), "utf8");
  const grandchildHtml = await readFile(join(FIXTURE_DIR, "grandchild.html"), "utf8");

  const deep = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(grandchildHtml);
  });
  const deepOrigin = `http://${DEEP_HOST}:${deep.port}`;
  const inner = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(childHtml.split("__DEEP_ORIGIN__").join(deepOrigin));
  });
  const innerOrigin = `http://${INNER_HOST}:${inner.port}`;
  const outer = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(outerHtml.split("__CROSS_ORIGIN__").join(innerOrigin));
  });
  return {
    outerOrigin: `http://${OUTER_HOST}:${outer.port}`,
    innerOrigin,
    deepOrigin,
    async close() {
      await outer.close();
      await inner.close();
      await deep.close();
    },
  };
}

/**
 * Launch headless Chromium on a throwaway profile.
 *
 * `crossOrigin: true` adds the host-resolver rule the iframe fixture needs; it
 * is off by default so the 03-01 capture keeps exactly its original flags.
 */
export async function launchChromium(executable, { crossOrigin = false } = {}) {
  const userDataDir = await makeProfileDir("grazer-snapshot-");
  const browser = await launchBrowser({
    executable,
    userDataDir,
    headless: true,
    extraArgs: crossOrigin ? [...BROWSER_ARGS, HOST_RESOLVER_RULE] : BROWSER_ARGS,
  });
  return {
    port: browser.port,
    endpoint: browser.wsUrl,
    async kill() {
      browser.kill();
      // Wait for the process to actually go before deleting its profile:
      // Chrome still holds locks in the directory for a moment after the kill
      // signal, and a removal that races it leaves a temp dir behind for good.
      await waitForExit(browser.process, 5_000);
      await removeProfileDir(userDataDir);
    },
  };
}

/**
 * A CDP connection whose `send` resolves with `result`, which is the shape the
 * snapshot fetchers expect (`dist/cdp` resolves with the full response frame).
 */
export async function connectCdp(endpoint) {
  const connection = await connect({ wsUrl: endpoint });
  return {
    connection,
    send: async (method, params = {}, sessionId) =>
      (await connection.send(method, params, sessionId)).result ?? {},
    on: (listener) => connection.onEvent(listener),
    close: () => connection.close(),
  };
}

/** Open `url` in a fresh page target and wait for its load event. */
export async function openPage(client, url) {
  const created = await client.send("Target.createTarget", { url: "about:blank" });
  const targetId = created.targetId;
  const sessionId = await attachToPage(client.connection, targetId);
  await client.send("Page.enable", {}, sessionId);
  const loaded = new Promise((resolve) => {
    const off = client.on((event) => {
      if (event.method === "Page.loadEventFired" && event.sessionId === sessionId) {
        off();
        resolve();
      }
    });
    setTimeout(() => {
      off();
      resolve();
    }, 15_000);
  });
  await client.send("Page.navigate", { url }, sessionId);
  await loaded;
  // The AX tree lags the load event by a frame on first paint.
  await delay(250);
  return { targetId, sessionId };
}

/** Run the three capture calls a snapshot depends on. */
export async function capturePayloads(client, sessionId) {
  await client.send("Accessibility.enable", {}, sessionId);
  const axTree = await client.send("Accessibility.getFullAXTree", {}, sessionId);
  const domSnapshot = await client.send(
    "DOMSnapshot.captureSnapshot",
    { computedStyles: [], includeDOMRects: true },
    sessionId,
  );
  const layoutMetrics = await client.send("Page.getLayoutMetrics", {}, sessionId);
  return { axTree, domSnapshot, layoutMetrics };
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const executable = findChromium();
  if (!executable) {
    console.error(
      "no Chromium found — set GRAZER_BROWSER to a Chrome or Brave executable",
    );
    process.exitCode = 1;
    return;
  }
  const server = await startFixtureServer();
  const browser = await launchChromium(executable);
  let client;
  try {
    client = await connectCdp(browser.endpoint);
    const { sessionId } = await openPage(client, `${server.origin}/`);
    const payloads = await capturePayloads(client, sessionId);
    const tree = await client.send("Page.getFrameTree", {}, sessionId);
    const frameId = tree?.frameTree?.frame?.id;
    const files = [
      ["ax-tree.json", payloads.axTree],
      ["dom-snapshot.json", payloads.domSnapshot],
      ["layout-metrics.json", payloads.layoutMetrics],
    ];
    for (const [name, payload] of files) {
      // The random port and the per-launch frame id are the only values that
      // move between captures; pin both so a regeneration diffs to nothing.
      let json = JSON.stringify(payload, null, 2).split(server.origin).join(FIXTURE_ORIGIN);
      if (frameId) {
        json = json.split(frameId).join(FIXTURE_FRAME_ID);
      }
      await writeFile(join(FIXTURE_DIR, name), `${json}\n`, "utf8");
      console.log(`wrote ${join("test", "fixtures", "snapshot", name)}`);
    }
  } finally {
    await client?.close();
    await browser.kill();
    await server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

/** Resolve once the child process has exited, or after `timeoutMs`. */
function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return delay(150);
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
  });
}
