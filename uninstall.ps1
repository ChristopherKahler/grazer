<#
.SYNOPSIS
  Remove Grazer from this computer.

.DESCRIPTION
  Stops the Grazer browser, disconnects the Grazer Sync extension (when it
  points at this install), removes grazer from your PATH, removes the grazer
  skill this installer added, and deletes the install folder.

  Your Grazer data (the Grazer browser profile and synced logins in
  %LOCALAPPDATA%\Grazer) is kept unless you add -RemoveData. Remove the
  Grazer Sync extension from your browser's extensions page yourself.
#>
[CmdletBinding()]
param(
  [string]$InstallDir,
  [string]$SkillsDir = (Join-Path $HOME '.claude\skills'),
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$Marker = '.grazer-install'

function Say([string]$Text) { Write-Host $Text }

function Invoke-NodeQuiet([string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  & node @Arguments *> $null
  return $LASTEXITCODE
}

if (-not $InstallDir) {
  $InstallDir = [Environment]::GetEnvironmentVariable('GRAZER_INSTALL_DIR', 'User')
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Grazer' }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if (-not (Test-Path (Join-Path $InstallDir $Marker))) {
  throw "No Grazer install found at $InstallDir (it has no $Marker file). Pass -InstallDir."
}
$grazer = Join-Path $InstallDir 'bin\grazer.mjs'
$home_ = $env:GRAZER_HOME
if (-not $home_) { $home_ = Join-Path $env:LOCALAPPDATA 'Grazer' }

Say 'Stopping the Grazer browser'
Invoke-NodeQuiet @($grazer, 'browser', 'stop') | Out-Null

# Disconnect Grazer Sync only when its registration points at this install.
$hostManifest = Join-Path $home_ 'native-host\com.grazerai.companion.json'
if (Test-Path $hostManifest) {
  $hostPath = [string](Get-Content -Raw $hostManifest | ConvertFrom-Json).path
  if ($hostPath -and $hostPath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
    Say 'Disconnecting the Grazer Sync extension'
    Invoke-NodeQuiet @((Join-Path $InstallDir 'bin\grazer-sync.mjs'), 'unregister', '--browser', 'all') | Out-Null
    Remove-Item -Force $hostManifest
  } else {
    Say "Grazer Sync is registered to another copy of Grazer ($hostPath); left it connected."
  }
}

$binDir = Join-Path $InstallDir 'bin'
$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($userPath -split ';' | Where-Object { $_ })
$kept = @($parts | Where-Object { $_.TrimEnd('\') -ine $binDir.TrimEnd('\') })
if ($kept.Count -ne $parts.Count) {
  Say 'Removing grazer from your PATH'
  $envKey.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
}
$envKey.Close()
if ([Environment]::GetEnvironmentVariable('GRAZER_INSTALL_DIR', 'User') -ieq $InstallDir) {
  [Environment]::SetEnvironmentVariable('GRAZER_INSTALL_DIR', $null, 'User')
}

$skillTarget = Join-Path $SkillsDir 'grazer'
if ((Test-Path (Join-Path $skillTarget $Marker)) -and -not (Get-Item -Force $skillTarget).LinkType) {
  Say "Removing the grazer skill from $skillTarget"
  Remove-Item -Recurse -Force $skillTarget
}

Say "Removing $InstallDir"
Set-Location $env:TEMP
Remove-Item -Recurse -Force $InstallDir

if ($RemoveData) {
  if (Test-Path $home_) {
    Say "Deleting Grazer data (browser profile and synced logins) in $home_"
    Remove-Item -Recurse -Force $home_
  }
} else {
  Say "Kept your Grazer data in $home_ (add -RemoveData to delete it)."
}

Write-Host ''
Write-Host 'Grazer is uninstalled. Remove the Grazer Sync extension from your browser''s extensions page.' -ForegroundColor Green
