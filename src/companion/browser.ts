/**
 * The companion browser: a Chromium-family browser (the one picked at setup,
 * see browsers.ts) that Grazer runs on its own profile, with a debug port open.
 *
 * It outlives the CLI invocation that started it — an agent runs many
 * `grazer nodejs` heredocs against one long-lived browser — so the process is
 * spawned detached and its descriptor is written to `<GRAZER_HOME>/browser.json`
 * for later invocations to find.
 *
 * A dedicated `--user-data-dir` is not optional: Chrome 136+ ignores
 * `--remote-debugging-port` on the default profile.
 */

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { connect, productFromVersion } from "../cdp/connection.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { launchChromium } from "../cdp/launch.js";
import { findBrowserExecutable } from "./browsers.js";
import {
  browserStatePath,
  defaultProfileDir,
  ensureDir,
  ensureGrazerHome,
} from "./paths.js";

export { findBrowserExecutable } from "./browsers.js";

/** What `browser.json` holds. */
export interface BrowserState {
  port: number;
  wsUrl: string;
  pid: number;
  startedAt: string;
  profileDir: string;
  executable: string;
}

export interface StartOptions {
  /** Default true: agents never open a visible window. Only `--headed` sets false. */
  headless?: boolean;
  profileDir?: string;
  executable?: string;
}

export interface StatusResult {
  running: boolean;
  product?: string;
  state: BrowserState | null;
}

/** Read `browser.json`, or null when it is absent or unreadable. */
export async function readBrowserState(): Promise<BrowserState | null> {
  try {
    const raw = await readFile(browserStatePath(), "utf8");
    const parsed = JSON.parse(raw) as BrowserState;
    if (typeof parsed?.port !== "number" || typeof parsed?.pid !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write `browser.json` atomically — tmp + rename, because a half-written
 * descriptor read by a concurrent `grazer nodejs` is worse than none at all.
 * The retry behaviour lives in `writeJsonAtomic`, shared with the space store.
 */
async function writeBrowserState(state: BrowserState): Promise<void> {
  ensureGrazerHome();
  writeJsonAtomic(browserStatePath(), state);
}

/** Delete `browser.json`. */
async function clearBrowserState(): Promise<void> {
  await rm(browserStatePath(), { force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a pid is still alive. Signal 0 tests without delivering anything. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** GET /json/version with a short timeout. Returns the product string, or null. */
async function probeProduct(
  port: number,
  timeoutMs = 3000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { Browser?: string };
    return typeof body.Browser === "string" ? body.Browser : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The browser process's own pid, asked over CDP, or null if it will not say. */
async function browserPidOverCdp(port: number): Promise<number | null> {
  try {
    const connection = await connect({ port, openTimeoutMs: 3000 });
    try {
      const reply = await connection.send("SystemInfo.getProcessInfo", {});
      const info = (reply.result ?? {}) as { processInfo?: Array<{ type?: string; id?: number }> };
      const browser = info.processInfo?.find((entry) => entry.type === "browser");
      return typeof browser?.id === "number" && browser.id > 0 ? browser.id : null;
    } finally {
      await connection.close();
    }
  } catch {
    return null;
  }
}

/**
 * The live status of the companion browser. Never throws on a dead browser —
 * "not running" is an answer, not a failure.
 */
export async function browserStatus(): Promise<StatusResult> {
  const state = await readBrowserState();
  if (!state) return { running: false, state: null };
  const product = await probeProduct(state.port);
  if (!product) return { running: false, state };
  return { running: true, product, state };
}

/**
 * Start the companion browser, or report the running one.
 *
 * A second `start` is not an error: the agent workflow is "start it if it isn't
 * up", so an already-running browser is success.
 */
export async function startBrowser(
  options: StartOptions = {},
): Promise<{ state: BrowserState; alreadyRunning: boolean; product: string }> {
  const existing = await browserStatus();
  if (existing.running && existing.state) {
    return {
      state: existing.state,
      alreadyRunning: true,
      product: existing.product ?? "",
    };
  }

  const executable = findBrowserExecutable(options.executable);
  const profileDir = ensureDir(options.profileDir ?? defaultProfileDir());
  ensureGrazerHome();

  const launched = await launchChromium({
    executable,
    userDataDir: profileDir,
    headless: options.headless ?? true,
    detached: true,
    timeoutMs: 15_000,
  });

  const product = await probeProduct(launched.port, 5000);
  if (!product) {
    launched.kill();
    throw new Error(
      `browser started on port ${launched.port} but /json/version did not answer`,
    );
  }

  // After a handoff (Edge) the launched pid is gone; stopBrowser's forced-kill
  // fallback needs the real one.
  const pid = launched.pid ?? (await browserPidOverCdp(launched.port)) ?? -1;

  const state: BrowserState = {
    port: launched.port,
    wsUrl: launched.wsUrl,
    pid,
    startedAt: new Date().toISOString(),
    profileDir,
    executable,
  };
  await writeBrowserState(state);
  return { state, alreadyRunning: false, product };
}

/**
 * Stop the companion browser.
 *
 * `Browser.close` first so Chrome writes its profile out cleanly; a forced kill
 * only if it will not go. The descriptor is removed either way — leaving one
 * behind that points at nothing is the failure mode this is guarding against.
 */
export async function stopBrowser(): Promise<{
  stopped: boolean;
  wasRunning: boolean;
}> {
  const state = await readBrowserState();
  if (!state) return { stopped: false, wasRunning: false };

  const wasRunning = (await probeProduct(state.port)) !== null;
  if (wasRunning) {
    try {
      const connection = await connect({ port: state.port, openTimeoutMs: 3000 });
      // Browser.close tears the socket down under us; the request never answers.
      connection.send("Browser.close").catch(() => {});
      await sleep(150);
      await connection.close();
    } catch {
      // Fall through to the forced kill.
    }
  }

  const deadline = Date.now() + 5000;
  while (state.pid > 0 && pidAlive(state.pid) && Date.now() < deadline) {
    await sleep(100);
  }

  if (state.pid > 0 && pidAlive(state.pid)) {
    await forceKill(state.pid);
    // Give the OS a moment to reap it before the caller checks.
    const killDeadline = Date.now() + 3000;
    while (pidAlive(state.pid) && Date.now() < killDeadline) {
      await sleep(100);
    }
  }

  await clearBrowserState();
  return { stopped: true, wasRunning };
}

/** Kill a process tree. Chrome spawns renderers, so the whole tree has to go. */
function forceKill(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

/** The product string for a running browser, via CDP rather than the HTTP endpoint. */
export async function browserVersionOverCdp(port: number): Promise<string> {
  const connection = await connect({ port, openTimeoutMs: 5000 });
  try {
    return productFromVersion(await connection.send("Browser.getVersion"));
  } finally {
    await connection.close();
  }
}
