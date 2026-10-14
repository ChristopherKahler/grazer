/**
 * Which browser Grazer runs.
 *
 * Grazer drives a separate profile of a Chromium-family browser the user
 * already has: Chrome, Brave, Edge, Chromium, Vivaldi, or any other one they
 * point it at. The choice is made once, at setup, and saved in
 * `<GRAZER_HOME>/config.json`; `grazer browser use` changes it later.
 *
 * Resolution order, first hit wins:
 *   1. `--browser <path>` on `grazer browser start`
 *   2. the `GRAZER_BROWSER` environment variable
 *   3. the saved choice in `config.json`
 *   4. the first known browser found on this machine
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import { ensureGrazerHome, grazerHome } from "./paths.js";

export interface KnownBrowser {
  id: string;
  name: string;
  /** The browser's own page for managing extensions. */
  extensionsPage: string;
  /** Where its executable usually lives, most common first. */
  paths: string[];
}

/** What `config.json` holds. Unknown fields are kept on write. */
export interface GrazerConfig {
  /** Absolute path to the browser executable Grazer runs. */
  browser?: string;
  [key: string]: unknown;
}

function programFiles(): string {
  return process.env.ProgramFiles || "C:\\Program Files";
}

function programFilesX86(): string {
  return process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
}

function localAppData(): string {
  return process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "C:\\", "AppData", "Local");
}

/**
 * Known Chromium-family browsers, in the order auto-detection tries them.
 * Edge comes last: every Windows machine has it, so it is rarely the one a
 * user picked on purpose.
 */
export function knownBrowsers(): KnownBrowser[] {
  return [
    {
      id: "chrome",
      name: "Google Chrome",
      extensionsPage: "chrome://extensions",
      paths: [
        join(programFiles(), "Google", "Chrome", "Application", "chrome.exe"),
        join(programFilesX86(), "Google", "Chrome", "Application", "chrome.exe"),
        join(localAppData(), "Google", "Chrome", "Application", "chrome.exe"),
        "/usr/bin/google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ],
    },
    {
      id: "brave",
      name: "Brave",
      extensionsPage: "brave://extensions",
      paths: [
        join(programFiles(), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(programFilesX86(), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        join(localAppData(), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ],
    },
    {
      id: "vivaldi",
      name: "Vivaldi",
      extensionsPage: "vivaldi://extensions",
      paths: [
        join(localAppData(), "Vivaldi", "Application", "vivaldi.exe"),
        join(programFiles(), "Vivaldi", "Application", "vivaldi.exe"),
      ],
    },
    {
      id: "chromium",
      name: "Chromium",
      extensionsPage: "chrome://extensions",
      paths: [
        join(localAppData(), "Chromium", "Application", "chrome.exe"),
        join(programFiles(), "Chromium", "Application", "chrome.exe"),
        "/usr/bin/chromium",
      ],
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      extensionsPage: "edge://extensions",
      paths: [
        join(programFilesX86(), "Microsoft", "Edge", "Application", "msedge.exe"),
        join(programFiles(), "Microsoft", "Edge", "Application", "msedge.exe"),
      ],
    },
  ];
}

/** Every known browser, with the executable found on this machine or null. */
export function detectBrowsers(): Array<KnownBrowser & { found: string | null }> {
  return knownBrowsers().map((browser) => ({
    ...browser,
    found: browser.paths.find((path) => existsSync(path)) ?? null,
  }));
}

/** The known browser an executable belongs to, by path, or null for any other. */
export function knownBrowserForPath(executable: string): KnownBrowser | null {
  const wanted = executable.toLowerCase();
  return (
    knownBrowsers().find((browser) =>
      browser.paths.some((path) => path.toLowerCase() === wanted),
    ) ?? null
  );
}

export function configPath(): string {
  return join(grazerHome(), "config.json");
}

/** The saved config, or an empty one when it is absent or unreadable. */
export function readConfig(): GrazerConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as GrazerConfig) : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: GrazerConfig): void {
  ensureGrazerHome();
  writeJsonAtomic(configPath(), config);
}

/**
 * Turn what a user typed (`chrome`, `brave`, ... or a path to an .exe) into an
 * executable that exists, or throw a message that says what to do instead.
 */
export function resolveBrowserChoice(choice: string): string {
  const known = knownBrowsers().find((browser) => browser.id === choice.toLowerCase());
  if (known) {
    const found = known.paths.find((path) => existsSync(path));
    if (!found) {
      throw new Error(
        `${known.name} is not installed in the usual places. Pass the full path to its .exe instead.`,
      );
    }
    return found;
  }
  if (!existsSync(choice)) {
    const ids = knownBrowsers().map((browser) => browser.id).join(", ");
    throw new Error(`not a known browser or an existing file: ${choice}\n  known browsers: ${ids}`);
  }
  return choice;
}

/** Save the browser Grazer runs from now on. Returns the executable saved. */
export function useBrowser(choice: string): string {
  const executable = resolveBrowserChoice(choice);
  writeConfig({ ...readConfig(), browser: executable });
  return executable;
}

/** Absolute path to the browser Grazer should run, or a clear error saying how to pick one. */
export function findBrowserExecutable(explicit?: string): string {
  const fromEnv = process.env.GRAZER_BROWSER;
  const candidate = explicit || fromEnv;
  if (candidate) {
    if (!existsSync(candidate)) {
      throw new Error(`browser executable not found: ${candidate}`);
    }
    return candidate;
  }

  const saved = readConfig().browser;
  if (typeof saved === "string" && saved.length > 0) {
    if (!existsSync(saved)) {
      throw new Error(
        `The browser Grazer is set to use is missing: ${saved}\n  Pick another with: grazer browser use <chrome|brave|edge|chromium|vivaldi|path-to-exe>`,
      );
    }
    return saved;
  }

  for (const browser of detectBrowsers()) {
    if (browser.found) return browser.found;
  }
  throw new Error(
    "No Chromium browser found. Install Chrome (or Brave, Edge, Vivaldi), or run: grazer browser use <path-to-exe>",
  );
}
