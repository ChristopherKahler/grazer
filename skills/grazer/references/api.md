# grazer API reference

Read this when you need a helper's exact parameters, return shape, or an
example. For the workflow guidance and caveats that decide *which* helper to
reach for, go back to `SKILL.md`.

Everything below is generated from the built runtime. It is not edited by hand:
the names come from what `helperContext()` actually installs, and the
signatures, parameters and examples come from the runtime's own doc table. To
refresh it after changing the runtime, run `npm run skill:doc` in
`packages/harness`.

<!-- BEGIN GENERATED: api-reference -->

*Generated from the runtime by `npm run skill:doc` in `packages/harness`. Do not edit by hand.*

Every entry is a global in the `grazer nodejs` runtime. Durations are milliseconds unless the parameter name says otherwise.

## `page`

> page: Playwright-style page facade. page.url() asynchronously returns the current URL; always call await page.url() before using the string. Use page.goto(url), page.locator(selector), page.getByText(text), page.getByLabel(text), page.getByPlaceholder(text), page.getByTestId(testId), page.setDefaultTimeout(ms), page.waitForEvent("download"), page.waitForLoadState(state, options), page.waitForURL(url, options), page.waitForRequest(urlOrPredicate, options), page.waitForResponse(urlOrPredicate, options), page.evaluate(expression), page.screenshot(options), page.screencast.start({ path, size, quality }), page.screencast.stop(), page.keyboard.press(key), page.keyboard.type(text), and page.mouse.click(x, y). waitForURL predicates receive URL objects and waitUntil defaults to load.

### `page.setDefaultTimeout(timeoutMs) => void`

Set the default timeout, in milliseconds, for page helper operations.

- `timeoutMs` — `number`, required. Timeout in milliseconds.

Returns `void`.

```js
page.setDefaultTimeout(10000)
```

### `page.goto(url, options?) => Promise<any>`

Navigate the current tab to a URL.

- `url` — `string`, required. Destination URL.
- `options` — `object`, optional. Supports timeout, waitUntil, and settle options.

Returns `Promise<any>`.

```js
await page.goto('https://example.com', { timeout: 20000 })
```

### `page.reload(options?) => Promise<any>`

Reload the current page and optionally wait for a load state.

- `options` — `object`, optional. Supports ignoreCache, waitUntil, and timeout.

Returns `Promise<any>`.

```js
await page.reload({ waitUntil: 'load', timeout: 10000 })
```

### `page.info() => Promise<object>`

Return current page URL, title, viewport, scroll, and page size information.

Returns `Promise<{ url, title, w, h, sx, sy, pw, ph }>`.

```js
console.log(await page.info())
```

### `page.url() => Promise<string>`

Asynchronously return the current page URL.

Returns `Promise<string>`.

```js
console.log(await page.url())
```

### `page.title() => Promise<string>`

Return the current page title.

Returns `Promise<string>`.

```js
console.log(await page.title())
```

### `page.locator(selector) => Locator`

Create a locator for CSS, XPath, text, loc=..., or @ref selectors.

- `selector` — `string`, required. CSS selector, xpath=..., text=..., loc=..., or @N snapshot ref.

Returns `Locator`.

```js
await page.locator('button[type=submit]').click()
```

### `page.getByRole(role, options?) => Locator`

Create a locator by accessibility role and optional accessible name.

- `role` — `string`, required. ARIA role such as button, link, textbox.
- `options` — `{ name?: string }`, optional. Accessible name filter.

Returns `Locator`.

```js
await page.getByRole('button', { name: 'Submit' }).click()
```

### `page.getByText(text, options?) => Locator`

Create a locator by visible text.

- `text` — `string`, required. Text to match.
- `options` — `{ exact?: boolean }`, optional. Set exact true for exact text.

Returns `Locator`.

```js
await page.getByText('Save', { exact: true }).click()
```

### `page.getByLabel(text, options?) => Locator`

Create a locator for a form control by label text.

- `text` — `string`, required. Label text.
- `options` — `{ exact?: boolean }`, optional. Set exact true for exact label matching.

Returns `Locator`.

```js
await page.getByLabel('Email').fill('me@example.com')
```

### `page.getByPlaceholder(text, options?) => Locator`

Create a locator for an input by placeholder text.

- `text` — `string`, required. Placeholder text.
- `options` — `{ exact?: boolean }`, optional. Set exact true for exact placeholder matching.

Returns `Locator`.

```js
await page.getByPlaceholder('Search').fill('openai')
```

