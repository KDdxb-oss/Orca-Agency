function Get-ReviewedInspectorNode([string] $Executable, [string] $ToolchainRoot, $ExpectedHashes) {
    $stream = [IO.File]::Open($Executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Inspector target is not a Windows executable.' }
        $stream.Position = 0x3C
        $header = $reader.ReadUInt32()
        if ($header -gt ($stream.Length - 6)) { throw 'Inspector target has an invalid PE header.' }
        $stream.Position = $header
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Inspector target has an invalid PE signature.' }
        $machine = $reader.ReadUInt16()
    } finally { $reader.Dispose() }
    $architecture = switch ($machine) {
        0xAA64 { 'arm64' }
        0x8664 { 'x64' }
        default { throw "Unsupported inspector target architecture: $machine" }
    }
    # Windows debug signaling requires Node to match the target process architecture.
    $nodePath = Join-Path $ToolchainRoot "node-v24.14.0-win-$architecture\node.exe"
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        throw "Pinned $architecture inspector Node is missing; preserve the existing desktop."
    }
    $expectedHash = [string]$ExpectedHashes.$architecture
    if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$' -or
        (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash -ne $expectedHash) {
        throw "Pinned $architecture inspector Node checksum mismatch; preserve the existing desktop."
    }
    return $nodePath
}
