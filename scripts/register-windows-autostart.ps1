param(
  [string]$TaskName = 'myplan-local',
  [ValidateRange(0, 3600)]
  [int]$DelaySeconds = 30
)

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
# --exec bypasses the default Linux shell, which would consume Windows backslashes.
$wslPathOutput = @(& wsl.exe --exec wslpath -a -u $projectPath)
$wslExitCode = $LASTEXITCODE

if ($wslExitCode -ne 0) {
  throw "Unable to convert the project path for WSL (exit code $wslExitCode). Check that your default WSL distribution starts correctly."
}

if ($wslPathOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$wslPathOutput[0])) {
  throw 'Unable to convert the project path for WSL: wslpath returned no usable path.'
}

# PowerShell hides its own window; the launcher also prevents WSL from creating one.
$launcherPath = Join-Path $PSScriptRoot 'start-local-windows.ps1'
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`""

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = "PT${DelaySeconds}S"
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null
Write-Host "Registered '$TaskName'. myplan will start hidden in WSL after Windows sign-in, including on battery power."
Write-Host 'Registration does not start the web server now. Use schtasks /Run /TN myplan-local to start it.'
Write-Host 'Check readiness: powershell.exe -NoProfile -File .\scripts\status-local-windows.ps1'
Write-Host "Windows launcher log: $env:LOCALAPPDATA\myplan\autostart.log"
Write-Host "Web startup log: `$HOME/.local/state/myplan/startup.log inside WSL"
