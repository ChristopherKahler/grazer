/**
 * Registering the native messaging host with Chrome, Brave, Edge and Chromium.
 *
 * Each browser finds a host by reading `HKCU\<vendor>\NativeMessagingHosts\<name>`,
 * whose default value is the path of a manifest JSON file. The manifest names the
 * executable and — crucially — the one extension id allowed to talk to it, so
 * the id is computed from the committed manifest key rather than typed by
 * hand. Everything lives under HKCU: registration never needs admin rights and
 * never touches machine-wide state.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOST_NAME = 'com.grazerai.companion';

export type Browser = 'chrome' | 'brave' | 'edge' | 'chromium';
export const BROWSERS: readonly Browser[] = ['chrome', 'brave', 'edge', 'chromium'];

/**
 * Where each browser looks. Other Chromium browsers (Vivaldi, Opera) generally
 * read Chrome's key, so registering for Chrome is meant to cover them too.
 */
const VENDOR_PATHS: Record<Browser, string> = {
  chrome: 'Software\\Google\\Chrome',
  brave: 'Software\\BraveSoftware\\Brave-Browser',
  edge: 'Software\\Microsoft\\Edge',
  chromium: 'Software\\Chromium',
};

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

/** The registry key a browser reads to discover this host. */
export function registryKey(browser: Browser): string {
  return `HKCU\\${VENDOR_PATHS[browser]}\\NativeMessagingHosts\\${HOST_NAME}`;
}

/** The host manifest Chrome reads. `cmdPath` is the .cmd wrapper around node. */
export function hostManifest({ extensionId, cmdPath }: { extensionId: string; cmdPath: string }): HostManifest {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error(`not a valid extension id: ${extensionId}`);
  }
  return {
    name: HOST_NAME,
    description: 'Grazer Sync native messaging host',
    path: cmdPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/**
 * Display form of a reg invocation — what the dry run prints, and what a user
 * can paste into a shell. Registry keys and paths are quoted whether or not
 * this particular machine happens to have a space in them.
 */
export function formatCommand(argv: readonly string[]): string {
  return argv
    .map((part) => (/[\s"\\]/.test(part) ? `"${part}"` : part))
    .join(' ');
}

export function regAddArgv(browser: Browser, manifestPath: string): string[] {
  return ['reg', 'add', registryKey(browser), '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}

export function regDeleteArgv(browser: Browser): string[] {
  return ['reg', 'delete', registryKey(browser), '/f'];
}

export function regQueryArgv(browser: Browser): string[] {
  return ['reg', 'query', registryKey(browser), '/ve'];
}

/** Injected so tests never touch the real registry. */
export type Runner = (argv: readonly string[]) => { status: number; output: string };

export const systemRunner: Runner = (argv) => {
  if (process.platform !== 'win32') {
    return { status: 1, output: 'the registry is only available on Windows' };
  }
  try {
    const output = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, output };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? failure.message ?? ''}`.trim(),
    };
  }
}

export interface RegisterOptions {
  extensionId: string;
  /** Any of BROWSERS. */
  browsers: readonly Browser[];
  home: string;
  cmdPath: string;
  dryRun?: boolean;
  run?: Runner;
}

export interface RegisterResult {
  manifest: HostManifest;
  manifestPath: string;
  steps: Array<{ browser: Browser; command: string; status: number; output: string; skipped: boolean }>;
  dryRun: boolean;
}

/** Write the host manifest and point each browser's registry key at it. */
export function registerNativeHost(options: RegisterOptions): RegisterResult {
  const { extensionId, browsers, home, cmdPath, dryRun = false, run = systemRunner } = options;
  const manifest = hostManifest({ extensionId, cmdPath });
  const manifestDir = join(home, 'native-host');
  const manifestPath = join(manifestDir, `${HOST_NAME}.json`);

  if (!dryRun) {
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  const steps = browsers.map((browser) => {
    const argv = regAddArgv(browser, manifestPath);
    const command = formatCommand(argv);
    if (dryRun) return { browser, command, status: 0, output: '', skipped: true };
    const { status, output } = run(argv);
    return { browser, command, status, output, skipped: false };
  });

  return { manifest, manifestPath, steps, dryRun };
}

export interface UnregisterOptions {
  browsers: readonly Browser[];
  dryRun?: boolean;
  run?: Runner;
}

export function unregisterNativeHost(options: UnregisterOptions): RegisterResult['steps'] {
  const { browsers, dryRun = false, run = systemRunner } = options;
  return browsers.map((browser) => {
    const argv = regDeleteArgv(browser);
    const command = formatCommand(argv);
    if (dryRun) return { browser, command, status: 0, output: '', skipped: true };
    const { status, output } = run(argv);
    return { browser, command, status, output, skipped: false };
  });
}

export interface StatusEntry {
  browser: Browser;
  registered: boolean;
  manifestPath: string | null;
  command: string;
}

/** What `grazer-sync status` reports: is each browser pointed at a manifest? */
export function statusNativeHost(options: { browsers: readonly Browser[]; run?: Runner }): StatusEntry[] {
  const { browsers, run = systemRunner } = options;
  return browsers.map((browser) => {
    const argv = regQueryArgv(browser);
    const { status, output } = run(argv);
    // `reg query <key> /ve` prints: "    (Default)    REG_SZ    C:\path\to.json"
    const match = /\(Default\)\s+REG_SZ\s+(.+?)\s*$/m.exec(output);
    return {
      browser,
      registered: status === 0 && match !== null,
      manifestPath: match ? match[1]!.trim() : null,
      command: formatCommand(argv),
    };
  });
}
