/**
 * Atomic JSON writes for the files Grazer's processes share.
 *
 * `browser.json` and `spaces.json` are both read by concurrent `grazer nodejs`
 * processes, so a half-written file is worse than a missing one: write to a
 * pid-suffixed temp file and rename over the target, which is atomic on both
 * NTFS and POSIX.
 *
 * Windows returns EPERM/EBUSY from `rename` while an antivirus scanner or the
 * search indexer holds the destination open — a transient condition, not a
 * failure — so the rename is retried briefly before giving up.
 */

import { renameSync, rmSync, writeFileSync } from "node:fs";

const RETRIES = 10;
const RETRY_DELAY_MS = 50;
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Busy-wait. Callers here are sync (the CDP send gate reads the store inline). */
function pause(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Deliberate: this path runs only on a contended rename, at most ~500ms.
  }
}

/** Write `value` as pretty JSON, atomically. Throws if every retry is exhausted. */
export function writeJsonAtomic(target: string, value: unknown): void {
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT.has(code)) {
        rmSync(tmp, { force: true });
        throw error;
      }
      lastError = error;
      pause(RETRY_DELAY_MS);
    }
  }
  rmSync(tmp, { force: true });
  throw lastError;
}
