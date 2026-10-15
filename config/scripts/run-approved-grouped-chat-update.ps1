[CmdletBinding(SupportsShouldProcess)]
param([switch] $AuthorizedRestart)
$ErrorActionPreference = 'Stop'
$previewInstall = [bool]$WhatIfPreference
$WhatIfPreference = $false
$target = "$env:LOCALAPPDATA\Programs\orca"
$exe = Join-Path $target 'Orca.exe'
$toolchainRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'toolchain'
$installer = Join-Path $PSScriptRoot 'install-chat-sidebar-candidate.ps1'
$frozenManifestPath = Join-Path $PSScriptRoot 'chat-sidebar-final-package-manifest.json'
$frozenManifest = Get-Content -LiteralPath $frozenManifestPath -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'select-reviewed-orca-inspector.ps1')).Hash -ne $frozenManifest.rolloutInspectorSelectorSha256) {
    throw 'Reviewed inspector architecture selector hash mismatch.'
}
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ne $frozenManifest.rolloutScriptSha256) {
    throw 'Reviewed rollout script hash mismatch.'
}
$closeHelper = Join-Path $PSScriptRoot 'request-installed-orca-close.cjs'
if ((Get-FileHash -LiteralPath $closeHelper -Algorithm SHA256).Hash -ne $frozenManifest.rolloutCloseHelperSha256) {
    throw 'Reviewed close helper hash mismatch.'
}
$inspector = Join-Path $PSScriptRoot 'inspect-installed-orca-main.cjs'
if ((Get-FileHash -LiteralPath $inspector -Algorithm SHA256).Hash -ne $frozenManifest.rolloutInspectorSha256) {
    throw 'Reviewed inspector hash mismatch.'
}
$snapshotScript = Join-Path $PSScriptRoot 'snapshot-before-transaction.js'
if ((Get-FileHash -LiteralPath $snapshotScript -Algorithm SHA256).Hash -ne $frozenManifest.rolloutSnapshotSha256) {
    throw 'Reviewed pre-install snapshot hash mismatch.'
}
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $frozenManifest.installerWrapperSha256) {
    throw 'Reviewed installer wrapper hash mismatch.'
}
$desktopLifecycle = Join-Path $PSScriptRoot 'chat-sidebar-installer\install-reviewed-orca-transaction.ps1'
if ((Get-FileHash -LiteralPath $desktopLifecycle).Hash -ne $frozenManifest.installerFiles.'install-reviewed-orca-transaction.ps1') {
    throw 'Reviewed desktop lifecycle hash mismatch.'
}
. $desktopLifecycle
. (Join-Path $PSScriptRoot 'select-reviewed-orca-inspector.ps1')
$node = Get-ReviewedInspectorNode $exe $toolchainRoot $frozenManifest.rolloutInspectorNodeSha256

function Start-IndependentOrca {
    param([string] $ExpectedVersion = [string]$frozenManifest.packageVersion)
    $restartNode = Get-ReviewedInspectorNode $exe $toolchainRoot $frozenManifest.rolloutInspectorNodeSha256
    # WMI keeps the restart outside this terminal's kill-on-close job.
    $launch = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = '"' + $exe + '" --orca-main-thread-diagnostics --remote-debugging-address=127.0.0.1 --remote-debugging-port=19387'
        CurrentDirectory = $target
    }
    if ($launch.ReturnValue -ne 0) { throw "Desktop restart failed with Windows result $($launch.ReturnValue). App files remain intact." }
    Start-Sleep -Seconds 2
    $started = Get-Process -Id $launch.ProcessId -ErrorAction SilentlyContinue
    if (-not $started) { throw 'Desktop restart exited before verification.' }
    try {
        if (-not [string]::Equals($started.Path, $exe, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Desktop restart process did not match the installed executable.'
        }
    } finally { $started.Dispose() }
    $restartedIdentity = $null
    $identityDeadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $identityDeadline) {
        # Electron may not accept the debug signal immediately after Windows creates it.
        try { & $restartNode -e 'process._debugProcess(Number(process.argv[1]))' $launch.ProcessId 2>$null } catch {
            # Windows PowerShell can promote early native stderr to a terminating error.
        }
        try { $identityJson = & $restartNode $inspector 2>$null } catch { $identityJson = $null }
        if ($LASTEXITCODE -eq 0 -and $identityJson) {
            $restartedIdentity = ($identityJson | ConvertFrom-Json).result.result.value
            if ($restartedIdentity.pid -eq $launch.ProcessId -and
                [string]::Equals($restartedIdentity.exe, $exe, [StringComparison]::OrdinalIgnoreCase) -and
                $restartedIdentity.version -eq $ExpectedVersion -and
                [string]::Equals($restartedIdentity.userData, (Join-Path $env:APPDATA 'orca'), [StringComparison]::OrdinalIgnoreCase) -and
                @($restartedIdentity.windows | Where-Object { $_.visible -and -not $_.destroyed -and $_.url -match '/out/renderer/index\.html$' }).Count) { break }
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $restartedIdentity -or $restartedIdentity.pid -ne $launch.ProcessId -or
        -not [string]::Equals($restartedIdentity.exe, $exe, [StringComparison]::OrdinalIgnoreCase) -or
        $restartedIdentity.version -ne $ExpectedVersion -or
        -not [string]::Equals($restartedIdentity.userData, (Join-Path $env:APPDATA 'orca'), [StringComparison]::OrdinalIgnoreCase) -or
        -not @($restartedIdentity.windows | Where-Object { $_.visible -and -not $_.destroyed -and $_.url -match '/out/renderer/index\.html$' }).Count) {
        Write-Warning ('Restart identity was not proven: ' + (@{expectedPid=$launch.ProcessId; expectedVersion=$ExpectedVersion; observed=$restartedIdentity} | ConvertTo-Json -Depth 6 -Compress))
        $restartReporters = @(Get-ReviewedInstallProcesses $exe | Where-Object { Test-ReviewedCrashReporter $_ })
        $env:ORCA_DESKTOP_QUIT_PID = [string]$launch.ProcessId
        $env:ORCA_CLOSE_THROUGH_MAIN_PROCESS = '1'
        & $node $closeHelper
        if ($LASTEXITCODE -ne 0) { throw 'Restart profile verification failed, and graceful recovery close failed. Complete app backups remain intact.' }
        Wait-ReviewedDesktopClosed $exe $launch.ProcessId $restartReporters
        throw 'Restart used a different profile or could not prove its identity. Recovering the previous complete app.'
    }
    Write-Host "Started independent Orca desktop PID $($launch.ProcessId)."
}

