/**
 * Chromium launcher.
 *
 * `--remote-debugging-port=0` lets the OS pick a free port; Chrome then writes
 * the chosen port and its browser websocket path into `DevToolsActivePort` in
 * the user-data-dir (~500 ms after launch). Polling that file is the only
 * race-free way to learn the port — parsing stderr is not a contract.
 *
 * A dedicated `--user-data-dir` is mandatory: Chrome 136+ ignores
 * `--remote-debugging-port` when launched against the default profile.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface LaunchOptions {
  /** Absolute path to a Chromium-family executable. */
  executable: string;
  /** Dedicated profile directory. Never the user's default profile. */
  userDataDir: string;
  /** Run with `--headless=new`. */
  headless?: boolean;
  /** Extra command-line switches, appended before the start URL. */
  extraArgs?: string[];
  /** Page to open at start. */
  startUrl?: string;
  /** How long to wait for DevToolsActivePort to appear. */
  timeoutMs?: number;
  /**
   * Detach the browser from this process so it outlives the CLI invocation that
   * started it. The companion needs this; a test that owns the browser for the
   * length of one run does not.
   */
  detached?: boolean;
}

export interface LaunchedBrowser {
  /** The debug port Chrome actually chose. */
  port: number;
  /** Browser websocket path, e.g. `/devtools/browser/<id>`. */
  wsPath: string;
  /** The full browser websocket URL. */
  wsUrl: string;
  /** The launched process's pid; undefined when it handed off (see `handedOff`). */
  pid: number | undefined;
  /**
   * True when the executable started the real browser as another process and
   * exited cleanly (Microsoft Edge does this). The browser is running, but not
   * as `process`; ask it for its own pid over CDP.
   */
  handedOff: boolean;
  process: ChildProcess;
  kill(): void;
}

const POLL_INTERVAL_MS = 50;

/**
 * Read `DevToolsActivePort`: line 1 is the port, line 2 the browser ws path.
 * Returns null while the file is absent or half-written.
 */
async function readActivePort(
  userDataDir: string,
): Promise<{ port: number; wsPath: string } | null> {
  let raw: string;
  try {
    raw = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
  } catch {
    return null;
  }
  const [portLine, wsPath] = raw.split("\n");
  const port = Number.parseInt(portLine ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || !wsPath) return null;
  return { port, wsPath: wsPath.trim() };
}

export async function launchChromium(
  options: LaunchOptions,
): Promise<LaunchedBrowser> {
  const {
    executable,
    userDataDir,
    headless = true,
    extraArgs = [],
    startUrl = "about:blank",
    timeoutMs = 15_000,
    detached = false,
  } = options;

  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    ...extraArgs,
    startUrl,
  ];

  // Chrome leaves DevToolsActivePort behind when it exits, so restarting on an
  // existing profile would otherwise hand us the PREVIOUS browser's port: the
  // poll below reads the stale file long before the new browser rewrites it,
  // and every connection then goes to a port nothing is listening on. Removing
  // it first makes any value we read afterwards necessarily the new browser's.
  await rm(join(userDataDir, "DevToolsActivePort"), { force: true });

  const child = spawn(executable, args, {
    stdio: "ignore",
    windowsHide: true,
    detached,
  });

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };

  let exited: Error | null = null;
  let handedOff = false;
  child.once("error", (error) => {
    exited = error;
  });
  child.once("exit", (code, signal) => {
    // A clean exit before the port file is a handoff, not a crash: the
    // executable started the real browser as another process and left. Keep
    // polling; that browser writes DevToolsActivePort into the same profile.
    if (code === 0 && signal === null && exited === null) {
      handedOff = true;
      return;
    }
    exited ??= new Error(
      `browser exited before DevToolsActivePort appeared (code=${code}, signal=${signal})`,
    );
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const active = await readActivePort(userDataDir);
    if (active) {
      // Only once the port is known: unref-ing earlier would let this process
      // exit while the launch is still in doubt.
      if (detached) child.unref();
      return {
        port: active.port,
        wsPath: active.wsPath,
        wsUrl: `ws://127.0.0.1:${active.port}${active.wsPath}`,
        pid: handedOff ? undefined : child.pid,
        handedOff,
        process: child,
        kill,
      };
    }
    if (exited) {
      kill();
      throw exited;
    }
    if (Date.now() >= deadline) {
      // A launch that never reported a port must not leave a process behind.
      kill();
      throw new Error(
        handedOff
          ? `browser handed off to another process that did not write DevToolsActivePort within ${timeoutMs}ms; close any browser still using ${userDataDir}`
          : `browser did not write DevToolsActivePort within ${timeoutMs}ms (${userDataDir})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
