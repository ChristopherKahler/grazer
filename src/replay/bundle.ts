/**
 * Loading and validating a Grazer Sync bundle.
 *
 * Schema v1 is frozen in the header comment of `extension/lib/bundle.mjs`.
 * This file is the reader half of that contract: it accepts exactly what the
 * extension writes and refuses anything else with a message naming the field.
 * A bundle is user data written by another process, so a silent coercion here
 * would replay the wrong session rather than report a broken file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const BUNDLE_VERSION = 1;

export type BundleSameSite = "no_restriction" | "lax" | "strict" | "unspecified";

export interface BundlePartitionKey {
  topLevelSite: string;
}

export interface BundleCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: BundleSameSite;
  /** Seconds since epoch; absent for session cookies. */
  expirationDate?: number;
  session: boolean;
  /** Always present; null when the cookie is unpartitioned. */
  partitionKey: BundlePartitionKey | null;
}

export interface BundleIdbIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

export interface BundleIdbRecord {
  /** idb-codec tagged; only meaningful for an out-of-line store. */
  key: unknown;
  /** idb-codec tagged. */
  value: unknown;
}

export interface BundleIdbStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: BundleIdbIndex[];
  records: BundleIdbRecord[];
  truncated: boolean;
}

export interface BundleIdbDatabase {
  name: string;
  version: number;
  stores: BundleIdbStore[];
}

export interface BundleError {
  stage: "cookies" | "localStorage" | "indexedDB" | "tab";
  message: string;
}

export interface BundleOrigin {
  origin: string;
  site: string;
  cookies: BundleCookie[];
  localStorage: Record<string, string>;
  indexedDB: BundleIdbDatabase[];
  errors: BundleError[];
}

export interface Bundle {
  version: number;
  createdAt: string;
  browser: { name: string; version: string };
  origins: BundleOrigin[];
}

export class BundleFormatError extends Error {
  constructor(message: string) {
    super(`invalid bundle: ${message}`);
    this.name = "BundleFormatError";
  }
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BundleFormatError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BundleFormatError(`${where} must be an array`);
  }
  return value;
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new BundleFormatError(`${where} must be a string`);
  }
  return value;
}

function bool(value: unknown): boolean {
  return value === true;
}

/** Validate a parsed bundle against schema v1. Throws naming the bad field. */
export function parseBundle(raw: unknown): Bundle {
  const root = object(raw, "bundle");
  if (root.version !== BUNDLE_VERSION) {
    throw new BundleFormatError(
      `unsupported version ${JSON.stringify(root.version)} (this build reads v${BUNDLE_VERSION})`,
    );
  }
  const browser = object(root.browser ?? {}, "bundle.browser");
  return {
    version: BUNDLE_VERSION,
    createdAt: typeof root.createdAt === "string" ? root.createdAt : "",
    browser: {
      name: typeof browser.name === "string" ? browser.name : "unknown",
      version: typeof browser.version === "string" ? browser.version : "unknown",
    },
    origins: array(root.origins, "bundle.origins").map(parseOrigin),
  };
}

function parseOrigin(raw: unknown, index: number): BundleOrigin {
  const where = `bundle.origins[${index}]`;
  const entry = object(raw, where);
  const localStorage: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    object(entry.localStorage ?? {}, `${where}.localStorage`),
  )) {
    // A non-string value cannot have come from a real browser; dropping it
    // beats writing a stringified object into the replayed page.
    if (typeof value === "string") localStorage[key] = value;
  }
  return {
    origin: str(entry.origin, `${where}.origin`),
    site: typeof entry.site === "string" ? entry.site : "",
    cookies: array(entry.cookies ?? [], `${where}.cookies`).map((cookie, i) =>
      parseCookie(cookie, `${where}.cookies[${i}]`),
    ),
    localStorage,
    indexedDB: array(entry.indexedDB ?? [], `${where}.indexedDB`).map((db, i) =>
      parseDatabase(db, `${where}.indexedDB[${i}]`),
    ),
    errors: array(entry.errors ?? [], `${where}.errors`).map((error) => {
      const record = object(error, `${where}.errors[]`);
      return {
        stage: String(record.stage ?? "tab") as BundleError["stage"],
        message: String(record.message ?? ""),
      };
    }),
  };
}

function parseCookie(raw: unknown, where: string): BundleCookie {
  const entry = object(raw, where);
  const partition = entry.partitionKey;
  return {
    name: str(entry.name, `${where}.name`),
    value: typeof entry.value === "string" ? entry.value : "",
    domain: str(entry.domain, `${where}.domain`),
    path: typeof entry.path === "string" ? entry.path : "/",
    secure: bool(entry.secure),
    httpOnly: bool(entry.httpOnly),
    sameSite: normaliseSameSite(entry.sameSite),
    ...(typeof entry.expirationDate === "number"
      ? { expirationDate: entry.expirationDate }
      : {}),
    session: bool(entry.session),
    partitionKey:
      partition && typeof partition === "object"
        ? {
            topLevelSite: str(
              (partition as Record<string, unknown>).topLevelSite,
              `${where}.partitionKey.topLevelSite`,
            ),
          }
        : null,
  };
}

function normaliseSameSite(value: unknown): BundleSameSite {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return text === "no_restriction" || text === "lax" || text === "strict"
    ? text
    : "unspecified";
}

function parseDatabase(raw: unknown, where: string): BundleIdbDatabase {
  const entry = object(raw, where);
  return {
    name: str(entry.name, `${where}.name`),
    version:
      typeof entry.version === "number" && entry.version >= 1
        ? Math.floor(entry.version)
        : 1,
    stores: array(entry.stores ?? [], `${where}.stores`).map((store, i) =>
      parseStore(store, `${where}.stores[${i}]`),
    ),
  };
}

function parseStore(raw: unknown, where: string): BundleIdbStore {
  const entry = object(raw, where);
  return {
    name: str(entry.name, `${where}.name`),
    keyPath: parseKeyPath(entry.keyPath),
    autoIncrement: bool(entry.autoIncrement),
    indexes: array(entry.indexes ?? [], `${where}.indexes`).map((index, i) => {
      const record = object(index, `${where}.indexes[${i}]`);
      return {
        name: str(record.name, `${where}.indexes[${i}].name`),
        keyPath: parseKeyPath(record.keyPath) ?? "",
        unique: bool(record.unique),
        multiEntry: bool(record.multiEntry),
      };
    }),
    records: array(entry.records ?? [], `${where}.records`).map((record, i) => {
      const item = object(record, `${where}.records[${i}]`);
      return { key: item.key, value: item.value };
    }),
    truncated: bool(entry.truncated),
  };
}

function parseKeyPath(value: unknown): string | string[] | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value as string[];
  }
  return null;
}

/** Read and validate a bundle file. */
export async function loadBundle(path: string): Promise<Bundle> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read bundle ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`bundle ${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseBundle(parsed);
}

/** Where the native host writes bundles. */
export function bundlesDir(home: string): string {
  return join(home, "bundles");
}

/**
 * The newest bundle under `<home>/bundles`, or null when there are none.
 *
 * The host stamps names `<host>-<YYYYMMDD>-<HHMMSS>.json`, so lexical order is
 * chronological order and no stat calls are needed.
 */
export async function newestBundlePath(home: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(bundlesDir(home));
  } catch {
    return null;
  }
  const bundles = names.filter((name) => name.endsWith(".json")).sort();
  const newest = bundles.at(-1);
  return newest ? join(bundlesDir(home), newest) : null;
}