### `page.getByAltText(text, options?) => Locator`

Create a locator for an element by image alt text.

- `text` — `string`, required. Alt text.
- `options` — `{ exact?: boolean }`, optional. Set exact true for exact alt matching.

Returns `Locator`.

```js
await page.getByAltText('Logo').click()
```

### `page.getByTitle(text, options?) => Locator`

Create a locator by title attribute.

- `text` — `string`, required. Title text.
- `options` — `{ exact?: boolean }`, optional. Set exact true for exact title matching.

Returns `Locator`.

```js
await page.getByTitle('More').click()
```

### `page.getByTestId(testId) => Locator`

Create a locator by test id. The match is always exact; unlike the other getBy helpers this one takes no options argument.

- `testId` — `string`, required. Test id to match exactly.

Returns `Locator`.

```js
await page.getByTestId('submit-button').click()
```

### `page.waitForTimeout(ms) => Promise<void>`

Wait for a fixed duration. Prefer locator/page state waits for page readiness.

- `ms` — `number`, required. Milliseconds to wait.

Returns `Promise<void>`.

```js
await page.waitForTimeout(250)
```

### `page.waitForLoadState(state?, options?) => Promise<void>`

Wait for a load state such as load, domcontentloaded, or networkidle.

- `state` — `string`, optional. Load state. Defaults to load.
- `options` — `{ timeout?: number }`, optional. Timeout in milliseconds.

Returns `Promise<void>`.

```js
await page.waitForLoadState('networkidle', { timeout: 10000 })
```

### `page.waitForSelector(selector, options?) => Promise<any>`

Wait for a selector or locator to reach a desired state.

- `selector` — `string`, required. CSS, XPath, loc=..., text, or @ref selector.
- `options` — `{ state?: string, timeout?: number }`, optional. State and timeout options.

Returns `Promise<any>`.

```js
await page.waitForSelector('button.submit', { state: 'visible' })
```

### `page.waitForFunction(pageFunction, options?) => Promise<any>`

Poll browser-side JavaScript until it returns a truthy value.

- `pageFunction` — `string | Function`, required. Browser-side predicate.
- `options` — `{ timeout?: number, polling?: number }`, optional. Wait options.

Returns `Promise<any>`.

```js
await page.waitForFunction(() => document.readyState === 'complete')
```

### `page.waitForURL(url, options?) => Promise<boolean>`

Wait until the current URL matches a string, glob, regex, or predicate receiving a URL object, then wait for load by default.

- `url` — `string | RegExp | Function`, required. URL matcher. Predicate functions receive a URL object; use url.href, url.pathname, or url.searchParams.
- `options` — `{ timeout?: number, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }`, optional. Timeout in milliseconds and completion state; waitUntil defaults to 'load'.

Returns `Promise<boolean>`.

```js
await page.waitForURL(url => url.pathname === '/done', { timeout: 10000 })
```

### `page.waitForRequest(urlOrPredicate, options?) => Promise<Request>`

Wait for a network request matching an exact URL, regex, or synchronous predicate.

- `urlOrPredicate` — `string | RegExp | Function`, required. Exact URL, URL regex, or request predicate.
- `options` — `{ timeout?: number }`, optional. Timeout in milliseconds; 0 disables timeout.

Returns `Promise<{ url(), method(), headers(), postData(), resourceType() }>`.

```js
const req = await page.waitForRequest(/\/api\/search/)
```

### `page.waitForResponse(urlOrPredicate, options?) => Promise<Response>`

Wait for a network response matching an exact URL, regex, or synchronous predicate.

- `urlOrPredicate` — `string | RegExp | Function`, required. Exact URL, URL regex, or response predicate.
- `options` — `{ timeout?: number }`, optional. Timeout in milliseconds; 0 disables timeout.

Returns `Promise<{ url(), status(), ok(), headers(), request(), text(), json(), body() }>`.

```js
const res = await page.waitForResponse(r => r.url().includes('/api') && r.status() === 200)
```

### `page.waitForEvent(eventName, options?) => Promise<any>`

Wait for a page event. Currently useful for download events.

- `eventName` — `string`, required. Event name, such as download.
- `options` — `{ timeout?: number }`, optional. Timeout in milliseconds.

Returns `Promise<any>`.

```js
const download = await page.waitForEvent('download')
```

### `page.evaluate(expression) => Promise<any>`

Evaluate page-wide browser JavaScript. Prefer locator.evaluateAll or extractAll for element collections.

