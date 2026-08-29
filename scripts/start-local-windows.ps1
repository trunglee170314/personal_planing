# The Scheduled Task waits for this supervisor, which in turn waits for WSL.
# Do not detach WSL: its exit code is needed for Task Scheduler's retry policy.
$ErrorActionPreference = 'Stop'

function New-MyplanWslStartInfo([string]$ProjectPath) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = "$env:SystemRoot\System32\wsl.exe"
  $info.Arguments = "--cd `"$ProjectPath`" --exec bash scripts/start-local-background.sh"
  $info.WorkingDirectory = $ProjectPath
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  # Keep stdin open even though this task has no interactive console.
  $info.RedirectStandardInput = $true
  return $info
}

function Invoke-MyplanWindowsLauncher {
  param(
    [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),
    [string]$LogDirectory = (Join-Path $env:LOCALAPPDATA 'myplan')
  )
  New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
  $logPath = Join-Path $LogDirectory 'autostart.log'
  $process = $null
  try {
    Add-Content -LiteralPath $logPath -Value "`n[$(Get-Date -Format o)] Starting hidden WSL launcher for $ProjectPath"
    $info = New-MyplanWslStartInfo $ProjectPath
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'WSL could not be started.' }
    Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] WSL process started (PID $($process.Id)); waiting for web startup."
    # Drain both pipes concurrently to avoid deadlocking if WSL reports an error.
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    foreach ($output in @($stdout.GetAwaiter().GetResult(), $stderr.GetAwaiter().GetResult())) {
      if (-not [string]::IsNullOrWhiteSpace($output)) {
        Add-Content -LiteralPath $logPath -Value $output
      }
    }
    $exitCode = $process.ExitCode
    Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] WSL stopped (exit code $exitCode)."
    return $exitCode
  } catch {
    Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] Launcher failed: $($_.Exception.Message)"
    return 1
  } finally {
    if ($null -ne $process) {
      $process.Dispose()
    }
  }
}

# Dot-sourcing exposes the side-effect-free start-info helper to regression tests.
if ($MyInvocation.InvocationName -ne '.') {
  exit (Invoke-MyplanWindowsLauncher)
}