if ($previewInstall) {
    & $installer -WhatIf
    Write-Output 'Package preview passed. Installation requires an authorized desktop restart.'
    return
}

if (-not $AuthorizedRestart) {
    throw 'Pass AuthorizedRestart only after the reviewed package is ready and Brooks has authorized this desktop restart.'
}
$installationPolicyPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'automation\installation-policy.json'
if (Test-Path -LiteralPath $installationPolicyPath) {
    $installationPolicy = Get-Content -LiteralPath $installationPolicyPath -Raw | ConvertFrom-Json
    $candidateHold = $installationPolicy.currentManualCandidateHold
    if ($candidateHold.requiresNewGoAhead -and (
        $candidateHold.packageVersion -eq $frozenManifest.packageVersion -or
        ($candidateHold.appliesToSupersedingCandidates -and
         [version]$frozenManifest.packageVersion -ge [version]$candidateHold.packageVersion))) {
        throw 'Brooks paused this candidate installation. Record his new go-ahead before closing or changing Orca.'
    }
}
$desktops = @(Get-Process -Name Orca -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $exe -and $_.MainWindowHandle -ne 0
})
if ($desktops.Count -ne 1) { throw 'Expected exactly one installed Orca desktop before inventory.' }
$inspectedDesktopId = $desktops[0].Id
$desktops[0].Dispose()
& $node -e 'process._debugProcess(Number(process.argv[1]))' $inspectedDesktopId
if ($LASTEXITCODE -ne 0) { throw 'Could not enable the installed desktop inspector; no files changed.' }
$inspectedIdentity = $null
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try { $identityJson = & $node $inspector 2>$null } catch { $identityJson = $null }
    if ($LASTEXITCODE -eq 0 -and $identityJson) {
        $inspectedIdentity = ($identityJson | ConvertFrom-Json).result.result.value
        break
    }
    Start-Sleep -Milliseconds 500
}
if (-not $inspectedIdentity -or $inspectedIdentity.pid -ne $inspectedDesktopId -or
    -not [string]::Equals($inspectedIdentity.exe, $exe, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Inspector identity differs from the installed desktop; no files changed.'
}
if (-not [string]::Equals($inspectedIdentity.userData, (Join-Path $env:APPDATA 'orca'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installed desktop uses a different profile; no files changed.'
}

Start-Transcript -Path (Join-Path $PSScriptRoot 'approved-grouped-chat-update.log') -Force | Out-Null
$priorExeHash = (Get-FileHash -LiteralPath $exe).Hash
$priorAsarHash = (Get-FileHash -LiteralPath (Join-Path $target 'resources\app.asar')).Hash
$closeState = @{ Requested = $false }
try {
    $supportBuilds = $PSScriptRoot
    $closeAfterStaging = {
    $snapshotJson = & $node $inspector --file $snapshotScript
    if ($LASTEXITCODE -ne 0) { throw 'Pre-install inventory failed; installed app remains untouched.' }
    $snapshot = ($snapshotJson | ConvertFrom-Json).result.result.value
    if (-not $snapshot.ptys -or -not $snapshot.tabs) { throw 'Incomplete terminal inventory; installed app remains untouched.' }
    $snapshot | Add-Member -NotePropertyName phase -NotePropertyValue 'before'
    $snapshot | Add-Member -NotePropertyName at -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o')
    [IO.File]::WriteAllText((Join-Path $supportBuilds 'grouped-chat-before-install.json'), ($snapshot | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding($false)))
    $desktop = Get-Process -Name Orca -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $desktop) { throw 'Expected Orca desktop was not found; installed app remains untouched.' }
    $desktopId = $desktop.Id
    $desktop.Dispose()
    if ($desktopId -ne $inspectedDesktopId) { throw 'Desktop changed after inventory; installed files remain untouched.' }
    $crashReporters = @(Get-ReviewedInstallProcesses $exe | Where-Object {
        Test-ReviewedCrashReporter $_
    })
    Wait-ReviewedDesktopExclusiveUse $exe $desktopId
    $env:ORCA_CLOSE_THROUGH_MAIN_PROCESS = '1'
    Write-Host 'Using the PID-verified main-process close route.'
    $env:ORCA_DESKTOP_QUIT_PID = [string]$desktopId
    Write-Host 'Staging is verified. Closing Orca now; it will reopen after the directory switch.'
    $closeState.Requested = $true
    & $node $closeHelper
    if ($LASTEXITCODE -ne 0) { throw 'The graceful close request failed; no app files were changed.' }
    Wait-ReviewedDesktopClosed $exe $desktopId $crashReporters
    }
    $verifyAndRestart = {
        foreach ($file in @(@{Path='Orca.exe';Hash=$frozenManifest.exeSha256}, @{Path='resources\app.asar';Hash=$frozenManifest.asarSha256})) {
            if ((Get-FileHash -LiteralPath (Join-Path $target $file.Path) -Algorithm SHA256).Hash -ne $file.Hash) {
                throw "Installed hash mismatch: $($file.Path)"
            }
        }
        Start-IndependentOrca
    }
    & $installer -WhatIf
    $packageDirectory = [string]$frozenManifest.packageDirectory
    if ($packageDirectory -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $packageDirectory.Contains('..')) {
        throw 'Frozen package directory is invalid; no desktop was closed.'
    }
    $frozenPackageRoot = Join-Path (Join-Path $PSScriptRoot $packageDirectory) 'win-unpacked'
    foreach ($file in @(@{Path='Orca.exe';Hash=$frozenManifest.exeSha256}, @{Path='resources\app.asar';Hash=$frozenManifest.asarSha256})) {
        if ((Get-FileHash -LiteralPath (Join-Path $frozenPackageRoot $file.Path)).Hash -ne $file.Hash) {
            throw "Frozen package hash mismatch: $($file.Path); no desktop was closed."
        }
    }
    Get-ReviewedInspectorNode (Join-Path $frozenPackageRoot 'Orca.exe') $toolchainRoot $frozenManifest.rolloutInspectorNodeSha256 | Out-Null
    & $installer -BeforeReplace $closeAfterStaging -AfterReplace $verifyAndRestart
    [ordered]@{
        installedAt=(Get-Date).ToUniversalTime().ToString('o')
        sourceCommit=$frozenManifest.commit
        exeSha256=$frozenManifest.exeSha256
        asarSha256=$frozenManifest.asarSha256
        profileMigration='Existing profile retained; app applies its versioned migrations'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'installed-grouped-chat-update-receipt.json') -Encoding utf8
} catch {
    for ($attempt = 0; $closeState.Requested -and $attempt -lt 45; $attempt++) {
        if (Test-ReviewedDesktopAbsent $exe) { break }
        Start-Sleep -Seconds 1
    }
    $priorAppIntact = (Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath (Join-Path $target 'resources\app.asar')) -and
        (Get-FileHash -LiteralPath $exe).Hash -eq $priorExeHash -and
        (Get-FileHash -LiteralPath (Join-Path $target 'resources\app.asar')).Hash -eq $priorAsarHash
    if ($priorAppIntact -and (Test-ReviewedDesktopAbsent $exe)) {
        Start-IndependentOrca -ExpectedVersion ([string]$inspectedIdentity.version)
    }
    throw
} finally {
    Remove-Item Env:ORCA_DESKTOP_QUIT_PID -ErrorAction SilentlyContinue
    Remove-Item Env:ORCA_CLOSE_THROUGH_MAIN_PROCESS -ErrorAction SilentlyContinue
    Stop-Transcript | Out-Null
}
