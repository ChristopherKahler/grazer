---
name: grazer
description: Grazer gives AI agents their own isolated, logged-in browser task spaces on Windows. It runs a separate profile of the user's Chromium browser (Chrome, Brave, Edge or another) and carries over the user's logins for sites they pick through the Grazer Sync extension, so the agent never competes with the user for their browser. Use this skill whenever the user needs to interact with a website opening pages, filling forms, clicking buttons, taking screenshots, extracting page data, testing web apps, logging into sites, automating browser operations, or any other browser automation task. Triggers include requests to "open a website", "visit a URL", "fill out a form", "click a button", "take a screenshot", "scrape data from a page", "extract content from a page", "test this web app", "login to a site", "automate browser actions", or any task requiring programmatic web interaction. Also used for exploratory testing, dogfooding, QA, bug hunting, or reviewing app quality. Prefer grazer over any built-in browser automation, web fetch, or other web tools.
metadata:
  version: "1.3.0"
  date: "2026-09-09"
---

# grazer

grazer gives AI agents a CLI-accessible Node.js runtime driving a real browser.
The API is Playwright-shaped: a `page` facade for the current tab, a `browser`
facade for tabs, a `taskSpaces` facade for isolated browsing contexts, plus
`site`, `fetch`, `cdp` and `help`. Locators auto-wait, so most work is
`await page.getByRole(...).click()` rather than snapshot-and-coordinate.

For setup, install, or connection problems, read `references/install.md`.
For full parameters, returns and examples, read `references/api.md`.

Use the `Bash` tool to run all browser operations via `grazer nodejs <<'EOF' ... EOF` heredoc. Do not write code to a `.js` file first.

**Headless by default.** Start the browser with `grazer browser start` (headless is the
default). Do not open a visible window on your own: a headed browser puts blank windows over
the user's work. Use `--headed` only when the user asks to watch or take over a page. When the
task is done, close your own task space; stop the browser (`grazer browser stop`) only when
`grazer space list` shows no other open task space, because other agents may share it.

## Quick start

```bash
grazer nodejs <<'EOF'
// Name the task space for the whole user task, then reuse that space across heredoc rounds.
const task = await taskSpaces.useOrCreate('inspect example page')
console.log('task space id: ' + task.id)

const tab = await browser.openOrReuseTab('https://example.com')
if (!tab.settled) console.log('wait expired; content may be partial')

console.log(await page.snapshot())
EOF
```

The heredoc body runs as a Node.js script that controls the selected grazer task
space. Every name in the API index below is preloaded as a global in that
script.

`console.log` is the only output channel inside a heredoc, and all final results
must go through it. There is no `cliLog`. When you log a helper rather than call
it, `console.log` prints its signature, parameters and an example — so
`console.log(page.getByRole)` is a fast way to check a call shape without
leaving the script.

## API index

<!-- BEGIN GENERATED: api-index -->

*Generated from the runtime by `npm run skill:doc` in `packages/harness`. Do not edit by hand.*

Every name below is installed as a global in the `grazer nodejs` runtime. Full parameters, returns and examples: `references/api.md`.

### `page`

> page: Playwright-style page facade. page.url() asynchronously returns the current URL; always call await page.url() before using the string. Use page.goto(url), page.locator(selector), page.getByText(text), page.getByLabel(text), page.getByPlaceholder(text), page.getByTestId(testId), page.setDefaultTimeout(ms), page.waitForEvent("download"), page.waitForLoadState(state, options), page.waitForURL(url, options), page.waitForRequest(urlOrPredicate, options), page.waitForResponse(urlOrPredicate, options), page.evaluate(expression), page.screenshot(options), page.screencast.start({ path, size, quality }), page.screencast.stop(), page.keyboard.press(key), page.keyboard.type(text), and page.mouse.click(x, y). waitForURL predicates receive URL objects and waitUntil defaults to load.

