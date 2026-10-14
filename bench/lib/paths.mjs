import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** bench/lib -> bench -> repo root. Resolved from this file, never from cwd. */
export const PACKAGE_ROOT = resolve(HERE, "..", "..");
export const BENCH_ROOT = resolve(HERE, "..");
export const TASKS_DIR = resolve(BENCH_ROOT, "tasks");
export const RESULTS_DIR = resolve(BENCH_ROOT, "results");