- `expression` — `string | Function`, required. Browser-side expression or function.

Returns `Promise<any>`.

```js
console.log(await page.evaluate('document.title'))
```

### `page.screenshot(options?) => Promise<string>`

Capture a screenshot and return the saved path or data depending on options.

- `options` — `object`, optional. Screenshot options.

Returns `Promise<string>`.

```js
console.log(await page.screenshot({ path: '/tmp/page.png' }))
```

### `page.snapshot(options?) => Promise<string>`

Return a semantic page snapshot with refs and stable locators.

- `options` — `object`, optional. Snapshot options such as scope.

Returns `Promise<string>`.

```js
console.log(await page.snapshot())
```

### `page.snapshotRaw(options?) => Promise<object>`

Return the raw structured snapshot object.

- `options` — `object`, optional. Snapshot options.

Returns `Promise<object>`.

```js
console.log(await page.snapshotRaw())
```

### `page.elementCenter(selector) => Promise<{ x, y }>`

Resolve an element and return its viewport center point.

- `selector` — `string`, required. Selector or @ref.

Returns `Promise<{ x: number, y: number }>`.

```js
console.log(await page.elementCenter('@12'))
```

### `page.drainEvents() => Promise<object[]>`

Drain buffered page/CDP events.

Returns `Promise<object[]>`.

```js
console.log(await page.drainEvents())
```

### `page.screencast.start(options) => Promise<Disposable>`

Start recording the current page viewport to a silent VP8 WebM file. The recording is bound to the current CDP session, so it must be stopped in the same script that started it.

- `options` — `{ path: string, size?: { width: number, height: number }, quality?: number }`, required. `path` must end in .webm. `quality` is JPEG quality from 0 to 100, default 90.

Returns `Promise<{ dispose: () => Promise<void> }>`.

```js
const recording = await page.screencast.start({ path: 'run.webm' })
```

### `page.screencast.stop() => Promise<void>`

Stop and finalize the active page screencast. Resolves once the WebM file is closed. A no-op when nothing is recording.

Returns `Promise<void>`.

```js
await page.screencast.stop()
```

### `page.keyboard.press(key, options?) => Promise<void>`

Press a keyboard key or shortcut.

- `key` — `string`, required. Key or shortcut such as Enter or Meta+A.
- `options` — `object`, optional. Keyboard options.

Returns `Promise<void>`.

```js
await page.keyboard.press('Enter')
```

### `page.keyboard.down(keyCombo) => Promise<void>`

Dispatch a keydown event. Modifier keys stay held until the matching page.keyboard.up().

- `keyCombo` — `string`, required. Key or modifier+key combo.

Returns `Promise<void>`.

```js
await page.keyboard.down('Shift')
```

### `page.keyboard.up(keyCombo) => Promise<void>`

Dispatch a keyup event and release held modifier keys.

- `keyCombo` — `string`, required. Key or modifier+key combo.

Returns `Promise<void>`.

```js
await page.keyboard.up('Shift')
```

### `page.keyboard.insertText(text) => Promise<void>`

Insert text at the current focus.

- `text` — `string`, required. Text to insert.

Returns `Promise<void>`.

```js
await page.keyboard.insertText('hello')
```

### `page.keyboard.type(text, options?) => Promise<void>`

Type text as real key events, one key at a time. Use page.keyboard.insertText for a single bulk insert that skips per-key events.

- `text` — `string`, required. Text to type.
- `options` — `{ delay?: number }`, optional. Delay in milliseconds between key presses.

Returns `Promise<void>`.

```js
await page.keyboard.type('hello', { delay: 20 })
```

### `page.mouse.click(x, y, options?) => Promise<void>`

Click viewport coordinates. Prefer locators unless using a visual/canvas workflow.

- `x` — `number | object | array`, required. X coordinate or point object/array.
- `y` — `number`, optional. Y coordinate when x is numeric.
- `options` — `object`, optional. Click options.

Returns `Promise<void>`.

```js
await page.mouse.click(420, 260)
```

### `page.mouse.dblclick(x, y, options?) => Promise<void>`

Double-click viewport coordinates. Prefer locators when possible.

- `x` — `number | object | array`, required. X coordinate or point object/array.
- `y` — `number`, optional. Y coordinate when x is numeric.
- `options` — `object`, optional. Double-click options.

Returns `Promise<void>`.

```js
await page.mouse.dblclick(420, 260)
```

### `page.mouse.move(x, y) => Promise<void>`

