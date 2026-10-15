import { describe, expect, it } from 'vitest'
import { hasCompatibleDesktopUpdateFeed } from './windows-arm64-update-policy'

describe('Windows ARM64 desktop update feed', () => {
  it('refuses the existing Windows x64 feed only for the native Windows ARM64 app', () => {
    expect(hasCompatibleDesktopUpdateFeed('win32', 'arm64')).toBe(false)
    expect(hasCompatibleDesktopUpdateFeed('win32', 'x64')).toBe(true)
    expect(hasCompatibleDesktopUpdateFeed('darwin', 'arm64')).toBe(true)
    expect(hasCompatibleDesktopUpdateFeed('linux', 'arm64')).toBe(true)
  })
})
