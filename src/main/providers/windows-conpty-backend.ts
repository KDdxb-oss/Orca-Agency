import { release } from 'node:os'

export type WindowsConptyBackend = 'bundled' | 'system'

export function selectWindowsConptyBackend(input: {
  platform: NodeJS.Platform
  arch: string
  osRelease: string
  override?: string
}): WindowsConptyBackend {
  if (input.override === 'bundled' || input.override === 'system') {
    return input.override
  }
  const build = /^10\.0\.(\d+)/.exec(input.osRelease)?.[1]
  // Windows ARM64 build 26200 passes the system ConPTY wide-character checks.
  return input.platform === 'win32' &&
    input.arch === 'arm64' &&
    build !== undefined &&
    Number(build) >= 26200
    ? 'system'
    : 'bundled'
}

export function windowsConptySpawnOptions(): { useConptyDll: boolean } | Record<string, never> {
  if (process.platform !== 'win32') {
    return {}
  }
  return {
    useConptyDll:
      selectWindowsConptyBackend({
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        override: process.env.ORCA_WINDOWS_CONPTY_BACKEND
      }) === 'bundled'
  }
}
