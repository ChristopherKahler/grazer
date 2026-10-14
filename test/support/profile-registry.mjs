/**
 * A record of every temp browser profile the test suites create.
 *
 * Chrome holds file locks in its profile directory past process exit, so a
 * teardown that kills the browser and immediately removes the directory loses
 * the race often enough to matter — measured on 2026-09-03: 33 orphaned
 * `grazer-snapshot-*` directories survived a session in which every teardown
 * did kill its browser.
 *
 * So teardown stays best-effort and this registry is the backstop: an
 * append-only list `npm run test:clean` can act on later, when the locks are
 * long gone.
 *
 * Append-only on purpose. A crashed run never gets to deregister, and that is
 * exactly the run whose directory needs cleaning; `clean-profiles.mjs` prunes
 * paths that no longer exist.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REGISTRY_PATH = join(tmpdir(), "grazer-profiles.txt");

/**
 * Record a profile directory (or a GRAZER_HOME that contains one).
 *
 * Synchronous and swallowing: registration is bookkeeping, and a suite must
 * never fail because the registry was busy.
 */
export function registerProfile(dir, registryPath = REGISTRY_PATH) {
  if (!dir) return;
  try {
    appendFileSync(registryPath, `${dir}\n`, "utf8");
  } catch {
    // A registry we cannot write just means test:clean has less to go on.
  }
}

/** Every registered path, de-duplicated, newest occurrence order preserved. */
export function readRegistry(registryPath = REGISTRY_PATH) {
  try {
    const lines = readFileSync(registryPath, "utf8").split("\n");
    return [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Replace the registry with `paths` — used after a clean prunes dead entries. */
export async function writeRegistry(paths, registryPath = REGISTRY_PATH) {
  const body = paths.length > 0 ? `${paths.join("\n")}\n` : "";
  await writeFile(registryPath, body, "utf8");
}
