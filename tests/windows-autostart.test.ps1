# Run with Windows PowerShell. Scheduled Task operations are mocked; nothing is registered.
$ErrorActionPreference = 'Stop'
$registrationScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\register-windows-autostart.ps1'))
$launcherScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\start-local-windows.ps1'))
. $launcherScript
$global:MyplanAutostartTestState = @{}

function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -cne $Expected) {
    throw "${Label}: expected '$Expected', got '$Actual'."
  }
}

function Split-Path {
  param([string]$Path, [switch]$Parent)
  return $global:MyplanAutostartTestState.ProjectPath
}

function wsl.exe {
  $global:MyplanAutostartTestState.WslArguments = @($args)
  $global:LASTEXITCODE = $global:MyplanAutostartTestState.ExitCode
  return $global:MyplanAutostartTestState.WslOutput
}

function New-ScheduledTaskAction {
  param([string]$Execute, [string]$Argument)
  return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument }
}

function New-ScheduledTaskTrigger {
  param([switch]$AtLogOn, [string]$User)
  return [pscustomobject]@{ Delay = ''; User = $User }
}

function New-ScheduledTaskSettingsSet {
  param($MultipleInstances, $RestartCount, $RestartInterval, $ExecutionTimeLimit,
    [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries)
  return [pscustomobject]@{
    MultipleInstances = $MultipleInstances
    RestartCount = $RestartCount
    ExecutionTimeLimit = $ExecutionTimeLimit
    StartWhenAvailable = [bool]$StartWhenAvailable
    AllowStartIfOnBatteries = [bool]$AllowStartIfOnBatteries
    DontStopIfGoingOnBatteries = [bool]$DontStopIfGoingOnBatteries
  }
}

function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Settings, $RunLevel, [switch]$Force)
  $global:MyplanAutostartTestState.RegisteredTask = [pscustomobject]@{
    Name = $TaskName
    Action = $Action
    Trigger = $Trigger
    RunLevel = $RunLevel
    Settings = $Settings
  }
}

$cases = @(
  @('C:\Users\a5125171\Desktop\ME\personal_planing', '/mnt/c/Users/a5125171/Desktop/ME/personal_planing'),
  @('C:\Users\LINH NGUYEN\Documents\personal_planing', '/mnt/c/Users/LINH NGUYEN/Documents/personal_planing'),
  @('D:\Plans & Notes\O''Brien $work\personal_planing', '/mnt/d/Plans & Notes/O''Brien $work/personal_planing')
)

foreach ($case in $cases) {
  $global:MyplanAutostartTestState.ProjectPath = $case[0]
  $global:MyplanAutostartTestState.WslOutput = $case[1]
  $global:MyplanAutostartTestState.ExitCode = 0
  $global:MyplanAutostartTestState.RegisteredTask = $null
  & $registrationScript -TaskName 'myplan-test' -DelaySeconds 5 | Out-Null
  Assert-Equal $global:MyplanAutostartTestState.WslArguments.Count 5 'WSL argument count'
  Assert-Equal ($global:MyplanAutostartTestState.WslArguments[0..3] -join ' ') '--exec wslpath -a -u' 'Direct WSL execution'
  Assert-Equal $global:MyplanAutostartTestState.WslArguments[4] $case[0] 'Literal Windows path'
  $task = $global:MyplanAutostartTestState.RegisteredTask
  Assert-Equal $task.Action.Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" 'Hidden PowerShell host'
  Assert-Equal $task.Action.Arguments ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $launcherScript) 'Scheduled command'
  Assert-Equal $task.Settings.MultipleInstances 'IgnoreNew' 'Do not duplicate the server'
  Assert-Equal $task.Settings.RestartCount 3 'Retry failed startup'
  Assert-Equal $task.Settings.ExecutionTimeLimit ([TimeSpan]::Zero) 'Long-running server'
  Assert-Equal $task.Settings.StartWhenAvailable $true 'Run missed logon trigger'
  Assert-Equal $task.Settings.AllowStartIfOnBatteries $true 'Start on battery'
  Assert-Equal $task.Settings.DontStopIfGoingOnBatteries $true 'Keep running when unplugged'
  $info = New-MyplanWslStartInfo $case[0]
  Assert-Equal $info.Arguments ('--cd "{0}" --exec bash scripts/start-local-background.sh' -f $case[0]) 'Literal WSL working directory'
  Assert-Equal $info.UseShellExecute $false 'No intermediate shell'
  Assert-Equal $info.CreateNoWindow $true 'No WSL console popup'
  Assert-Equal $info.WindowStyle ([Diagnostics.ProcessWindowStyle]::Hidden) 'Hidden window'
  Assert-Equal $info.RedirectStandardInput $true 'Keep noninteractive stdin open'
  Assert-Equal $info.RedirectStandardOutput $true 'Capture WSL errors'
  Assert-Equal $info.RedirectStandardError $true 'Capture WSL stderr'
  Assert-Equal $global:MyplanAutostartTestState.RegisteredTask.Name 'myplan-test' 'Task name'
  Assert-Equal $global:MyplanAutostartTestState.RegisteredTask.Trigger.Delay 'PT5S' 'Login delay'
  Assert-Equal $global:MyplanAutostartTestState.RegisteredTask.RunLevel 'Limited' 'Task privileges'
}