Move the mouse to viewport coordinates.

- `x` — `number`, required. X coordinate.
- `y` — `number`, required. Y coordinate.

Returns `Promise<void>`.

```js
await page.mouse.move(420, 260)
```

### `page.mouse.down(options?) => Promise<void>`

Press a mouse button at the current mouse position. Position the pointer first with page.mouse.move.

- `options` — `{ button?: "left" | "middle" | "right", clickCount?: number }`, optional. Button defaults to left, clickCount to 1.

Returns `Promise<void>`.

```js
await page.mouse.down()
```

### `page.mouse.up(options?) => Promise<void>`

Release a mouse button at the current mouse position.

- `options` — `{ button?: "left" | "middle" | "right", clickCount?: number }`, optional. Button defaults to left, clickCount to 1.

Returns `Promise<void>`.

```js
await page.mouse.up()
```

### `page.mouse.wheel(deltaX, deltaY) => Promise<void>`

Scroll with a mouse wheel. Positive deltaY scrolls down.

- `deltaX` — `number`, required. Horizontal wheel delta.
- `deltaY` — `number`, required. Vertical wheel delta.

Returns `Promise<void>`.

```js
await page.mouse.wheel(0, 900)
```

### `page.mouse.drag(points, options?) => Promise<void>`

Drag between points or element selectors.

- `points` — `array`, required. Source and destination points/selectors.
- `options` — `object`, optional. Drag options.

Returns `Promise<void>`.

```js
await page.mouse.drag([[100, 100], [300, 300]])
```

## `browser`

> browser: tab facade. Use browser.listTabs(), browser.currentTab(), browser.switchTab(target), browser.openOrReuseTab(url, options), and browser.closeTab(target). Treat targetId as short-lived: obtain and validate it in the current script; switchTab/closeTab refresh the tab list before acting.

### `browser.listTabs() => Promise<object[]>`

List tabs in the current task space.

Returns `Promise<object[]>`.

```js
console.log(await browser.listTabs())
```

### `browser.currentTab() => Promise<object | null>`

Return the current selected tab.

Returns `Promise<object | null>`.

```js
console.log(await browser.currentTab())
```

### `browser.switchTab(target) => Promise<string>`

Refresh the current tab list, validate a target id/tab object, then switch to that tab.

- `target` — `string | object`, required. Target id or tab object.

Returns `Promise<string>`.

```js
const tab = (await browser.listTabs()).find(t => t.url.includes('/docs')); if (!tab) throw new Error('docs tab not found'); await browser.switchTab(tab.targetId)
```

### `browser.openOrReuseTab(url, options?) => Promise<object>`

Open a URL in a new or reusable tab, then select it. Read `settled` on the result before trusting the page: false means the wait expired and the content may still be partial.

- `url` — `string`, required. URL to open.
- `options` — `{ match?: "exact" | "origin" | "origin+path" | "includes", wait?: boolean, waitUntil?: "load" | "domcontentloaded" | "networkidle", timeout?: number, idleMs?: number, settle?: number }`, optional. Open and wait options. `waitUntil` defaults to "load". Pass "networkidle" for a page that keeps filling in after the load event; it adds a wait for no network activity over `idleMs` (default 500), which applies to "networkidle" only. `timeout` (default 20000) caps the whole wait across both phases. Every one of these numbers is milliseconds, never seconds.

Returns `Promise<{ targetId, url, title, active, reused, settled: boolean, waitedFor: "load" | "domcontentloaded" | "networkidle" | "none" }>`.

```js
const tab = await browser.openOrReuseTab('https://example.com'); if (!tab.settled) console.log('content may be partial')
```

### `browser.closeTab(target?) => Promise<string>`

Refresh the current tab list, validate, and close a tab by target id/object, or close the current tab when omitted.

- `target` — `string | object`, optional. Target id or tab object.

Returns `Promise<string>`.

```js
await browser.closeTab()
```

### `browser.ensureRealTab() => Promise<object | null>`

Switch to an existing non-internal page tab if one exists.

Returns `Promise<object | null>`.

```js
await browser.ensureRealTab()
```

### `browser.iframeTarget(frameSelector) => Promise<object | null>`

Resolve an iframe target for advanced CDP interactions.

- `frameSelector` — `string`, required. Iframe selector.

Returns `Promise<object | null>`.

```js
console.log(await browser.iframeTarget('iframe'))
```

## `taskSpaces`

