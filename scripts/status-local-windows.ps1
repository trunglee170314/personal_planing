param([string]$TaskName = 'myplan-local')

$ErrorActionPreference = 'Stop'
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $lastRun = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
  Write-Host "Task: $($task.State)"
  Write-Host "Last run: $($lastRun.LastRunTime)"
  Write-Host ('Last task result: 0x{0:X8}' -f [long]$lastRun.LastTaskResult)
  Write-Host "Run on battery: $(-not $task.Settings.DisallowStartIfOnBatteries)"
} catch {
  Write-Host "Could not read task '$TaskName': $($_.Exception.Message)"
}

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/' -TimeoutSec 10
  if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
  Write-Host 'READY: http://localhost:3000/ returned HTTP 200 from Windows.'
  exit 0
} catch {
  Write-Host "NOT READY: http://localhost:3000/ did not return HTTP 200 within 10 seconds. $($_.Exception.Message)"
  Write-Host 'Task Running only means the launcher is alive, not that the web server is ready.'
  $logPath = Join-Path $env:LOCALAPPDATA 'myplan\autostart.log'
  if (Test-Path -LiteralPath $logPath) {
    Write-Host "Latest Windows launcher log ($logPath):"
    Get-Content -LiteralPath $logPath -Tail 15
  }
  Write-Host 'Read the current web startup attempt with:'
  Write-Host 'wsl.exe --exec bash -lc "tail -n 80 ~/.local/state/myplan/startup.log"'
  exit 1
}
