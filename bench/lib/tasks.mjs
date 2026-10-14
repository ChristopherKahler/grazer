/**
 * Task files: `bench/tasks/<id>.md`, frontmatter plus prose.
 *
 * The prompt is stored once and handed to every driver byte-identically —
 * `{{BASE_URL}}` is the only substitution, because the fixture's port is chosen
 * at run time. Any driver-specific instruction belongs in the driver's
 * `--append-system-prompt`, never here, or the benchmark compares prompt
 * engineering rather than drivers.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { TASKS_DIR } from "./paths.mjs";

/** Minimal frontmatter reader: `key: value`, plus `key: |` block scalars. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("task file has no frontmatter");
  const [, head, body] = match;
  const data = {};
  const lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (rawValue.trim() === "|") {
      const block = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (lines[j].trim() !== "" && !/^\s{2,}/.test(lines[j])) break;
        block.push(lines[j].replace(/^ {2}/, ""));
      }
      i = j - 1;
      data[key] = block.join("\n").replace(/\s+$/, "");
      continue;
    }
    const value = rawValue.trim();
    if (value === "true" || value === "false") data[key] = value === "true";
    else if (/^\d+$/.test(value)) data[key] = Number(value);
    else if (value.startsWith("[")) {
      try { data[key] = JSON.parse(value.replace(/'/g, '"')); } catch { data[key] = []; }
    } else data[key] = value.replace(/^["']|["']$/g, "");
  }
  return { data, body };
}

export async function loadTask(id) {
  const path = join(TASKS_DIR, `${id}.md`);
  if (!existsSync(path)) throw new Error(`no task file: ${path}`);
  const { data, body } = parseFrontmatter(await readFile(path, "utf8"));
  if (!data.prompt) throw new Error(`task ${id} has no prompt`);

  const graderPath = join(TASKS_DIR, `${id}.grader.mjs`);
  if (!existsSync(graderPath)) throw new Error(`no grader for ${id}: ${graderPath}`);
  const grader = await import(pathToFileURL(graderPath).href);
  if (typeof grader.grade !== "function" || typeof grader.groundTruth !== "function") {
    throw new Error(`grader ${id} must export groundTruth() and grade()`);
  }

  return {
    id: data.id ?? id,
    prompt: data.prompt,
    requiresLogin: Boolean(data.requiresLogin),
    origins: Array.isArray(data.origins) ? data.origins : [],
    timeoutMs: typeof data.timeoutMs === "number" ? data.timeoutMs : 600_000,
    notes: body.trim(),
    grader,
  };
}

/** Every task file present. T1/T2 simply do not exist yet; nothing pretends they do. */
export async function listTaskIds() {
  if (!existsSync(TASKS_DIR)) return [];
  const entries = await readdir(TASKS_DIR);
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

/** The only substitution: the fixture's run-time origin. */
export function resolvePrompt(task, baseUrl) {
  return task.prompt.replaceAll("{{BASE_URL}}", baseUrl);
}
