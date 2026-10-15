$ErrorActionPreference = 'Stop'

function Get-ReviewedInstallProcesses([string] $Executable) {
  Get-CimInstance Win32_Process -Filter "Name = 'Orca.exe'" -ErrorAction Stop | Where-Object {
    [string]::Equals($_.ExecutablePath, $Executable, [StringComparison]::OrdinalIgnoreCase)
  }
}

function Test-ReviewedCrashReporter($Record) {
  return $Record.CommandLine -match '(?:^|\s)--type=crashpad-handler(?:\s|$)'
}

function Wait-ReviewedDesktopExclusiveUse([string] $Executable, [int] $DesktopId, [int] $Attempts = 20, [int] $DelayMs = 250) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    $foreign = @(Get-ReviewedInstallProcesses $Executable | Where-Object {
      -not (Test-ReviewedCrashReporter $_) -and $_.ProcessId -ne $DesktopId -and
      $_.ParentProcessId -ne $DesktopId
    })
    if (-not $foreign.Count) { return }
    if ($attempt + 1 -lt $Attempts) { Start-Sleep -Milliseconds $DelayMs }
  }
  $identities = ($foreign | ForEach-Object { "PID=$($_.ProcessId) parent=$($_.ParentProcessId) created=$($_.CreationDate)" }) -join '; '
  throw "Another process uses the installed executable; no desktop was closed. $identities"
}

function Test-ReviewedDesktopAbsent([string] $Executable) {
  # A leftover crash reporter has no application window and must not prevent recovery.
  return @(Get-ReviewedInstallProcesses $Executable | Where-Object {
    -not (Test-ReviewedCrashReporter $_)
  }).Count -eq 0
}

