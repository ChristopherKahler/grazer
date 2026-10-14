<#
.SYNOPSIS
  Install Grazer on Windows.

.DESCRIPTION
  Installs Grazer for the current user (no admin rights needed):
    1. checks for Node.js 22 or newer
    2. copies Grazer to %LOCALAPPDATA%\Programs\Grazer (or -InstallDir)
    3. saves the browser Grazer runs (Chrome, Brave, Edge, Chromium, Vivaldi or any Chromium .exe)
    4. puts the grazer command on your PATH
    5. installs the grazer skill for Claude Code (~\.claude\skills\grazer)
    6. connects the Grazer Sync extension to Grazer (Chrome, Brave, Edge, Chromium)
    7. starts Grazer once, headless, to check it works

  Run it from an unzipped Grazer release, or straight from GitHub:
    irm https://github.com/ChristopherKahler/grazer/releases/latest/download/install.ps1 | iex
  With options, from GitHub:
    & ([scriptblock]::Create((irm https://github.com/ChristopherKahler/grazer/releases/latest/download/install.ps1))) -Browser chrome

  Your logins and browsing data are never part of the install. They live in
  %LOCALAPPDATA%\Grazer on each computer, created when Grazer is used.

.PARAMETER Browser
  chrome, brave, edge, chromium, vivaldi, or the full path to a Chromium browser .exe.
  Asked for when the script runs in a terminal; otherwise the first browser found is used.
#>
[CmdletBinding()]
param(
  [string]$Browser,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Grazer'),
  [string]$SkillsDir = (Join-Path $HOME '.claude\skills'),
  [string]$Version = 'latest',
  [switch]$NoPath,
  [switch]$NoSkill,
  [switch]$NoRegister,
  [switch]$NoTest,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Repo = 'ChristopherKahler/grazer'
$Marker = '.grazer-install'

function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
# throw, not exit: under `irm | iex` an exit would close the person's terminal.
function Quit([string]$Text) { Write-Host ''; Write-Host "Grazer install stopped: $Text" -ForegroundColor Red; throw "Grazer install stopped: $Text" }

function Test-Interactive {
  try { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { return $false }
}

# Run node with the given arguments; return its exit code. Output goes to the console,
# never into the return value.
function Invoke-Node([string[]]$Arguments) {
  & node @Arguments | Out-Host
  return $LASTEXITCODE
}

# Same, with all output discarded. Windows PowerShell 5.1 turns redirected stderr
# into errors, which 'Stop' would make fatal, so relax it inside this function only.
function Invoke-NodeQuiet([string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  & node @Arguments *> $null
  return $LASTEXITCODE
}

# GitHub needs TLS 1.2; older Windows PowerShell does not always offer it by default.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------- Node.js ---
Step 'Checking Node.js'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Quit "Node.js 22 or newer is required and was not found.
  Install it, open a new terminal, and run this installer again:
    winget install OpenJS.NodeJS.LTS
  or download it from https://nodejs.org"
}
$nodeVersion = (& node -p 'process.versions.node').Trim()
if ([int]($nodeVersion.Split('.')[0]) -lt 22) {
  Quit "Node.js $nodeVersion is too old; Grazer needs 22 or newer.
    winget upgrade OpenJS.NodeJS.LTS
  or download it from https://nodejs.org"
}
Say "Node.js $nodeVersion"

# ---------------------------------------------------------------- source ---
Step 'Getting Grazer'
$source = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'bin\grazer.mjs'))) {
  $source = $PSScriptRoot
  Say "Installing from $source"
} else {
  if ($Version -eq 'latest') {
    $url = "https://github.com/$Repo/releases/latest/download/grazer-windows.zip"
  } else {
    $url = "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))/grazer-windows.zip"
  }
  $download = Join-Path ([IO.Path]::GetTempPath()) ("grazer-download-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $download | Out-Null
  $zip = Join-Path $download 'grazer-windows.zip'
  Say "Downloading $url"
  $previous = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing } catch { Quit "could not download $url ($($_.Exception.Message))" }
  finally { $ProgressPreference = $previous }
  Expand-Archive -Path $zip -DestinationPath $download -Force
  $source = Join-Path $download 'grazer'
  if (-not (Test-Path (Join-Path $source 'bin\grazer.mjs'))) { Quit "the download did not contain a Grazer package" }
}

# ---------------------------------------------------------------- copy ---
Step "Installing to $InstallDir"
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$sameFolder = ([IO.Path]::GetFullPath($source).TrimEnd('\') -ieq $InstallDir.TrimEnd('\'))
if (-not $sameFolder) {
  if (Test-Path $InstallDir) {
    $hasMarker = Test-Path (Join-Path $InstallDir $Marker)
    $isEmpty = -not (Get-ChildItem -Force $InstallDir | Select-Object -First 1)
    if (-not $hasMarker -and -not $isEmpty -and -not $Force) {
      Quit "$InstallDir already exists and was not made by this installer. Pick another -InstallDir, or add -Force to replace it."
    }
    Remove-Item -Recurse -Force $InstallDir
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $source '*') -Destination $InstallDir -Recurse -Force
}
$packageVersion = (Get-Content -Raw (Join-Path $InstallDir 'package.json') | ConvertFrom-Json).version
Set-Content -Path (Join-Path $InstallDir $Marker) -Value "grazer $packageVersion" -Encoding ASCII
$grazer = Join-Path $InstallDir 'bin\grazer.mjs'
Say "Grazer $packageVersion installed"

# ---------------------------------------------------------------- browser ---
Step 'Choosing the browser Grazer runs'
Say 'Grazer runs its own separate profile of a Chromium browser you already have.'
Say 'Your everyday browser profile is never touched. Browsers found on this PC:'
$listing = & node $grazer browser list
$listing | ForEach-Object { Say "  $_" }
$default = $null
$starred = $listing | Where-Object { $_ -like '`* *' } | Select-Object -First 1
if ($starred) { $default = ($starred -split '\s+')[1] }

$choice = $Browser
if (-not $choice -and (Test-Interactive)) {
  while ($true) {
    $prompt = 'Type chrome, brave, edge, chromium, vivaldi, or the full path to a browser .exe'
    if ($default) { $prompt += " [$default]" }
    $answer = Read-Host $prompt
    if (-not $answer) { $answer = $default }
    if (-not $answer) { continue }
    if ($answer -eq 'other') { $answer = Read-Host 'Full path to the browser .exe' }
    $answer = $answer.Trim('"', ' ')
    if ((Invoke-Node @($grazer, 'browser', 'use', $answer)) -eq 0) { $choice = $answer; break }
  }
} else {
  if (-not $choice) { $choice = $default }
  if (-not $choice) { Quit 'no Chromium browser found. Install Google Chrome, or run again with -Browser <path-to-exe>.' }
  if ((Invoke-Node @($grazer, 'browser', 'use', $choice)) -ne 0) { Quit "could not use browser '$choice'" }
}

# ---------------------------------------------------------------- PATH ---
$binDir = Join-Path $InstallDir 'bin'
if (-not $NoPath) {
  Step 'Adding grazer to your PATH'
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $parts = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ine $binDir.TrimEnd('\')) })
  $envKey.SetValue('Path', (($parts + $binDir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $envKey.Close()
  # Setting a variable through .NET tells open programs that the environment changed.
  [Environment]::SetEnvironmentVariable('GRAZER_INSTALL_DIR', $InstallDir, 'User')
  if (($env:Path -split ';') -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
  Say "Added $binDir (new terminals pick it up; restart Claude Code if it is open)"
}

# ---------------------------------------------------------------- skill ---
if (-not $NoSkill) {
  Step 'Installing the grazer skill for Claude Code'
  $skillTarget = Join-Path $SkillsDir 'grazer'
  $install = $true
  if (Test-Path $skillTarget) {
    $item = Get-Item -Force $skillTarget
    $ours = Test-Path (Join-Path $skillTarget $Marker)
    if ($ours -and -not $item.LinkType) {
      Remove-Item -Recurse -Force $skillTarget
    } elseif ($Force) {
      $backup = "$skillTarget.backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
      Move-Item $skillTarget $backup
      Say "Moved the existing skill to $backup"
    } else {
      $install = $false
      Say "A grazer skill is already at $skillTarget and was not made by this installer; left it as it is. Add -Force to replace it."
    }
  }
  if ($install) {
    New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
    Copy-Item -Recurse -Path (Join-Path $InstallDir 'skills\grazer') -Destination $skillTarget
    Set-Content -Path (Join-Path $skillTarget $Marker) -Value "grazer $packageVersion" -Encoding ASCII
    Say "Installed to $skillTarget"
  }
}

# ---------------------------------------------------------------- Grazer Sync ---
if (-not $NoRegister) {
  Step 'Connecting the Grazer Sync extension'
  if ((Invoke-Node @((Join-Path $InstallDir 'bin\grazer-sync.mjs'), 'register', '--browser', 'all')) -ne 0) {
    Quit 'could not register Grazer Sync (see the lines above)'
  }
}

# ---------------------------------------------------------------- check ---
if (-not $NoTest) {
  Step 'Checking that Grazer runs'
  $wasRunning = ((Invoke-NodeQuiet @($grazer, 'browser', 'status')) -eq 0)
  if (-not $wasRunning) {
    if ((Invoke-Node @($grazer, 'browser', 'start')) -ne 0) { Quit 'the browser did not start (see the lines above)' }
  }
  $check = @'
const task = await taskSpaces.useOrCreate('grazer install check')
await browser.openOrReuseTab('data:text/html,<title>grazer ready</title>')
console.log((await page.info()).title)
await taskSpaces.complete(task.id, { keep: false })
'@
  $result = ($check | & node $grazer nodejs) -join "`n"
  $checkCode = $LASTEXITCODE
  if (-not $wasRunning) { Invoke-NodeQuiet @($grazer, 'browser', 'stop') | Out-Null }
  if ($checkCode -ne 0 -or $result -notmatch 'grazer ready') { Quit "the check script failed: $result" }
  Say 'grazer ready'
}

# ---------------------------------------------------------------- next ---
$extensionDir = Join-Path $InstallDir 'extension'
$pages = @{ chrome = 'chrome://extensions'; brave = 'brave://extensions'; edge = 'edge://extensions'; vivaldi = 'vivaldi://extensions'; chromium = 'chrome://extensions' }
$page = $pages[[string]$choice]
if (-not $page) { $page = 'the browser''s extensions page (chrome://extensions works in most)' }
try { Set-Clipboard -Value $extensionDir } catch { }

Write-Host ''
Write-Host 'Grazer is installed.' -ForegroundColor Green
Write-Host @"

To let Grazer use your logins, add the Grazer Sync extension to the browser you
normally browse with (any of Chrome, Brave, Edge, Chromium):

  1. Open $page
  2. Turn on Developer mode (top right).
  3. Click Load unpacked and choose this folder (it is on your clipboard):
       $extensionDir
  4. Pin Grazer Sync from the puzzle-piece menu, click it, tick the sites to share, press Sync.

Then, in Claude Code, ask for any website task: the grazer skill runs it in its own
headless browser. To give a task space your synced logins:
  grazer sync seed <task space name or id>

Change the browser later with:  grazer browser use <chrome|brave|edge|chromium|vivaldi|path>
Uninstall with:                 powershell -ExecutionPolicy Bypass -File "$InstallDir\uninstall.ps1"
"@