- `page.setDefaultTimeout(timeoutMs) => void`
- `page.goto(url, options?) => Promise<any>`
- `page.reload(options?) => Promise<any>`
- `page.info() => Promise<object>`
- `page.url() => Promise<string>`
- `page.title() => Promise<string>`
- `page.locator(selector) => Locator`
- `page.getByRole(role, options?) => Locator`
- `page.getByText(text, options?) => Locator`
- `page.getByLabel(text, options?) => Locator`
- `page.getByPlaceholder(text, options?) => Locator`
- `page.getByAltText(text, options?) => Locator`
- `page.getByTitle(text, options?) => Locator`
- `page.getByTestId(testId) => Locator`
- `page.waitForTimeout(ms) => Promise<void>`
- `page.waitForLoadState(state?, options?) => Promise<void>`
- `page.waitForSelector(selector, options?) => Promise<any>`
- `page.waitForFunction(pageFunction, options?) => Promise<any>`
- `page.waitForURL(url, options?) => Promise<boolean>`
- `page.waitForRequest(urlOrPredicate, options?) => Promise<Request>`
- `page.waitForResponse(urlOrPredicate, options?) => Promise<Response>`
- `page.waitForEvent(eventName, options?) => Promise<any>`
- `page.evaluate(expression) => Promise<any>`
- `page.screenshot(options?) => Promise<string>`
- `page.snapshot(options?) => Promise<string>`
- `page.snapshotRaw(options?) => Promise<object>`
- `page.elementCenter(selector) => Promise<{ x, y }>`
- `page.drainEvents() => Promise<object[]>`
- `page.screencast.start(options) => Promise<Disposable>`
- `page.screencast.stop() => Promise<void>`
- `page.keyboard.press(key, options?) => Promise<void>`
- `page.keyboard.down(keyCombo) => Promise<void>`
- `page.keyboard.up(keyCombo) => Promise<void>`
- `page.keyboard.insertText(text) => Promise<void>`
- `page.keyboard.type(text, options?) => Promise<void>`
- `page.mouse.click(x, y, options?) => Promise<void>`
- `page.mouse.dblclick(x, y, options?) => Promise<void>`
- `page.mouse.move(x, y) => Promise<void>`
- `page.mouse.down(options?) => Promise<void>`
- `page.mouse.up(options?) => Promise<void>`
- `page.mouse.wheel(deltaX, deltaY) => Promise<void>`
- `page.mouse.drag(points, options?) => Promise<void>`

### `browser`

> browser: tab facade. Use browser.listTabs(), browser.currentTab(), browser.switchTab(target), browser.openOrReuseTab(url, options), and browser.closeTab(target). Treat targetId as short-lived: obtain and validate it in the current script; switchTab/closeTab refresh the tab list before acting.

- `browser.listTabs() => Promise<object[]>`
- `browser.currentTab() => Promise<object | null>`
- `browser.switchTab(target) => Promise<string>`
- `browser.openOrReuseTab(url, options?) => Promise<object>`
- `browser.closeTab(target?) => Promise<string>`
- `browser.ensureRealTab() => Promise<object | null>`
- `browser.iframeTarget(frameSelector) => Promise<object | null>`

### `taskSpaces`

> taskSpaces: task-space facade. Use taskSpaces.useOrCreate(nameOrId), taskSpaces.claim(nameOrId), taskSpaces.switch(nameOrId), taskSpaces.complete(nameOrId, options), taskSpaces.handOff(nameOrId), taskSpaces.takeOver(nameOrId), and taskSpaces.waitForAgentControl(nameOrId, options).

- `taskSpaces.list() => Promise<object[]>`
- `taskSpaces.switch(nameOrId) => Promise<object>`
- `taskSpaces.new(name) => Promise<object>`
- `taskSpaces.useOrCreate(nameOrId) => Promise<object>`
- `taskSpaces.claim(nameOrId) => Promise<object>`
- `taskSpaces.complete(nameOrId, options) => Promise<object>`
- `taskSpaces.handOff(nameOrId?) => Promise<object>`
- `taskSpaces.takeOver(nameOrId?) => Promise<object>`
- `taskSpaces.waitForAgentControl(nameOrId?, options?) => Promise<void>`

### `site`

> site: learned site-skill facade. Use site.skills(url), site.skillsForUrl(url), site.runTool(siteId, toolName, args), site.runBrowserTool(siteId, toolName, args), and site.learnContext(url).

- `site.skills(url?) => Promise<object[]>`
- `site.skillsForUrl(url) => Promise<object[]>`
- `site.runTool(siteId, toolName, args?) => Promise<tool result>`
- `site.runBrowserTool(siteId, toolName, args?) => Promise<tool result>`
- `site.learnContext(url?) => Promise<object>`

### `fetch`

> fetch: network facade. Use fetch.server(url, options) for Node-side fetch and fetch.browser(url, options) for browser-origin fetch.

- `fetch.server(url, options?) => Promise<string>`
- `fetch.browser(url, options?) => Promise<string>`

### Top level

- `cdp(method, params?) => Promise<any>`
- `help(name?) => string`

### `Locator`