function Stop-ReviewedOrphanCrashReporters([string] $Executable, [int] $DesktopId, [object[]] $Captured) {
  if ($DesktopId -le 0) { return }
  $desktopProcess = Get-Process -Id $DesktopId -ErrorAction SilentlyContinue
  if ($desktopProcess) {
    # Windows can enumerate an exited process until its last retained handle is released.
    try { if (-not $desktopProcess.HasExited) { return } } finally { $desktopProcess.Dispose() }
  }
  $remaining = @(Get-ReviewedInstallProcesses $Executable)
  if (@($remaining | Where-Object { -not (Test-ReviewedCrashReporter $_) }).Count) { return }
  foreach ($record in $remaining) {
    $verified = @($Captured | Where-Object {
      $_.ProcessId -eq $record.ProcessId -and $_.ParentProcessId -eq $DesktopId -and
      $record.ParentProcessId -eq $DesktopId -and $_.CreationDate -eq $record.CreationDate -and
      (Test-ReviewedCrashReporter $_)
    })
    if ($verified.Count -ne 1 -or -not $record.CreationDate) { continue }
    $process = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    try {
      # Holding this handle and checking creation time prevents killing a reused PID.
      $null = $process.Handle
      $startTicks = $process.StartTime.ToUniversalTime().Ticks
      if (($startTicks - ($startTicks % 10)) -ne $record.CreationDate.ToUniversalTime().Ticks -or
        -not [string]::Equals($process.Path, $Executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $process.Kill()
      Write-Host "Closed orphan crash reporter PID $($record.ProcessId); desktop and terminals were not stopped."
    } finally { $process.Dispose() }
  }
}

function Wait-ReviewedDesktopClosed([string] $Executable, [int] $DesktopId, [object[]] $Captured, [int] $TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $capturedParents = @($DesktopId) + @($Captured | Select-Object -ExpandProperty ParentProcessId -Unique)
    foreach ($parentId in $capturedParents | Select-Object -Unique) {
      Stop-ReviewedOrphanCrashReporters $Executable $parentId $Captured
    }
    $remaining = @(Get-ReviewedInstallProcesses $Executable)
    if (-not $remaining.Count) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "Orca did not close within $TimeoutSeconds seconds; no installed app files were changed."
}

function Assert-ReviewedDesktopClosed([string] $Executable) {
  $running = @(Get-Process -Name Orca -ErrorAction SilentlyContinue | Where-Object {
    try { [string]::Equals($_.Path, $Executable, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
  if ($running.Count) { throw 'Orca reopened or is still running. Installed app files were not changed.' }
}

function Assert-ReviewedStagePath([string] $Stage, [string] $Target) {
  $stagePath = Get-ReviewedFullPath $Stage
  $targetPath = Get-ReviewedFullPath $Target
  $pattern = '^' + [regex]::Escape((Split-Path -Leaf $targetPath)) + '-stage-\d{8}-\d{6}-\d{3}$'
  if ((Split-Path -Parent $stagePath) -ne (Split-Path -Parent $targetPath) -or
    (Split-Path -Leaf $stagePath) -notmatch $pattern) { throw 'Staging directory is outside the installation parent.' }
  foreach ($root in @($stagePath, $targetPath)) {
    if (Test-Path -LiteralPath $root) {
      if ((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'App transaction roots must not be directory links.'
      }
    }
  }
}

function New-ReviewedAppStage([string] $Source, [string] $Target, [string] $Stage, [ref] $Created) {
  Assert-ReviewedStagePath $Stage $Target
  if (Test-Path -LiteralPath $Stage) { throw 'Staging directory already exists.' }
  foreach ($root in @($Source, $Target)) {
    if (Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object {
      $_.Attributes -band [IO.FileAttributes]::ReparsePoint
    } | Select-Object -First 1) { throw 'App trees containing links cannot be staged.' }
  }
  # Why: preserve the existing uninstaller and app-adjacent files without overwriting live binaries.
  New-Item -ItemType Directory -Path $Stage -ErrorAction Stop | Out-Null
  $Created.Value = $true
  foreach ($entry in Get-ChildItem -LiteralPath $Target -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $Stage -Recurse
  }
  foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination $Stage -Recurse -Force
  }
  foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
    $relative = $file.FullName.Substring($Source.TrimEnd('\').Length).TrimStart('\')
    if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne
      (Get-FileHash -LiteralPath (Join-Path $Stage $relative)).Hash) {
      throw "Staged file verification failed: $relative"
    }
  }
}

function Switch-ReviewedAppStage([string] $Stage, [string] $Target, [string] $Backup, [ref] $OriginalMoved = $null) {
  Assert-ReviewedStagePath $Stage $Target
  $backupPath = Get-ReviewedFullPath $Backup
  $pattern = '^' + [regex]::Escape((Split-Path -Leaf $Target)) + '-backup-\d{8}-\d{6}-\d{3}$'
  if ((Split-Path -Parent $backupPath) -ne (Split-Path -Parent $Target) -or
    (Split-Path -Leaf $backupPath) -notmatch $pattern -or (Test-Path -LiteralPath $backupPath)) {
    throw 'App backup must be a new sibling directory.'
  }
  # Why: each path always contains a complete app; never overwrite mapped files one by one.
  Move-ReviewedAppDirectory $Target $backupPath
  if ($OriginalMoved) { $OriginalMoved.Value = $true }
  try { Move-ReviewedAppDirectory $Stage $Target } catch {
    Move-ReviewedAppDirectory $backupPath $Target
    throw
  }
}

function Move-ReviewedAppDirectory([string] $Source, [string] $Destination) {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try { [IO.Directory]::Move($Source, $Destination); return } catch {
      if ($attempt -eq 9) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Remove-ReviewedAppStage([string] $Stage, [string] $Target) {
  Assert-ReviewedStagePath $Stage $Target
  if (-not (Test-Path -LiteralPath $Stage)) { return }
  if (Get-ChildItem -LiteralPath $Stage -Recurse -Force | Where-Object {
    $_.Attributes -band [IO.FileAttributes]::ReparsePoint
  } | Select-Object -First 1) { throw 'Preserving staging directory containing a link.' }
  Remove-Item -LiteralPath $Stage -Recurse -Force
}
