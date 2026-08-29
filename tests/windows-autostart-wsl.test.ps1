# Integration smoke test: requires WSL, but never registers tasks or starts myplan.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\start-local-windows.ps1')
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testDirectory = Join-Path $tempRoot ('myplan-hidden-wsl-' + [Guid]::NewGuid().ToString('N'))
try {
  $projectPath = Join-Path $testDirectory 'Plans & Notes\O''Brien $work'
  $scriptsPath = Join-Path $projectPath 'scripts'
  New-Item -ItemType Directory -Force -Path $scriptsPath | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\autostart\scripts\start-local-background.sh') -Destination $scriptsPath
  $logDirectory = Join-Path $testDirectory 'logs'
  $result = Invoke-MyplanWindowsLauncher -ProjectPath $projectPath -LogDirectory $logDirectory
  if ($result -ne 23) { throw "Expected WSL exit 23, got $result. Logs: $logDirectory" }
  $log = Get-Content -Raw -LiteralPath (Join-Path $logDirectory 'autostart.log')
  foreach ($expected in @('hidden-launcher-stdout', 'hidden-launcher-stderr', 'exit code 23')) {
    if (-not $log.Contains($expected)) { throw "Launcher log did not capture $expected." }
  }
  Write-Host 'Passed real hidden WSL launch, special-character paths, output capture and exit-code propagation.'
} finally {
  if (Test-Path -LiteralPath $testDirectory) {
    $resolved = (Resolve-Path -LiteralPath $testDirectory).ProviderPath
    if ($resolved -ne $testDirectory -or -not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing to clean up outside the exact temporary test directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
