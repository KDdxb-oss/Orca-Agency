$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-reviewed-orca-transaction.ps1')
$exe = 'C:\Fixture\orca\Orca.exe'
$stamp = [datetime]'2026-10-01T11:00:00Z'
$script:records = @()
$script:handles = @{}
$script:killed = @()
$script:checks = 0
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $script:records }
function Get-Process {
  param($Id, $Name, $ErrorAction)
  if ($null -ne $Id) { return $script:handles[[int]$Id] }
  return @($script:handles.Values)
}
function New-Record([int] $Id, [int] $Parent, [string] $Command = '--type=crashpad-handler', [string] $Path = $exe) {
  return [pscustomobject]@{ ProcessId=$Id; ParentProcessId=$Parent; CommandLine=$Command; ExecutablePath=$Path; CreationDate=$stamp }
}
function New-Handle([int] $Id, [string] $Path = $exe) {
  $handle = [pscustomobject]@{ Id=$Id; Path=$Path; StartTime=$stamp; Handle=100; HasExited=$false }
  $handle | Add-Member ScriptMethod Kill { $script:killed += $this.Id }
  $handle | Add-Member ScriptMethod Dispose {}
  return $handle
}
function Assert-Check([bool] $Condition, [string] $Name) {
  if (-not $Condition) { throw "FAIL $Name" }
  $script:checks++
  Write-Host "PASS $Name"
}
function Reset-Fixture {
  $script:records = @(New-Record 20 10)
  $script:handles = @{ 20=(New-Handle 20) }
  $script:killed = @()
}
Reset-Fixture
$captured = @(New-Record 20 10)
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed -contains 20) 'verified orphan reporter is closed'
Assert-Check (Test-ReviewedDesktopAbsent $exe) 'orphan reporter does not block reopening the unchanged app'

Reset-Fixture
$script:handles[20].StartTime = $stamp.AddTicks(5)
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed -contains 20) 'CIM microsecond truncation still matches the same process'

Reset-Fixture
$script:handles[10] = New-Handle 10
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 0) 'live original desktop protects its reporter'

Reset-Fixture
$script:handles[10] = New-Handle 10
$script:handles[10].HasExited = $true
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed -contains 20) 'exited desktop retained by a process handle does not block orphan cleanup'

Reset-Fixture
$script:records += New-Record 30 5 'Orca.exe'
$script:handles[30] = New-Handle 30
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 0) 'reopened desktop prevents reporter cleanup'
Assert-Check (-not (Test-ReviewedDesktopAbsent $exe)) 'recovery does not launch a duplicate desktop'

Reset-Fixture
$script:records[0].CreationDate = $stamp.AddSeconds(1)
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 0) 'reused process ID with changed creation time is preserved'

Reset-Fixture
$script:handles[20].StartTime = $stamp.AddSeconds(1)
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 0) 'handle identity is rechecked before termination'

Reset-Fixture
$script:records[0].ParentProcessId = 99
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 0) 'another desktop reporter is preserved'

Reset-Fixture
Stop-ReviewedOrphanCrashReporters $exe 10 @()
Assert-Check ($script:killed.Count -eq 0) 'uncaptured reporters are preserved'

foreach ($command in @('--type=renderer', '--type=crashpad-handler-extra', 'daemon-entry.js', $null)) {
  Reset-Fixture
  $script:records[0].CommandLine = $command
  Stop-ReviewedOrphanCrashReporters $exe 10 $captured
  Assert-Check ($script:killed.Count -eq 0) "non-reporter or unknown command is preserved: $command"
}

Reset-Fixture
$script:records += New-Record 40 1 'daemon-entry.js' 'C:\Fixture\daemon-host\Orca.exe'
$script:handles[40] = New-Handle 40 'C:\Fixture\daemon-host\Orca.exe'
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 1 -and $script:killed[0] -eq 20) 'relocated terminal daemon is outside cleanup scope'

Reset-Fixture
$script:records[0].ExecutablePath = 'C:\Other\Orca.exe'
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 0) 'another installation is outside cleanup scope'

Reset-Fixture
$script:handles[20].Path = 'C:\Other\Orca.exe'
Stop-ReviewedOrphanCrashReporters $exe 10 $captured
Assert-Check ($script:killed.Count -eq 0) 'handle path is rechecked before termination'

Reset-Fixture
$script:records[0].CommandLine = 'Orca.exe'
$timedOut = $false
try { Wait-ReviewedDesktopClosed $exe 10 $captured 0 } catch { $timedOut = $_ -like '*did not close*' }
Assert-Check ($timedOut -and $script:killed.Count -eq 0) 'remaining desktop aborts installation without force shutdown'

$script:records = @()
Wait-ReviewedDesktopClosed $exe 10 $captured 0
Assert-Check $true 'empty installation process table permits the directory transaction'
Reset-Fixture
$script:records = @(New-Record 20 99)
$olderCaptured = @($script:records)
$script:handles[20] | Add-Member ScriptMethod Kill {
  $script:killed += $this.Id
  $script:records = @($script:records | Where-Object { $_.ProcessId -ne $this.Id })
} -Force
Wait-ReviewedDesktopClosed $exe 10 $olderCaptured 0
Assert-Check ($script:killed -contains 20) 'captured reporter from a previous exited desktop does not block installation'
Reset-Fixture
$script:records = @(New-Record 20 99)
$olderCaptured = @($script:records)
$script:handles[99] = New-Handle 99
$timedOut = $false
try { Wait-ReviewedDesktopClosed $exe 10 $olderCaptured 0 } catch { $timedOut = $_ -like '*did not close*' }
Assert-Check ($timedOut -and $script:killed.Count -eq 0) 'a previous reporter with a live parent stays protected'

$script:records = @((New-Record 10 1 'Orca.exe'), (New-Record 30 10 '--type=renderer'))
Wait-ReviewedDesktopExclusiveUse $exe 10 1 0
Assert-Check $true 'original desktop and direct children pass exclusive-use guard'
$script:records += New-Record 40 30 'Orca.exe'
$script:enumerations = 0
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $script:enumerations++
  if ($script:enumerations -eq 2) { $script:records = @($script:records | Where-Object { $_.ProcessId -ne 40 }) }
  return $script:records
}
Wait-ReviewedDesktopExclusiveUse $exe 10 3 0
Assert-Check ($script:enumerations -eq 2) 'transient installed helper exits before unchanged exclusive-use guard passes'
$script:records += New-Record 50 1 'Orca.exe'
$script:enumerations = 0
$blocked = $false
try { Wait-ReviewedDesktopExclusiveUse $exe 10 3 0 } catch { $blocked = $_ -like '*PID=50 parent=1*' }
Assert-Check ($blocked -and $script:enumerations -eq 3 -and $script:killed.Count -eq 0) 'persistent foreign process aborts with identity and without termination'
Write-Host "$script:checks checks passed. No real processes were modified."
