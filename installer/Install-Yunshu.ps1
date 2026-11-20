[CmdletBinding()]
param(
  [ValidateSet('Install','Remove','Check')][string]$Action = 'Install',
  [string]$DesktopPath,
  [string]$DshHome,
  [switch]$NoPrompt
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$release = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json

function Find-Desktop {
  if ($DesktopPath) { return (Resolve-Path -LiteralPath $DesktopPath).Path }
  $candidates = @()
  $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
  foreach ($key in $keys) {
    foreach ($entry in @(Get-ItemProperty $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'DeepSeek.*Harness' })) {
      if ($entry.InstallLocation) { $candidates += Join-Path $entry.InstallLocation 'DeepSeek Harness.exe' }
      if ($entry.DisplayIcon) { $candidates += (($entry.DisplayIcon -replace ',\d+$','').Trim('"')) }
    }
  }
  foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
    if (-not $base) { continue }
    foreach ($suffix in @('DeepSeek Harness\DeepSeek Harness.exe', 'Programs\DeepSeek Harness\DeepSeek Harness.exe', 'deepseek\DeepSeek Harness.exe')) { $candidates += Join-Path $base $suffix }
  }
  foreach ($path in $candidates | Select-Object -Unique) {
    if ((Test-Path -LiteralPath $path -PathType Leaf) -and (Split-Path $path -Leaf) -eq 'DeepSeek Harness.exe') { return $path }
  }
  if ($NoPrompt) { throw 'Desktop not found. Pass -DesktopPath with the installed DeepSeek Harness.exe.' }
  Add-Type -AssemblyName System.Windows.Forms
  $picker = New-Object System.Windows.Forms.OpenFileDialog
  $picker.Title = 'Select the installed DeepSeek Harness.exe'
  $picker.Filter = 'DeepSeek Harness|DeepSeek Harness.exe'
  try { if ($picker.ShowDialog() -ne 'OK') { throw 'No desktop selected; nothing changed.' }; return $picker.FileName } finally { $picker.Dispose() }
}
function Quote-Argument([string]$Value) {
  if ($Value -match '[\r\n\x00]') { throw 'Invalid command argument.' }
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function File-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}
function Invoke-BundledNode([string]$Entry, [string[]]$ArgsList) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:desktop
  $psi.Arguments = ((@('--expose-internals', $Entry) + $ArgsList | ForEach-Object { Quote-Argument $_ }) -join ' ')
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $utf8; $psi.StandardErrorEncoding = $utf8
  $psi.WorkingDirectory = $release
  $psi.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  $psi.EnvironmentVariables['DSH_HOME'] = $script:yunshuHome
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  try {
    if (-not $p.Start()) { throw 'Could not start the desktop CLI.' }
    $outTask = $p.StandardOutput.ReadToEndAsync(); $errTask = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    $stdout = $outTask.GetAwaiter().GetResult(); $stderr = $errTask.GetAwaiter().GetResult()
    if ($p.ExitCode -ne 0) { throw ('Desktop CLI failed (' + $p.ExitCode + '): ' + $stdout + $stderr) }
    if ($stderr.Trim()) { Write-Host $stderr.Trim() }
    return $stdout.Trim()
  } finally { $p.Dispose() }
}
function Invoke-DesktopCli([string[]]$CliArgs) { Invoke-BundledNode $script:cli $CliArgs }
function Invoke-YunshuConfig([string]$Mode) {
  Invoke-BundledNode (Join-Path $release 'configure.cjs') @($Mode, $script:cli, $script:yunshuHome, $release)
}
try {
  $script:desktop = Find-Desktop
  if ((Split-Path $desktop -Leaf) -ne 'DeepSeek Harness.exe') { throw 'Select DeepSeek Harness.exe, not another executable.' }
  $resources = Join-Path (Split-Path $desktop -Parent) 'resources'
  $archive = Join-Path $resources 'app.asar'
  if (Test-Path -LiteralPath $archive -PathType Leaf) { $runtime = Join-Path $archive 'dsh' } else { $runtime = Join-Path $resources 'app\dsh' }
  $script:cli = Join-Path $runtime 'node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
  if (-not (Test-Path -LiteralPath $archive) -and -not (Test-Path -LiteralPath $cli)) { throw 'The bundled desktop CLI is missing.' }
  $configuredHome = if (-not [string]::IsNullOrWhiteSpace($DshHome)) { $DshHome } else { $env:DSH_HOME }
  $userHome = [Environment]::GetFolderPath('UserProfile')
  if ([string]::IsNullOrWhiteSpace($configuredHome)) { $configuredHome = Join-Path $userHome '.dsh' }
  elseif ($configuredHome -eq '~') { $configuredHome = $userHome }
  elseif ($configuredHome.StartsWith('~/') -or $configuredHome.StartsWith('~\')) { $configuredHome = Join-Path $userHome $configuredHome.Substring(2) }
  $script:yunshuHome = [IO.Path]::GetFullPath($configuredHome)
  $version = Invoke-DesktopCli @('--version')
  if ($version -ne $manifest.hostVersion) { throw ('Supported desktop version: ' + $manifest.hostVersion + '; found: ' + $version + '. No files changed.') }
  $profile = Join-Path $yunshuHome 'profiles\desktop\package.json'
  if (-not (Test-Path -LiteralPath $profile -PathType Leaf)) { throw 'Open DeepSeek Harness once to initialize its desktop profile, then retry.' }
  $packages = @($manifest.packages)
  foreach ($package in $(if ($Action -eq 'Remove') { @() } else { $packages })) {
    if ([IO.Path]::GetFileName($package.file) -ne $package.file) { throw 'Invalid package filename.' }
    $path = Join-Path $release $package.file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (File-Sha256 $path) -ne $package.sha256) { throw ('Package missing or checksum failed: ' + $package.file) }
  }
  Write-Host ('Desktop: ' + $desktop + ' (' + $version + ')')
  Write-Host ('Data root: ' + $yunshuHome)
  Write-Host ('Components: ' + (($packages | ForEach-Object { $_.name }) -join ', '))
  if ($Action -ne 'Remove') { Write-Host (Invoke-YunshuConfig 'verify') }
  if ($Action -eq 'Check') { Write-Host 'Compatibility, profile, and archive checks passed. Nothing installed.'; exit 0 }
  Write-Host '请先退出 DeepSeek Harness。卸载保留个人数据和密钥。'
  if (-not $NoPrompt -and (Read-Host ('输入 YES 确认操作：' + $Action)) -cne 'YES') { Write-Host '已取消，未更改插件。'; exit 0 }
  if ($Action -eq 'Install') {
    # Stable tarball source: moving/deleting the received ZIP must not break pnpm.
    $cache = Join-Path $yunshuHome ('plugins\install-cache\yunshu\' + $manifest.version)
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $specs = @()
    foreach ($package in $packages) {
      $source = Join-Path $release $package.file; $dest = Join-Path $cache $package.file
      Copy-Item -LiteralPath $source -Destination $dest -Force
      if ((File-Sha256 $dest) -ne $package.sha256) { throw 'Cached package checksum failed.' }
      $specs += $dest
    }
    Write-Host (Invoke-DesktopCli (@('plugin', '--profile', 'desktop', 'add') + $specs))
    Write-Host (Invoke-YunshuConfig 'apply')
  } else {
    $profileData = Get-Content -LiteralPath $profile -Raw -Encoding UTF8 | ConvertFrom-Json
    $names = @($packages | ForEach-Object { $_.name } | Where-Object { $profileData.dependencies.PSObject.Properties.Name -contains $_ })
    if ($names.Count -gt 0) { Write-Host (Invoke-DesktopCli (@('plugin', '--profile', 'desktop', 'remove') + $names)) }
    else { Write-Host 'Selected plugins are not installed; no change needed.' }
  }
  $after = Get-Content -LiteralPath $profile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($package in $packages) {
    $installed = $after.dependencies.PSObject.Properties.Name -contains $package.name
    $selected = $after.dsh.profile.bundles -contains $package.name
    if ($Action -eq 'Install' -and (-not $installed -or -not $selected)) { throw ('Installation did not select bundle: ' + $package.name) }
    if ($Action -eq 'Remove' -and ($installed -or $selected)) { throw ('Removal did not remove bundle: ' + $package.name) }
  }
  Write-Host '操作完成。重新打开 DeepSeek Harness 后生效。'
  exit 0
} catch { Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
