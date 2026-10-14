/**
 * Where Grazer keeps its companion state.
 *
 * One home directory holds the running browser's descriptor and the browser
 * profile. `GRAZER_HOME` overrides it, which is what lets the e2e test run
 * against a throwaway directory instead of the real one.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The Grazer home directory. Created on demand by the helpers below. */
export function grazerHome(): string {
  const fromEnv = process.env.GRAZER_HOME;
  if (fromEnv) return resolve(fromEnv);
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return join(localAppData, "Grazer");
  // Windows is the target platform; this keeps development on other platforms working.
  return join(homedir(), ".grazer");
}

/** The descriptor for the currently running companion browser. */
export function browserStatePath(): string {
  return join(grazerHome(), "browser.json");
}

/** The default profile directory. Never the user's own Chrome profile. */
export function defaultProfileDir(): string {
  return join(grazerHome(), "profile");
}

/** Create a directory (and parents) if it is not already there. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create the Grazer home directory if needed and return it. */
export function ensureGrazerHome(): string {
  return ensureDir(grazerHome());
}
