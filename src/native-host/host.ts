/**
 * The Grazer Sync native messaging host.
 *
 * Chrome starts this process, hands it the extension origin on argv, and talks
 * length-prefixed JSON over stdio. Nothing but frames may go to stdout — a
 * stray console.log corrupts the stream and Chrome drops the connection — so
 * every diagnostic goes to the log file under the Grazer home.
 *
 * Messages it answers:
 *   { type: "hello" }            -> { type: "hello",  version, home }
 *   { type: "bundle", bundle }   -> { type: "stored", path, bytes, origins }
 *   anything else / bad frame    -> { type: "error",  message }
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { FrameReader, encodeFrame } from './framing.js';

export const HOST_NAME = 'com.grazerai.companion';
export const HOST_VERSION = 1;

/** Where bundles and logs live. GRAZER_HOME wins; otherwise %LOCALAPPDATA%\Grazer. */
export function grazerHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GRAZER_HOME;
  if (configured && configured.trim().length > 0) return configured;
  const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim().length > 0
    ? env.LOCALAPPDATA
    : join(homedir(), 'AppData', 'Local');
  return join(base, 'Grazer');
}

/** yyyymmdd-hhmmss in local time. */
export function timestamp(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join('-');
}

/** Keep a site safe to use as a file name. */
export function sanitiseSite(site: unknown): string {
  const text = typeof site === 'string' ? site : '';
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return safe.length > 0 ? safe.slice(0, 64) : 'unknown';
}

type BundleLike = { origins?: Array<{ site?: string }> };

/** `<site>-<yyyymmdd-hhmmss>.json`, with a counter when a name is already taken. */
export function bundlePath(dir: string, bundle: BundleLike, now: Date = new Date()): string {
  const first = bundle?.origins?.[0];
  const base = `${sanitiseSite(first?.site)}-${timestamp(now)}`;
  let candidate = join(dir, `${base}.json`);
  for (let n = 2; existsSync(candidate); n += 1) candidate = join(dir, `${base}-${n}.json`);
  return candidate;
}

export interface HostContext {
  home: string;
  log: (line: string) => void;
  now: () => Date;
}

/** Build the reply for one decoded message. Pure apart from the bundle write. */
export function handleMessage(message: unknown, ctx: HostContext): Record<string, unknown> {
  if (message === null || typeof message !== 'object') {
    return { type: 'error', message: 'message must be an object' };
  }
  const type = (message as { type?: unknown }).type;

  if (type === 'hello') {
    return { type: 'hello', version: HOST_VERSION, home: ctx.home };
  }

  if (type === 'bundle') {
    const bundle = (message as { bundle?: unknown }).bundle;
    if (bundle === null || typeof bundle !== 'object') {
      return { type: 'error', message: 'bundle must be an object' };
    }
    const dir = join(ctx.home, 'bundles');
    mkdirSync(dir, { recursive: true });
    const path = bundlePath(dir, bundle as BundleLike, ctx.now());
    const json = JSON.stringify(bundle);
    writeFileSync(path, json, 'utf8');
    const origins = Array.isArray((bundle as BundleLike).origins)
      ? (bundle as BundleLike).origins!.length
      : 0;
    ctx.log(`stored ${path} (${Buffer.byteLength(json)} bytes, ${origins} origins)`);
    return { type: 'stored', path, bytes: Buffer.byteLength(json), origins };
  }

  return { type: 'error', message: `unknown message type: ${String(type)}` };
}

function makeLogger(home: string): (line: string) => void {
  const dir = join(home, 'logs');
  return (line: string) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'native-host.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      // Logging must never take the host down, and stdout is not available.
    }
  };
}

/** Wire stdin/stdout up to the message handler. */
export function main(): void {
  const home = grazerHome();
  const log = makeLogger(home);
  const ctx: HostContext = { home, log, now: () => new Date() };
  const reader = new FrameReader();

  log(`host started (pid ${process.pid}, home ${home})`);

  const reply = (value: Record<string, unknown>) => {
    process.stdout.write(encodeFrame(value));
  };

  process.stdin.on('data', (chunk: Buffer) => {
    for (const frame of reader.push(chunk)) {
      if (!frame.ok) {
        log(`bad frame: ${frame.error}`);
        reply({ type: 'error', message: frame.error });
        continue;
      }
      try {
        reply(handleMessage(frame.value, ctx));
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        log(`handler failed: ${message}`);
        reply({ type: 'error', message });
      }
    }
  });

  process.stdin.on('end', () => {
    log('stdin closed, exiting');
    process.exit(0);
  });

  process.stdin.on('error', (err: Error) => {
    log(`stdin error: ${err.message}`);
    process.exit(0);
  });
}

// Chrome runs this file directly (through bin/grazer-native-host.cmd).
if (process.argv[1] && process.argv[1].endsWith('host.js')) main();