$failures = @(
  @{ Output = $null; ExitCode = 1; Expected = 'exit code 1' },
  @{ Output = '/mnt/c/partial'; ExitCode = 2; Expected = 'exit code 2' },
  @{ Output = $null; ExitCode = 0; Expected = 'no usable path' },
  @{ Output = '  '; ExitCode = 0; Expected = 'no usable path' },
  @{ Output = @('/mnt/c/one', '/mnt/c/two'); ExitCode = 0; Expected = 'no usable path' }
)

foreach ($case in $failures) {
  $global:MyplanAutostartTestState.WslOutput = $case.Output
  $global:MyplanAutostartTestState.ExitCode = $case.ExitCode
  $global:MyplanAutostartTestState.RegisteredTask = $null
  $failure = $null
  try { & $registrationScript | Out-Null } catch { $failure = $_.Exception.Message }
  if (-not $failure -or -not $failure.Contains($case.Expected)) {
    throw "Expected '$($case.Expected)' failure, got '$failure'."
  }
  Assert-Equal $global:MyplanAutostartTestState.RegisteredTask $null 'No task is registered after a conversion failure'
}

function Get-ScheduledTask {
  param($TaskName, $ErrorAction)
  return [pscustomobject]@{ State = 'Running'; Settings = [pscustomobject]@{ DisallowStartIfOnBatteries = $false } }
}
function Get-ScheduledTaskInfo {
  param($TaskName, $ErrorAction)
  return [pscustomobject]@{ LastRunTime = [DateTime]::Now; LastTaskResult = 267009 }
}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, $Uri, $TimeoutSec)
  Assert-Equal $Uri 'http://localhost:3000/' 'Check Windows localhost'
  Assert-Equal $TimeoutSec 10 'Bound status check'
  if ($global:MyplanAutostartTestState.HttpStatus -eq 0) { throw 'Connection timed out' }
  return [pscustomobject]@{ StatusCode = $global:MyplanAutostartTestState.HttpStatus }
}
function Test-Path { param($LiteralPath); return $false }

$statusScript = Join-Path $PSScriptRoot '..\scripts\status-local-windows.ps1'
foreach ($statusCode in @(200, 500, 0)) {
  $global:MyplanAutostartTestState.HttpStatus = $statusCode
  & $statusScript
  $expected = if ($statusCode -eq 200) { 0 } else { 1 }
  Assert-Equal $LASTEXITCODE $expected 'Only HTTP 200 is ready, even when task state is Running'
}

Write-Host 'Passed 11 Windows autostart/status regression cases. No Scheduled Tasks were changed.'
