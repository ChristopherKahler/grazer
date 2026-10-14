# Grazer

Give your AI agent its own logged-in browser on Windows.

Grazer runs a separate, headless profile of a Chromium browser you already have
(Google Chrome, Brave, Microsoft Edge, Chromium, Vivaldi or another). Your agent
works there in its own task spaces while you keep using your own browser. The
Grazer Sync extension hands over your logins for the sites you choose, so the
agent can work in your accounts without you typing passwords into it.

Website: https://grazerai.com

## What you need

- Windows 10 or 11
- Node.js 22 or newer. Check with `node --version`; install with
  `winget install OpenJS.NodeJS.LTS` or from https://nodejs.org
- A Chromium browser: Google Chrome, Brave, Microsoft Edge, Chromium or Vivaldi
  (other Chromium browsers work if you point Grazer at their `.exe`)
- Claude Code, or another AI agent that can run shell commands

No admin rights are needed. Everything installs for your Windows user only.

## Install

Open PowerShell and run:

```powershell
irm https://github.com/ChristopherKahler/grazer/releases/latest/download/install.ps1 | iex
```

Or download `grazer-windows.zip` from the
[latest release](https://github.com/ChristopherKahler/grazer/releases/latest),
unzip it, and run this inside the unzipped `grazer` folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

1. Checks for Node.js 22 or newer.
2. Copies Grazer to `%LOCALAPPDATA%\Programs\Grazer`.
3. Asks which browser Grazer should run, and saves your choice.
4. Adds the `grazer` command to your PATH.
5. Installs the `grazer` skill for Claude Code in `~\.claude\skills\grazer`.
6. Connects the Grazer Sync extension to Grazer, for Chrome, Brave, Edge and Chromium.
7. Starts Grazer once, headless, to check it works, then stops it.

Open a new terminal afterwards (and restart Claude Code if it was open) so the
`grazer` command is found.

### Installer options

| Option | What it does |
| --- | --- |
| `-Browser chrome` | Skips the question. Takes `chrome`, `brave`, `edge`, `chromium`, `vivaldi`, or the full path to a browser `.exe`. |
| `-InstallDir <folder>` | Installs somewhere other than `%LOCALAPPDATA%\Programs\Grazer`. |
| `-NoSkill` | Does not install the Claude Code skill. |
| `-NoPath` | Does not change your PATH. |
| `-NoRegister` | Does not connect the Grazer Sync extension. |
| `-NoTest` | Skips the final check. |
| `-Version 0.1.0` | Installs a specific release instead of the latest. |

To pass options to the one-line install:

```powershell
& ([scriptblock]::Create((irm https://github.com/ChristopherKahler/grazer/releases/latest/download/install.ps1))) -Browser brave
```

When the installer runs without a terminal to answer in (for example, when an
agent runs it), it uses the first browser it finds, in this order: Chrome,
Brave, Vivaldi, Chromium, Edge. Pass `-Browser` to choose.

### Change the browser later

```powershell
grazer browser list          # browsers found on this PC; * marks the one Grazer uses
grazer browser use brave     # or chrome, edge, chromium, vivaldi, or a path to an .exe
```

Grazer always uses its own profile folder, never your everyday browser profile.

## Bring your logins: the Grazer Sync extension

Grazer's browser starts logged out of everything. Grazer Sync is a small browser
extension that copies the login cookies and site storage for sites you pick from
your everyday browser to Grazer. It only talks to Grazer on the same computer.
Nothing is sent over the internet.

Install it in the browser you normally browse with. It works in Chrome, Brave,
Edge and Chromium, whichever browser Grazer itself runs.

1. Open your browser's extensions page:

   | Browser | Address |
   | --- | --- |
   | Google Chrome | `chrome://extensions` |
   | Brave | `brave://extensions` |
   | Microsoft Edge | `edge://extensions` |
   | Chromium | `chrome://extensions` |
   | Vivaldi | `vivaldi://extensions` |

2. Turn on **Developer mode** (a switch at the top right; in Edge it is on the left).
3. Click **Load unpacked**.
4. Choose the `extension` folder inside your Grazer install:
   `%LOCALAPPDATA%\Programs\Grazer\extension`
   (the installer puts this path on your clipboard; paste it into the folder box).
   Select the `extension` folder itself, not the `lib` folder inside it.
5. Click the puzzle-piece icon in the toolbar and pin **Grazer Sync**.
6. Click **Grazer Sync**. The top right should say **companion ready**. If it
   says **not registered**, run `grazer sync register` and reopen the popup.

To sync a site:

1. Make sure you are logged in to the site in a normal tab.
2. Open the Grazer Sync popup. Sites from your open tabs are listed; type any
   other site into **add a site** and press **add**.
3. Click each site you want to hand over, so it lights up.
4. Press **Sync** (it shows how many sites are selected). The popup confirms with
   **Sent to Grazer**.

Then put those logins into the agent's task space. Your agent runs this itself
when the grazer skill is installed, with the Grazer browser running and the
task space already created:

```powershell
grazer sync seed "<task space name or id>"
```

It uses your newest sync. Seed a space before opening tabs in it: a tab opened
earlier keeps showing the logged-out page until it is reloaded.

**Keep your synced logins safe.** Each sync is saved as a plain file in
`%LOCALAPPDATA%\Grazer\bundles`. It holds working login cookies for the sites
you picked. Anyone who can read that folder could use those sessions. Sync only
the sites you need, and delete old files in that folder when you are done.

`grazer sync status` shows which browsers can reach Grazer. `grazer sync register`
reconnects them; restart the browser after running it.

## Use it

With Claude Code, just ask for a website task ("open my dashboard and export
last month's orders"). The grazer skill tells the agent how to run it.

By hand:

```bash
grazer browser start
grazer nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('look at example.com')
await browser.openOrReuseTab('https://example.com')
console.log(await page.snapshot())
EOF
grazer browser stop
```

The browser runs headless by default. Add `--headed` to `grazer browser start`
to watch it.

### Commands

| Command | What it does |
| --- | --- |
| `grazer nodejs` | Runs a script from standard input against the Grazer browser. |
| `grazer browser start` | Starts the Grazer browser (headless; `--headed` to show it). |
| `grazer browser status` | Shows whether it is running. |
| `grazer browser stop` | Stops it. |
| `grazer browser list` | Lists the browsers found and the one Grazer uses. |
| `grazer browser use <name or path>` | Picks the browser Grazer runs. |
| `grazer space list` | Lists task spaces. |
| `grazer space takeover <id>` / `handoff <id>` | Takes control of a task space from the agent, or gives it back. |
| `grazer space end <id>` / `delete <id>` | Ends or removes a task space. |
| `grazer sync register` / `status` / `unregister` | Connects, checks or disconnects the Grazer Sync extension. |
| `grazer sync seed <space>` | Copies your newest synced logins into a task space. |
| `grazer --version` | Prints the installed version. |

## Where things live

| What | Where |
| --- | --- |
| Grazer itself | `%LOCALAPPDATA%\Programs\Grazer` |
| Your Grazer data: browser profile, synced logins, browser choice | `%LOCALAPPDATA%\Grazer` |
| Claude Code skill | `%USERPROFILE%\.claude\skills\grazer` |

Your data is never part of Grazer's files or its releases. Each computer keeps
its own.

## Update

Run the install command again. Your browser choice, task spaces and synced
logins are kept.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Grazer\uninstall.ps1"
```

This removes Grazer, its PATH entry, the skill, and the Grazer Sync connection.
Your Grazer data is kept unless you add `-RemoveData`. Remove the Grazer Sync
extension from your browser's extensions page yourself.

## Troubleshooting

- **`grazer` is not recognized.** Open a new terminal, or restart Claude Code.
- **"Grazer browser is not running".** Run `grazer browser start`.
- **"No Chromium browser found" or the wrong browser starts.** Run
  `grazer browser list`, then `grazer browser use <name or path>`. A
  `GRAZER_BROWSER` environment variable overrides the saved choice.
- **Grazer Sync says "not registered".** Run `grazer sync register`, restart the
  browser, and reopen the popup.
- **A site is still logged out after seeding.** Check that the site was selected
  when you pressed Sync, sync again, then run `grazer sync seed` before opening
  the site in that task space.
- **Opera, Arc and other Chromium browsers** have not been tested. Point Grazer
  at their `.exe` with `grazer browser use`; Grazer Sync registers through
  Chrome's settings, which most of them read.

## Build from source

```powershell
npm ci
npm run build
npm run harness:build
npm test
npm run package    # writes release\grazer-windows.zip from the committed code
```

## License

Copyright (c) 2026 Christopher Kahler. All rights reserved. You may install and
use Grazer; you may not redistribute, resell or reuse its code. See
[LICENSE](LICENSE). The bundled harness in `packages/harness` is under its own
MIT license.
