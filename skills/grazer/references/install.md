# Install Grazer (Windows)

Read this file only when the `grazer` command is missing, Grazer Sync is not
connected, or the user asks to install or set up Grazer. For day-to-day browser
work, go back to `SKILL.md`.

Grazer runs a separate, headless profile of a Chromium browser the user already
has (Chrome, Brave, Edge, Chromium, Vivaldi or another). Website:
https://grazerai.com. Full instructions for people: the README at
https://github.com/ChristopherKahler/grazer

## Install

Needs Windows, Node.js 22 or newer (`node --version`), and a Chromium browser.
No admin rights. In PowerShell:

```powershell
& ([scriptblock]::Create((irm https://github.com/ChristopherKahler/grazer/releases/latest/download/install.ps1))) -Browser chrome
```

Pass the browser the user wants: `chrome`, `brave`, `edge`, `chromium`,
`vivaldi`, or the full path to a Chromium `.exe`. Ask the user which browser
they use if it is not clear. Without `-Browser` and without a terminal to answer
in, the installer takes the first one it finds (Chrome, Brave, Vivaldi,
Chromium, Edge).

The installer copies Grazer to `%LOCALAPPDATA%\Programs\Grazer`, saves the
browser choice, adds `grazer` to the user's PATH, installs this skill in
`~\.claude\skills\grazer`, connects the Grazer Sync extension, and runs a
headless check that ends with `grazer ready`. A new terminal (or a Claude Code
restart) is needed before `grazer` is on PATH; until then, call
`node "$env:LOCALAPPDATA\Programs\Grazer\bin\grazer.mjs"` directly.

If Node.js is missing, tell the user to run `winget install OpenJS.NodeJS.LTS`
(or install from https://nodejs.org) and open a new terminal.

## Confirm the runtime

```bash
grazer browser start
grazer nodejs <<'EOF'
console.log('grazer ready')
EOF
```

Printing `grazer ready` means the environment is ready.

## Pick or change the browser

```bash
grazer browser list          # * marks the browser Grazer uses
grazer browser use brave     # chrome, brave, edge, chromium, vivaldi, or a path to an .exe
```

`GRAZER_BROWSER`, when set, overrides the saved choice. Stop and start the
browser after changing it.

## Login inheritance (Grazer Sync)

The user does these steps in their everyday browser. Walk them through it;
you cannot click inside their browser for them.

1. Open the extensions page: `chrome://extensions` (Chrome, Chromium),
   `brave://extensions`, `edge://extensions` or `vivaldi://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked and choose `%LOCALAPPDATA%\Programs\Grazer\extension`.
   Select the `extension` folder itself, not the `lib` folder inside it.
4. Pin Grazer Sync from the puzzle-piece menu and open it. It should say
   `companion ready`. If it says `not registered`, run `grazer sync register`,
   then have the user restart the browser.
5. With the sites open and logged in, the user clicks each site in the popup
   (or adds one in "add a site"), then presses Sync. The popup confirms with
   "Sent to Grazer".

Then seed a task space from the newest sync, with the browser running and the
space created, **before opening tabs in it**:

```bash
grazer sync seed <spaceIdOrName>
```

`browser.openOrReuseTab` reuses a matching tab without reloading it, so a tab
opened before seeding still renders logged out until `await page.reload()`.

The sync lands in `<GRAZER_HOME>/bundles` (default `%LOCALAPPDATA%\Grazer\bundles`)
as plain, unencrypted JSON holding live session cookies for every site the user
selected. It never leaves the device, but it is not protected at rest: delete
stale bundles rather than keeping them.

## Troubleshooting

- **`grazer` not found**: open a new terminal, or call
  `node "$env:LOCALAPPDATA\Programs\Grazer\bin\grazer.mjs"`.
- **"browser is not running"**: run `grazer browser start`; `grazer browser status` shows the port.
- **No browser found, or the wrong one**: `grazer browser list`, then `grazer browser use <name or path>`.
- **Grazer Sync not connected**: `grazer sync status`, then `grazer sync register`
  and a browser restart.
- **"no task space named ..."** when seeding: create the space first with
  `taskSpaces.useOrCreate(name)` in a `grazer nodejs` run.
- **Developing Grazer itself**: from a clone of the repository, `npm ci`,
  `npm run build`, `npm run harness:build`.
