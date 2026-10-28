# Create desktop + Start Menu shortcuts for 「我要背单词」.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads *.ps1 without a BOM as ANSI,
# so any non-ASCII literal here would be mojibake. The display name arrives as a
# parameter (argv is UTF-16, so Chinese passes through intact).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File create-shortcuts.ps1 `
#     -ExePath <app.exe> -IconPath <icon.ico> -WorkDir <install dir> -AppName <name>
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$IconPath,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$AppName
)

$ErrorActionPreference = 'Stop'
# Force UTF-8 stdout so the caller (Node) can print Chinese paths without mojibake.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # Older hosts may refuse; output is still usable, just possibly re-encoded.
}

foreach ($required in @($ExePath, $IconPath, $WorkDir)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "missing path: $required"
  }
}

$shell = New-Object -ComObject WScript.Shell
$linkName = "$AppName.lnk"

# Always ask Windows for the *real* folders: on this machine the shell Desktop is
# redirected to D:\...\桌面, so hardcoding %USERPROFILE%\Desktop would drop the
# shortcut into a directory the user never opens.
$desktopDir = [Environment]::GetFolderPath('Desktop')
$startMenuDir = [Environment]::GetFolderPath('Programs')
$targets = @(
  (Join-Path $desktopDir $linkName),
  (Join-Path $startMenuDir $linkName)
)

foreach ($target in $targets) {
  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $shortcut = $shell.CreateShortcut($target)
  $shortcut.TargetPath = $ExePath
  $shortcut.WorkingDirectory = $WorkDir
  $shortcut.IconLocation = "$IconPath,0"
  $shortcut.Description = $AppName
  $shortcut.WindowStyle = 1
  $shortcut.Save()
  Write-Output ("shortcut: " + $target)
}

# Read back every shortcut: a .lnk that points at a missing exe is worse than none.
foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    throw "shortcut was not created: $target"
  }
  $shortcut = $shell.CreateShortcut($target)
  if (-not (Test-Path -LiteralPath $shortcut.TargetPath)) {
    throw "shortcut target missing: $($shortcut.TargetPath)"
  }
  if (-not (Test-Path -LiteralPath ($shortcut.IconLocation -replace ',\d+$', ''))) {
    throw "shortcut icon missing: $($shortcut.IconLocation)"
  }
  Write-Output ("verified: " + $target + " -> target=" + $shortcut.TargetPath + " workdir=" + $shortcut.WorkingDirectory + " icon=" + $shortcut.IconLocation)
}
