/**
 * `grazer space` — the human side of task spaces.
 *
 * Until there is a tray UI this is how a person takes the wheel from an agent,
 * hands it back, ends a task, or clears spaces out. It writes the same
 * `spaces.json` the runtime gates on, so a `takeover` here stops the agent's
 * very next CDP send in whatever heredoc is running.
 *
 * It connects to the browser only when it must dispose a context; `list`,
 * `takeover`, `handoff` and `end` are pure store edits and work even against a
 * browser that has since died.
 */

import { connect, type CdpConnection } from "../cdp/connection.js";
import { disposeSpace, listSpaces, pageTargetsByContext } from "../spaces/manager.js";
import { findRow, readStore, writeStore, type SpaceRow } from "../spaces/store.js";
import { readBrowserState } from "./browser.js";
import { grazerHome } from "./paths.js";

export interface SpacesCliResult {
  /** Process exit code: 0 ok, 1 nothing to act on, 2 usage, 3 environment. */
  code: number;
  stdout?: string;
  stderr?: string;
}

const USAGE = `Usage:
  grazer space list
  grazer space takeover <id|name>
  grazer space handoff <id|name>
  grazer space end <id|name>
  grazer space delete <id|name>
  grazer space delete --all
`;

/** Open a connection to the running browser, or null when there is none. */
async function connectToBrowser(): Promise<CdpConnection | null> {
  const state = await readBrowserState();
  if (!state) return null;
  try {
    return await connect({ port: state.port, openTimeoutMs: 5000 });
  } catch {
    return null;
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Render the space table. Column widths follow the content, not a guess. */
function renderTable(
  rows: Array<{ row: SpaceRow; tabs: number }>,
): string {
  const header = ["ID", "NAME", "OWNERSHIP", "STATE", "TABS"];
  const body = rows.map(({ row, tabs }) => [
    String(row.id),
    row.name,
    row.ownership,
    row.state,
    String(tabs),
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => line[index].length), 0),
  );
  const lines = [header, ...body].map((line) =>
    line.map((cell, index) => pad(cell, widths[index])).join("  ").trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

async function listCommand(home: string): Promise<SpacesCliResult> {
  const store = readStore(home);
  if (store.spaces.length === 0) {
    return { code: 0, stdout: "No task spaces.\n" };
  }
  const connection = await connectToBrowser();
  try {
    let tabCounts = new Map<string, number>();
    if (connection) {
      const { pruned } = await listSpaces(connection, store);
      if (pruned) writeStore(home, store);
      const grouped = await pageTargetsByContext(connection);
      tabCounts = new Map(
        [...grouped.entries()].map(([contextId, targets]) => [
          contextId,
          targets.length,
        ]),
      );
    }
    if (store.spaces.length === 0) {
      return { code: 0, stdout: "No task spaces.\n" };
    }
    return {
      code: 0,
      stdout: renderTable(
        store.spaces.map((row) => ({
          row,
          tabs: tabCounts.get(row.browserContextId) ?? 0,
        })),
      ),
    };
  } finally {
    await connection?.close().catch(() => {});
  }
}

/** takeover / handoff / end: store-only ownership edits. */
function ownershipCommand(
  home: string,
  target: string,
  apply: (row: SpaceRow) => void,
  describe: (row: SpaceRow) => string,
): SpacesCliResult {
  const store = readStore(home);
  const row = findRow(store, target);
  if (!row) {
    return { code: 1, stderr: `Task space not found: ${target}\n` };
  }
  apply(row);
  writeStore(home, store);
  return { code: 0, stdout: `${describe(row)}\n` };
}

async function deleteCommand(
  home: string,
  target: string,
): Promise<SpacesCliResult> {
  const store = readStore(home);
  const all = target === "--all";
  const rows = all ? [...store.spaces] : [findRow(store, target)].filter(Boolean);
  if (rows.length === 0) {
    return all
      ? { code: 0, stdout: "No task spaces.\n" }
      : { code: 1, stderr: `Task space not found: ${target}\n` };
  }

  const connection = await connectToBrowser();
  if (!connection) {
    // Without a browser the contexts are already gone with it; drop the rows so
    // the store stops advertising spaces that cannot be used.
    for (const row of rows) {
      const index = store.spaces.indexOf(row!);
      if (index >= 0) store.spaces.splice(index, 1);
    }
    writeStore(home, store);
    return {
      code: 0,
      stdout: `Removed ${rows.length} task space${rows.length === 1 ? "" : "s"} (browser not running).\n`,
    };
  }

  try {
    let deleted = 0;
    for (const row of rows) {
      if (await disposeSpace(connection, store, row!.id)) deleted++;
    }
    writeStore(home, store);
    return {
      code: 0,
      stdout: `Deleted ${deleted} task space${deleted === 1 ? "" : "s"}.\n`,
    };
  } finally {
    await connection.close().catch(() => {});
  }
}

/** Run a `grazer space` subcommand. argv excludes the leading "space". */
export async function runSpacesCli(argv: string[]): Promise<SpacesCliResult> {
  const home = grazerHome();
  const [command, target] = argv;

  if (!command || command === "--help" || command === "-h") {
    return { code: command ? 0 : 2, stdout: command ? USAGE : undefined, stderr: command ? undefined : USAGE };
  }

  if (command === "list") {
    if (argv.length > 1) return { code: 2, stderr: `unknown option: ${argv[1]}\n\n${USAGE}` };
    return listCommand(home);
  }

  if (!target) {
    return { code: 2, stderr: `${command} needs a task space id or name\n\n${USAGE}` };
  }
  if (argv.length > 2) {
    return { code: 2, stderr: `unknown option: ${argv[2]}\n\n${USAGE}` };
  }

  switch (command) {
    case "takeover":
      // The agent's next page-level send fails USER_IN_CONTROL until it claims.
      return ownershipCommand(
        home,
        target,
        (row) => {
          row.ownership = "user";
        },
        (row) => `You now control task space ${row.id} (${row.name}).`,
      );
    case "handoff":
      return ownershipCommand(
        home,
        target,
        (row) => {
          row.ownership = "agent";
          if (row.state === "ended") row.state = "active";
        },
        (row) => `Task space ${row.id} (${row.name}) handed back to the agent.`,
      );
    case "end":
      return ownershipCommand(
        home,
        target,
        (row) => {
          row.ownership = "user";
          row.state = "ended";
        },
        (row) => `Task space ${row.id} (${row.name}) ended.`,
      );
    case "delete":
      return deleteCommand(home, target);
    default:
      return { code: 2, stderr: `unknown space command: ${command}\n\n${USAGE}` };
  }
}
