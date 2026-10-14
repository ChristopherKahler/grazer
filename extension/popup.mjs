// Grazer Sync popup.
//
// One screen: pick the sites whose logged-in session should go to the agent,
// press Sync, read what went across. Rows are sites rather than origins
// because cookies are keyed by registrable domain — selecting github.com
// exports every github.com origin the user has open, so the cookies and the
// per-origin web storage both arrive complete.

import { siteOf, originOf } from './lib/site.mjs';

const STORAGE_KEY = 'grazer-sync-popup';

const el = {
  host: document.getElementById('host'),
  sites: document.getElementById('sites'),
  add: document.getElementById('add'),
  origin: document.getElementById('origin'),
  go: document.getElementById('go'),
  status: document.getElementById('status'),
};

/** site -> { origins: Set<string>, open: boolean } */
const sites = new Map();
const selected = new Set();
/** site -> { tone: 'ok' | 'failed', note: string } */
const results = new Map();

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function addOrigin(origin, { open }) {
  const site = siteOf(origin);
  const entry = sites.get(site) ?? { origins: new Set(), open: false };
  entry.origins.add(origin);
  entry.open = entry.open || open;
  sites.set(site, entry);
  return site;
}

/** Accept "example.com", "example.com/path" or a full origin. */
function parseOrigin(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const origin = originOf(withScheme);
    return new URL(origin).hostname.includes('.') || new URL(origin).hostname === 'localhost'
      ? origin
      : null;
  } catch {
    return null;
  }
}

async function loadRemembered() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return stored[STORAGE_KEY] ?? { selected: [], extra: [] };
  } catch {
    return { selected: [], extra: [] };
  }
}

async function remember() {
  const extra = [...sites.entries()]
    .filter(([, entry]) => !entry.open)
    .flatMap(([, entry]) => [...entry.origins]);
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: { selected: [...selected], extra } });
  } catch {
    // A popup that cannot remember is still a popup that works.
  }
}

function render() {
  el.sites.replaceChildren();

  if (sites.size === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No sites open. Add one below.';
    el.sites.append(empty);
  }

  for (const [site, entry] of [...sites.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site';
    row.setAttribute('role', 'switch');
    row.setAttribute('aria-checked', String(selected.has(site)));

    const rail = document.createElement('i');
    rail.setAttribute('aria-hidden', 'true');

    const body = document.createElement('span');
    body.className = 'site-body';
    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = site;
    body.append(name);

    const result = results.get(site);
    const origins = [...entry.origins];
    const note = result?.note
      ?? (origins.length > 1 ? origins.map((o) => o.replace(/^https?:\/\//, '')).join('  ') : '');
    if (note) {
      const sub = document.createElement('span');
      sub.className = 'site-note';
      sub.textContent = note;
      body.append(sub);
    }

    if (result) row.dataset.result = result.tone;
    row.append(rail, body);
    row.addEventListener('click', () => {
      if (selected.has(site)) selected.delete(site);
      else selected.add(site);
      results.delete(site);
      remember();
      render();
    });
    el.sites.append(row);
  }

  const count = selected.size;
  el.go.disabled = count === 0;
  el.go.textContent = count === 0 ? 'Select a site' : `Sync ${plural(count, 'site')}`;
}

function setStatus(text, tone = 'idle') {
  el.status.textContent = text;
  el.status.dataset.tone = tone;
}

async function checkHost() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'ping-host' });
    if (reply?.ok) {
      el.host.dataset.state = 'ready';
      el.host.textContent = 'companion ready';
      return;
    }
    el.host.dataset.state = 'missing';
    el.host.textContent = 'not registered';
    setStatus('Grazer is not listening yet.\nRun: grazer sync register', 'failed');
  } catch {
    el.host.dataset.state = 'missing';
    el.host.textContent = 'not registered';
  }
}

async function sync() {
  const chosen = [...selected];
  const origins = chosen.flatMap((site) => [...(sites.get(site)?.origins ?? [])]);
  if (origins.length === 0) return;

  results.clear();
  el.go.dataset.busy = 'true';
  el.go.disabled = true;
  el.go.textContent = 'Syncing…';
  setStatus(`Reading ${plural(origins.length, 'origin')}…`);

  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'sync', origins });
  } catch (err) {
    reply = { ok: false, error: String(err?.message || err) };
  }

  delete el.go.dataset.busy;

  if (!reply?.ok) {
    const message = String(reply?.error ?? 'the export did not finish');
    setStatus(
      /not found|Specified native messaging host|Access to the specified native messaging host/i.test(message)
        ? 'Grazer is not listening yet.\nRun: grazer sync register'
        : `Sync failed. ${message}`,
      'failed',
    );
    render();
    return;
  }

  // Fold the per-origin counts back onto the site rows the user chose.
  const totals = new Map();
  for (const entry of reply.summary ?? []) {
    const site = siteOf(entry.origin);
    const total = totals.get(site) ?? { cookies: 0, localStorage: 0, indexedDB: 0, errors: 0 };
    total.cookies += entry.cookies;
    total.localStorage += entry.localStorage;
    total.indexedDB += entry.indexedDB;
    total.errors += entry.errors;
    totals.set(site, total);
  }
  for (const [site, total] of totals) {
    results.set(site, {
      tone: total.errors > 0 ? 'failed' : 'ok',
      note: [
        plural(total.cookies, 'cookie'),
        plural(total.localStorage, 'key'),
        plural(total.indexedDB, 'record'),
        total.errors > 0 ? plural(total.errors, 'problem') : '',
      ].filter(Boolean).join(' · '),
    });
  }

  // The bundle always lands under the Grazer home, so the last two path
  // segments say where it is without two wrapped lines of C:\Users\... in a
  // 340px popup. The full path is in the native host log.
  const stored = reply.reply;
  const where = String(stored?.path ?? '').split(/[\\/]/).slice(-2).join('\\');
  setStatus(
    stored?.type === 'stored'
      ? `Sent to Grazer · ${plural(stored.origins, 'origin')}\n${where}`
      : `The companion answered: ${stored?.message ?? JSON.stringify(stored)}`,
    stored?.type === 'stored' ? 'ok' : 'failed',
  );
  render();
}

async function start() {
  const remembered = await loadRemembered();

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    tabs = [];
  }
  for (const tab of tabs) {
    if (!tab.url || !/^https?:/i.test(tab.url)) continue;
    try {
      addOrigin(originOf(tab.url), { open: true });
    } catch {
      // about:blank and friends have no origin to export.
    }
  }
  for (const origin of remembered.extra ?? []) {
    try {
      addOrigin(origin, { open: false });
    } catch {
      // A remembered value that no longer parses is simply dropped.
    }
  }
  for (const site of remembered.selected ?? []) {
    if (sites.has(site)) selected.add(site);
  }

  render();
  checkHost();
}

el.add.addEventListener('submit', (event) => {
  event.preventDefault();
  const origin = parseOrigin(el.origin.value);
  if (!origin) {
    setStatus(`That is not a site address: ${el.origin.value.trim()}`, 'failed');
    return;
  }
  const site = addOrigin(origin, { open: false });
  selected.add(site);
  el.origin.value = '';
  setStatus(`Added ${site}.`);
  remember();
  render();
});

el.go.addEventListener('click', sync);

start();