> taskSpaces: task-space facade. Use taskSpaces.useOrCreate(nameOrId), taskSpaces.claim(nameOrId), taskSpaces.switch(nameOrId), taskSpaces.complete(nameOrId, options), taskSpaces.handOff(nameOrId), taskSpaces.takeOver(nameOrId), and taskSpaces.waitForAgentControl(nameOrId, options).

### `taskSpaces.list() => Promise<object[]>`

List browser task spaces.

Returns `Promise<object[]>`.

```js
console.log(await taskSpaces.list())
```

### `taskSpaces.switch(nameOrId) => Promise<object>`

Switch to an agent-owned task space.

- `nameOrId` — `string | number`, required. Task space name, taskId, or numeric id.

Returns `Promise<object>`.

```js
await taskSpaces.switch(3)
```

### `taskSpaces.new(name) => Promise<object>`

Create and select a new task space.

- `name` — `string`, required. Task space name.

Returns `Promise<object>`.

```js
const task = await taskSpaces.new('research task')
```

### `taskSpaces.useOrCreate(nameOrId) => Promise<object>`

Reuse an agent-owned task space or create one by name.

- `nameOrId` — `string | number`, required. Task space name, taskId, or numeric id.

Returns `Promise<object>`.

```js
const task = await taskSpaces.useOrCreate('google sheets task')
```

### `taskSpaces.claim(nameOrId) => Promise<object>`

Claim a user-owned task space and select it.

- `nameOrId` — `string | number`, required. Task space name, taskId, or numeric id.

Returns `Promise<object>`.

```js
await taskSpaces.claim(3)
```

### `taskSpaces.complete(nameOrId, options) => Promise<object>`

Finish a task space. options.keep is required.

- `nameOrId` — `string | number`, required. Task space name, taskId, or numeric id.
- `options` — `{ keep: boolean }`, required. Whether to keep the task space open.

Returns `Promise<object>`.

```js
await taskSpaces.complete(task.id, { keep: false })
```

### `taskSpaces.handOff(nameOrId?) => Promise<object>`

Hand control of a task space to the user for manual action.

- `nameOrId` — `string | number`, optional. Task space name, taskId, or numeric id. Defaults to current task space.

Returns `Promise<object>`.

```js
await taskSpaces.handOff(task.id)
```

### `taskSpaces.takeOver(nameOrId?) => Promise<object>`

Take control back after the user explicitly confirms continuation.

- `nameOrId` — `string | number`, optional. Task space name, taskId, or numeric id. Defaults to current task space.

Returns `Promise<object>`.

```js
await taskSpaces.takeOver(task.id)
```

### `taskSpaces.waitForAgentControl(nameOrId?, options?) => Promise<void>`

Poll until agent control is restored without taking control.

- `nameOrId` — `string | number`, optional. Task space name, taskId, or numeric id.
- `options` — `{ interval?: number, timeout?: number }`, optional. Polling options in seconds.

Returns `Promise<void>`.

```js
await taskSpaces.waitForAgentControl(task.id)
```

## `site`

> site: learned site-skill facade. Use site.skills(url), site.skillsForUrl(url), site.runTool(siteId, toolName, args), site.runBrowserTool(siteId, toolName, args), and site.learnContext(url).

### `site.skills(url?) => Promise<object[]>`

List site learning packs matching a URL, or the current page URL when omitted.

- `url` — `string`, optional. URL to inspect. Defaults to current page URL.

Returns `Promise<object[]>`.

```js
console.log(await site.skills('https://www.google.com/search?q=test'))
```

### `site.skillsForUrl(url) => Promise<object[]>`

List site learning packs whose manifest domains match the URL.

- `url` — `string`, required. URL or domain to inspect.

Returns `Promise<object[]>`.

```js
console.log(await site.skillsForUrl('https://x.com/home'))
```

### `site.runTool(siteId, toolName, args?) => Promise<tool result>`

Run a Node-side learned site tool. Inspect site.learnContext(url).tools[].args and tools[].returns for the exact schema before calling.

- `siteId` — `string`, required. Learning pack id, such as google or x-com.
- `toolName` — `string`, required. Tool name declared in manifest.json nodeTools.
- `args` — `object`, optional. Tool arguments matching the manifest schema.

Returns `Promise<tool result declared by manifest.json returns; inspect site.learnContext(url).tools[].returns>`.

```js
const ctx = await site.learnContext('https://www.google.com/search?q=test'); console.log(ctx.tools); const results = await site.runTool('google', 'search_and_extract', { query: 'openai', maxResults: 5 })
```

