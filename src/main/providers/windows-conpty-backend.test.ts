import { describe, expect, it } from 'vitest'
import { selectWindowsConptyBackend } from './windows-conpty-backend'

const windowsArm = {
  platform: 'win32' as const,
  arch: 'arm64',
  osRelease: '10.0.26200'
}

describe('selectWindowsConptyBackend', () => {
  it('uses the system backend on the verified recent Windows ARM64 build', () => {
    expect(selectWindowsConptyBackend(windowsArm)).toBe('system')
  })

  it('keeps the bundled backend on older ARM64 builds and x64', () => {
    expect(selectWindowsConptyBackend({ ...windowsArm, osRelease: '10.0.26199' })).toBe('bundled')
    expect(selectWindowsConptyBackend({ ...windowsArm, arch: 'x64' })).toBe('bundled')
  })

  it('does not assume an unknown Windows version supports the system backend', () => {
    expect(selectWindowsConptyBackend({ ...windowsArm, osRelease: 'unknown' })).toBe('bundled')
  })

  it('accepts an explicit backend for comparison or rollback', () => {
    expect(selectWindowsConptyBackend({ ...windowsArm, override: 'bundled' })).toBe('bundled')
    expect(
      selectWindowsConptyBackend({ ...windowsArm, osRelease: '10.0.19041', override: 'system' })
    ).toBe('system')
  })
})