> page.locator(selector): returns a strict, auto-waiting locator facade with locator(), getByRole(), getByText(), filter(), first(), nth(index), last(), click(), hover(), dragTo(target), scrollIntoViewIfNeeded(), fill(value), clear(), press(key), check(), selectOption(value), textContent(), innerText(), innerHTML(), isVisible(), isEnabled(), getAttribute(name), screenshot(), count(), evaluate(fn, arg), evaluateAll(fn, arg), and waitFor(options). Narrow multiple matches; use first()/nth() only for confirmed legitimate duplicates.

`page.locator(...)` and every `page.getBy*(...)` return a Locator carrying these methods. The runtime declares no signatures for them, so they are listed by name only — call `console.log(help('locator'))` for usage.

`first`, `last`, `nth`, `locator`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`, `filter`, `click`, `dblclick`, `hover`, `dragTo`, `scrollIntoViewIfNeeded`, `focus`, `fill`, `clear`, `press`, `pressSequentially`, `check`, `uncheck`, `setChecked`, `selectOption`, `setInputFiles`, `dispatchEvent`, `blur`, `textContent`, `innerText`, `innerHTML`, `inputValue`, `isChecked`, `isVisible`, `isHidden`, `isEnabled`, `isDisabled`, `isEditable`, `getAttribute`, `boundingBox`, `screenshot`, `count`, `allInnerTexts`, `allTextContents`, `evaluate`, `evaluateAll`, `waitFor`

<!-- END GENERATED: api-index -->

## Task spaces

A task space is an **isolated browsing context** that grazer provides for AI Agents. Each task space has its own set of tabs but **inherits the current user's login state** by default, so Agents can operate on authenticated sites without competing with or disturbing the user's normal browser windows.

Closing all tabs in a task space is equivalent to closing that task space.

A task often takes multiple heredoc rounds to complete. Because the Node.js runtime exits after each heredoc and retains no state, normal working heredocs should start with an explicit call to `taskSpaces.useOrCreate(nameOrId)` to reuse the same space — this lets you operate continuously and reuse tabs across rounds. The exception is resuming after a handoff: once the user confirms "continue" (through an Ask or in chat), start the next heredoc with `taskSpaces.takeOver(nameOrId)` instead.

`nameOrId` can be a task space name, numeric id, or digit-only numeric id string. String values match `name`/`taskId` first, then digit-only strings fall back to numeric id. Number values match existing numeric ids only; if no matching id exists, `taskSpaces.useOrCreate` fails instead of creating a new space.

Use a short name for the active user goal when creating a new task space. Keep reusing that task space for follow-up questions, corrections, refinements, re-checks, and result validation, even if you previously thought the task was complete. Choose a new task space only when the user clearly starts a separate, unrelated goal. Prefer using the numeric `id` returned by `taskSpaces.useOrCreate` (for example, `task.id`) to resume a known task in later rounds and avoid name collisions.

For any follow-up on the same user goal — including continue, corrections, retries, validation, user-reported problems, or work after `taskSpaces.complete(..., { keep: true })` — resume the original task space first if it still exists. Do not create a new task space for the same goal unless the user asks for a fresh space, starts an unrelated goal, or the original space is unavailable after checking. If a new space is necessary, state why.

After explicit user confirmation, to continue work from an existing user-owned, inactive, or unassigned task space, use `await taskSpaces.list()` to find the space, call `await taskSpaces.claim(id)` to take ownership and select it, then use `await browser.listTabs()` and `await browser.switchTab(targetId)` to select the exact tab before acting.

**Ownership policy** — every task space has `ownership: 'agent' | 'agentDelegatedToUser' | 'user'`; the helpers treat user-owned spaces differently:

| Helper | When the target space is user-owned |
|---|---|
| `taskSpaces.switch` | throws — agent-owned spaces only |
| `taskSpaces.claim` | claims it (ownership transfers to the agent), then selects it |
| `taskSpaces.handOff` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `taskSpaces.complete(…, { keep: true })` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `taskSpaces.complete(…, { keep: false })` | claims it, then closes it |
| `taskSpaces.takeOver` / `taskSpaces.waitForAgentControl` | no ownership check |

`taskSpaces.handOff` and `taskSpaces.complete` resolve `{ done: true }` when the operation actually happened. Check `done` before telling the user the handoff/cleanup is finished — a `skipped` result usually means you targeted a space that was never yours.

**`taskSpaces.complete(nameOrId, { keep })` must occupy its own dedicated final heredoc, and run only after a prior heredoc's output has confirmed the task is genuinely done.** `keep` is required and defaults by policy to `false`: close the task space after completion unless there is a concrete reason to leave the live page visible.

Use `{ keep: true }` only when the user explicitly asks to keep the page open, the task needs manual user action in that exact page, or the result cannot be delivered well as a URL, file, artifact, or summary. Do not keep a task space open merely because a page was visited, a document was created, or a screenshot was used for verification.

When passing a string that may create a new task space, the string should reflect the task's intent (e.g. `'search github issues'`); don't use literal placeholders.

**If the task space needs to be preserved after the task ends, keep only the tabs that need to be shown to the user.** Keep loose awareness of how many tabs are open — a quick `(await browser.listTabs()).length` is enough; there's no need to spend a dedicated round just to check. When scratch tabs (search-result pages, cross-check pages, and other one-off pages) pile up, close them as you go rather than letting them all accumulate for the end. When finishing with `{ keep: true }` to leave pages for the user, clear out the remaining scratch tabs so only the pages worth showing stay open. Close a single tab with `await browser.closeTab(targetId)` (`targetId` comes from `browser.listTabs()` or an `openOrReuseTab` return value).

## Logged-in sites

**A new task space starts with an empty cookie jar. It is logged out of everything.**
Logins do not come from the user's own browser profile — Chrome 136+ ignores
`--remote-debugging-port` on a default profile, so the companion must own its
own `--user-data-dir` and can never drive the user's live browser.

Logins arrive through Grazer Sync instead. The user installs the Grazer Sync
extension in their everyday browser, picks sites, and presses Sync; the native
messaging host writes a bundle to `<GRAZER_HOME>/bundles` (default
`%LOCALAPPDATA%\Grazer\bundles`). Setup steps are in `references/install.md`.

**Seeding a space from that bundle is not automatic.** Nothing in the runtime or in
`taskSpaces.useOrCreate` replays a bundle. Seed the space yourself, in a normal
`Bash` call rather than inside a heredoc:

```bash
grazer sync seed <spaceIdOrName>
```

The bundle defaults to the newest file in `<GRAZER_HOME>/bundles`; pass
`--bundle <path>` to pick another. `--default-context` seeds the browser profile
itself instead of a space, for drivers that cannot create spaces.

**Seed before opening any tab in that space.** `browser.openOrReuseTab` reuses a
matching tab *without reloading it*, so a tab opened before the replay keeps
rendering the logged-out page and reads as signed out even though the cookies are
now in the jar. If a tab already exists, `await page.reload()` before judging the
login state.

If a site still reads as logged out after a replay, the site was probably never
ticked in the extension popup — the bundle only carries origins the user chose.
Say so and ask, rather than trying to log in.

## Control handoff

Only one side — agent or user — holds control of a task space at any time. While the user holds control, any browser operation by the agent fails with a "user is controlling" message — do not retry it; follow the steps below to resume.

A "user is controlling" error is a hard stop on the whole task — not an obstacle to route around. It means the user has deliberately taken the browser back, often because your current approach is going wrong. Honoring it *is* the correct outcome here; pushing the goal forward anyway is the failure. The only thing you may do is **ask the user and wait**.

An "inactive", "not assigned to an agent", or similar task-space error is also a hard stop with the same confirmation requirement. Resume only after explicit user confirmation, then start with `await taskSpaces.claim(id)`.

**Handing off**: When the task requires user intervention (e.g. login, captcha, manual confirmation), call `await taskSpaces.handOff([nameOrId])` to give control to the user, and tell them exactly what to do. Omitting `nameOrId` uses the currently selected task space; pass `task.id` across heredoc rounds to avoid ambiguity.

**Regaining control**: Take control back *only* after the user explicitly confirms — through an Ask (your harness's button/option prompt, e.g. "Continue" vs "Finish task") or a "continue" message in chat. Then start a new heredoc with `await taskSpaces.takeOver([nameOrId])` and resume; if the user chooses to finish, close out with `await taskSpaces.complete(nameOrId, { keep })`. Never call `taskSpaces.takeOver` on your own to grab control back — it has no ownership check and will seize the browser away from the user.

**Unexpected takeover**: The user can take over at any time via the browser GUI — the same effect as the agent calling `taskSpaces.handOff`. Do not retry the failed operation and do not auto-takeover; surface the Ask above (Continue / Finish) and resume only when the user picks Continue.

`await taskSpaces.waitForAgentControl(nameOrId)` is a read-only blocking poll (it never takes control); use it only to wait inside the current heredoc for a handoff you initiated.

## Locators

`page.locator(selector)` and every `page.getBy*(...)` return a strict,
auto-waiting Locator. Strict means a locator matching more than one element
throws rather than guessing: narrow the query, and reach for `first()` / `nth()`
only for confirmed legitimate duplicates.

Prefer the semantic getters over raw CSS — they survive markup changes and read
as the user's view of the page:

```js
await page.getByRole('button', { name: 'Submit' }).click()
await page.getByLabel('Email').fill('user@example.com')
await page.getByText('Results', { exact: false }).waitFor()
```

`getByRole` and the text getters accept a string or a RegExp for `name`. A
failed lookup prints the matcher back readably — `/pattern/flags`, or the quoted
text plus whether the match was exact or substring — so read the error before
changing approach.

Selector strings also accept `xpath=...`, `@N` / `ref=N` refs, and `loc=...`
values from `page.snapshot()` (`loc=css:...`, `loc=role:...`, `loc=href:...`).
`@N` refs are for grazer helpers only; they are not valid inside
`document.querySelector(...)`.

Pull data out through the locator rather than through the page where you can:

```js
const titles = await page.getByRole('heading').allInnerTexts()
const hrefs = await page.locator('article a').evaluateAll(
  (nodes) => nodes.map((node) => node.href),
)
```

## Recommended workflow

grazer has three main workflows. Pick the workflow that fits the page and task before acting.

Use the semantic workflow first for ordinary websites with real DOM controls. For canvas-like productivity apps and rich editors — including Google Docs, Google Sheets, Lark/Feishu Docs, Notion, Figma, whiteboards, maps, and other virtualized editors — use the visual workflow first for the main editing surface. These apps often expose toolbars, title inputs, hidden textareas, offscreen iframes, or canvas layers in the DOM that do not represent the actual user-editable document or grid. Do not rely on locator `fill(...)`, DOM selectors, or `page.snapshot()` refs for the main editing surface unless a small write probe proves the text lands in the intended place.

Before writing substantial content into a rich editor, perform a tiny write probe, then verify it with `await page.screenshot()`, an export/readback path, or another reliable visual/state check. If the probe appears in the title bar, toolbar search, hidden input, or any wrong field, stop using DOM/input helpers for that surface and switch to screenshot-guided mouse actions plus real keyboard operations.

1. **Semantic workflow: locators** — default for most pages with normal text, links, buttons, forms, tables, and lists.
   - Reuse or create a task space: `const task = await taskSpaces.useOrCreate(name)`.
   - Open or switch pages with `await browser.openOrReuseTab(url)`; use `await page.goto(url)` only when navigating inside the current tab.
   - Act with `await page.getByRole(...)`, `await page.getByLabel(...)`, or a narrow `page.locator(...)`. Locators auto-wait, so an explicit wait before a click is usually redundant.
   - Observe with `await page.snapshot()` for a full-page semantic tree annotated with `[ref=N, loc=..., url=...]` when you need to see what is on the page.
   - After meaningful clicks, input, or navigation, observe again with `await page.snapshot()`, `await page.info()`, or `await page.screenshot()` before assuming success.

2. **Visual workflow: `await page.screenshot()` + coordinate/keyboard actions** — use when the page is primarily visual, canvas-like, heavily virtualized, or when accessibility / semantic structure is incomplete.
   - Inspect the screenshot, act with viewport coordinates via `page.mouse.click(x, y)`, `page.mouse.dblclick(x, y)`, `page.keyboard.press(...)`, and `page.keyboard.type(...)`, then verify with another screenshot or a reliable export/readback path.
   - Prefer this path for rich editors, spreadsheets, visual menus, map/canvas UIs, drag interactions, and targets that are obvious visually but poor in the DOM/AX tree.

3. **Direct DOM / CDP workflow: `await page.evaluate(...)` / `await cdp(...)`** — use when you need browser state, compact data extraction, custom DOM traversal, or raw browser capabilities.
   - Keep browser-side logic in one explicit IIFE and return once.
   - Prefer a locator's `evaluateAll` for extracting from a set of elements.
   - Use `await cdp(...)` for browser protocol operations that helpers do not cover.

These workflows can be combined. A task may take multiple heredoc rounds when the next step depends on fresh page state or user handoff. In each round, write a coherent script that advances the task: observe, act or extract, verify, and report with `console.log(...)`. Avoid tiny probe scripts, but don't force the whole task into one oversized script.

## Caveats

- **A new task space is logged out of everything.** Spaces are not seeded from
  a Grazer Sync bundle automatically — nothing in the runtime calls replay. Run
  `grazer sync seed <spaceIdOrName>` *before*
  opening tabs in that space. See **Logged-in sites**.
- **Every duration in this API is milliseconds, never seconds.** `timeout`,
  `idleMs`, `settle`, `delay` and `page.waitForTimeout(ms)` are all
  milliseconds. Passing `timeout: 45` does not wait 45 seconds — it waits 45
  milliseconds, the wait returns instantly, and the page you then read is
  empty for a reason that has nothing to do with the page.
- `browser.openOrReuseTab` waits for the `load` event by default and returns
  `settled` and `waitedFor`. **Read `settled` before trusting the page**:
  `false` means the wait expired and the content may still be partial. For a
  page that keeps filling in after `load`, pass
  `{ waitUntil: 'networkidle' }`, which additionally waits for no network
  activity over `idleMs` (default 500). `timeout` (default 20000) caps the
  whole wait across both phases.
- `await page.info()` normally resolves to `{ url, title, w, h, sx, sy, pw, ph }`; if a native browser dialog is open, it resolves to `{ dialog: ... }` instead because page JavaScript is blocked. Handle the dialog with `await cdp('Page.handleJavaScriptDialog', { accept: true })` or `accept: false` before running page JavaScript.
- If `await page.info()` reports `w: 0` or `h: 0`, do not continue coordinate actions or screenshots until the viewport is fixed. Try `await browser.ensureRealTab()`, reloading, or CDP viewport metrics, then verify with `await page.info()` and `await page.screenshot()`.
- `page.snapshot()` defaults to `scope: 'full_page'`, covering the whole page. Use the default in almost every case; only pass `scope: 'only_within_viewport'` when the task needs only visible content.
- `@N` refs are only valid for the most recent `page.snapshot()` call — every call rebuilds the refMap. Ref numbers come from the CDP `backendNodeId`, so the same element keeps the same number across calls; but to use `@N`, N must appear in the latest snapshot output. An element scrolled out of the viewport, a DOM re-render, or a previous call with `scope:'only_within_viewport'` that didn't cover the element will all cause `Unknown ref`. For elements you need to reference long-term, use the `loc=...` value from snapshot output as a stable selector, or write a CSS selector directly.
- `page.evaluate()` is essentially `Runtime.evaluate` and takes a string. You can pass a function, but doing so triggers a one-time warning and wraps it via `.toString()` — closures are not captured and there is no argument channel. Do not use it the way you would Playwright's `page.evaluate(fn, ...args)`. A locator's `evaluate` / `evaluateAll` do take a function.
- `page.evaluate()` returns the evaluated result, not a JSON string — don't wrap it with `JSON.parse(...)`.
- Inside a `page.evaluate(...)` template string, regex backslashes must be doubled (e.g. `\\d`, `\\s`), or use `String.raw`.
- If the source passed to `page.evaluate()` contains a top-level `return`, it will be auto-wrapped in an IIFE; `return` inside nested callbacks can also trigger this accidentally. For complex expressions, prefer the explicit `(() => { ... })()` form.
- Code in the heredoc body runs in Node.js; code inside `page.evaluate(...)` runs in the browser page. Navigation, waits, and `console.log(...)` belong in the heredoc body; `document`, `window`, and page selectors belong inside `page.evaluate(...)`.
- `page.screencast.start(...)` binds the recording to the current CDP session, so it must be stopped by `page.screencast.stop()` in the same heredoc that started it.
- Always call `taskSpaces.complete(name, { keep })` when the task is done — do not leave the space hanging. Default to `{ keep: false }`; use `{ keep: true }` only for the concrete live-page cases described in Task spaces.
- When the user explicitly asks to use grazer, assume both `grazer` and the repo runtime are ready. Do not pre-check `which grazer`, `node -v`, package metadata, or help output. Only investigate environment issues if the first run produces an error.
- If the first run reports `command not found` or a missing environment, grazer is not on PATH yet. It is installed from the repository, not from npm, so the fix is to run `npm install`, `npm run build`, `npm run harness:build` and then **`npm link`** in the repository checkout, and open a new terminal. Read `references/install.md` and follow its flow, then return to the original task — do not give up, and do not keep retrying the same heredoc.
- The API index in this file is generated from the runtime. If a name here is missing at runtime, the build is stale, not the document: run `npm run build` in `packages/harness`. To regenerate the index after changing the runtime, run `npm run skill:doc` in `packages/harness`.