### `site.runBrowserTool(siteId, toolName, args?) => Promise<tool result>`

Run a browser-side learned tool in the current page context. Inspect site.learnContext(url).tools[].args and tools[].returns for the exact schema before calling.

- `siteId` — `string`, required. Learning pack id.
- `toolName` — `string`, required. Tool name declared in manifest.json browserTools.
- `args` — `object`, optional. Tool arguments matching the manifest schema.

Returns `Promise<tool result declared by manifest.json returns; inspect site.learnContext(url).tools[].returns>`.

```js
const ctx = await site.learnContext('https://x.com/home'); console.log(ctx.tools); const post = await site.runBrowserTool('x-com', 'post_from_active_element')
```

### `site.learnContext(url?) => Promise<object>`

Load matching learning notes and exact tool schemas, including args and returns, for a URL or the current page URL.

- `url` — `string`, optional. URL to inspect. Defaults to current page URL.

Returns `Promise<{ exists, siteId, siteName, knowledge, tools: Array<{ siteId, toolName, toolType, description, args, returns, example }> }>`.

```js
console.log(await site.learnContext('https://www.google.com/search?q=test'))
```

## `fetch`

> fetch: network facade. Use fetch.server(url, options) for Node-side fetch and fetch.browser(url, options) for browser-origin fetch.

### `fetch.server(url, options?) => Promise<string>`

Fetch text from Node with a browser-like User-Agent.

- `url` — `string`, required. URL to fetch.
- `options` — `object`, optional. Fetch options including method, headers, body, timeout seconds.

Returns `Promise<string>`.

```js
const html = await fetch.server('https://example.com')
```

### `fetch.browser(url, options?) => Promise<string>`

Fetch text inside the current browser page context.

- `url` — `string`, required. URL to fetch. Relative URLs resolve against current page.
- `options` — `object`, optional. Fetch options including method, headers, body, timeout seconds.

Returns `Promise<string>`.

```js
const body = await fetch.browser('/api/data')
```

## Top level

### `cdp(method, params?) => Promise<any>`

Send a supported raw Chrome DevTools Protocol command to the current target. Browser.grantPermissions and Browser.setPermission are not exposed by the task-space bridge.

- `method` — `string`, required. CDP method, such as Runtime.evaluate.
- `params` — `object`, optional. CDP command parameters.

Returns `Promise<any>`.

```js
console.log(await cdp('Runtime.evaluate', { expression: 'document.title' }))
```

### `help(name?) => string`

Print helper documentation. Use this when console output is not enough.

- `name` — `string`, optional. Helper or facade name, such as page, locator, browser, site.

Returns `string`.

```js
console.log(help('site'))
```

## `Locator`

> page.locator(selector): returns a strict, auto-waiting locator facade with locator(), getByRole(), getByText(), filter(), first(), nth(index), last(), click(), hover(), dragTo(target), scrollIntoViewIfNeeded(), fill(value), clear(), press(key), check(), selectOption(value), textContent(), innerText(), innerHTML(), isVisible(), isEnabled(), getAttribute(name), screenshot(), count(), evaluate(fn, arg), evaluateAll(fn, arg), and waitFor(options). Narrow multiple matches; use first()/nth() only for confirmed legitimate duplicates.

Returned by `page.locator(...)` and every `page.getBy*(...)`. The runtime's doc table carries no entries for these methods, so this list is names only, read off a live locator object. Do not assume a signature — `console.log(help('locator'))` is the runtime's own description.

- `first`
- `last`
- `nth`
- `locator`
- `getByRole`
- `getByText`
- `getByLabel`
- `getByPlaceholder`
- `getByAltText`
- `getByTitle`
- `getByTestId`
- `filter`
- `click`
- `dblclick`
- `hover`
- `dragTo`
- `scrollIntoViewIfNeeded`
- `focus`
- `fill`
- `clear`
- `press`
- `pressSequentially`
- `check`
- `uncheck`
- `setChecked`
- `selectOption`
- `setInputFiles`
- `dispatchEvent`
- `blur`
- `textContent`
- `innerText`
- `innerHTML`
- `inputValue`
- `isChecked`
- `isVisible`
- `isHidden`
- `isEnabled`
- `isDisabled`
- `isEditable`
- `getAttribute`
- `boundingBox`
- `screenshot`
- `count`
- `allInnerTexts`
- `allTextContents`
- `evaluate`
- `evaluateAll`
- `waitFor`

<!-- END GENERATED: api-reference -->
