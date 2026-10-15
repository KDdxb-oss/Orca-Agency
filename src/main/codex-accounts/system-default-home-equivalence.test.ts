import { describe, expect, it } from 'vitest'
import { isSystemDefaultCodexHomeEquivalent } from './system-default-home-equivalence'
import {
  resolveCodexReplacementResumeLaunch,
  resolveCodexResumeLaunch
} from '../ipc/pty/host-env/codex-resume'

const defaultHomes = {
  target: { runtime: 'host' as const },
  settings: { activeCodexManagedAccountId: null },
  hasCustomHome: false,
  verifiedHome: 'C:/Users/test/.codex',
  currentHome: 'C:/Orca/codex-runtime-home/home',
  systemHome: 'C:/Users/test/.codex',
  sharedHome: 'C:/Orca/codex-runtime-home/home'
}

describe('system-default Codex replacement home equivalence', () => {
  it('retains exact trusted system conversation when Windows launches on the default mirror', async () => {
    const command = 'codex resume exact-conversation'
    const launch = await resolveCodexReplacementResumeLaunch({
      command,
      prepared: {
        providerSession: { key: 'session_id', id: 'exact-conversation' },
        preparation: Promise.resolve({ outcome: 'resume', codexHomePath: defaultHomes.systemHome })
      },
      resolveLaunch: resolveCodexResumeLaunch,
      resolveCurrentHome: async () => defaultHomes.currentHome,
      isEquivalentDefaultHome: (verifiedHome, currentHome) =>
        isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, verifiedHome, currentHome })
    })
    expect(launch.command).toBe(command)
    expect(launch.codexResumeHome?.codexHomePath).toBe(defaultHomes.systemHome)
    expect(launch.notifyResumeUnavailable).toBe(false)
  })

  it('accepts Windows case and separator aliases', () => {
    expect(
      isSystemDefaultCodexHomeEquivalent({
        ...defaultHomes,
        verifiedHome: 'c:\\users\\test\\.codex',
        currentHome: 'c:\\orca\\codex-runtime-home\\home'
      })
    ).toBe(true)
  })

  it('refuses selected managed accounts and custom homes', () => {
    expect(
      isSystemDefaultCodexHomeEquivalent({
        ...defaultHomes,
        settings: { activeCodexManagedAccountId: 'other' }
      })
    ).toBe(false)
    expect(
      isSystemDefaultCodexHomeEquivalent({
        ...defaultHomes,
        settings: {
          activeCodexManagedAccountId: null,
          activeCodexManagedAccountIdsByRuntime: { host: 'other', wsl: {} }
        }
      })
    ).toBe(false)
    expect(isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, hasCustomHome: true })).toBe(false)
  })

  it('refuses unknown settings, non-default origins and non-host runtimes', () => {
    expect(isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, settings: undefined })).toBe(false)
    expect(
      isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, verifiedHome: 'C:/accounts/other' })
    ).toBe(false)
    expect(
      isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, currentHome: 'C:/accounts/other' })
    ).toBe(false)
    expect(isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, currentHome: null })).toBe(false)
    expect(
      isSystemDefaultCodexHomeEquivalent({
        ...defaultHomes,
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      })
    ).toBe(false)
  })

  it('leaves the mirror origin and real-home comparison on their existing equality path', () => {
    expect(
      isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, verifiedHome: defaultHomes.sharedHome })
    ).toBe(false)
    expect(
      isSystemDefaultCodexHomeEquivalent({ ...defaultHomes, currentHome: defaultHomes.systemHome })
    ).toBe(false)
  })

  it('drops a verified resume when the current selection is a managed account', async () => {
    const launch = await resolveCodexReplacementResumeLaunch({
      command: 'codex resume exact-conversation',
      prepared: {
        providerSession: { key: 'session_id', id: 'exact-conversation' },
        preparation: Promise.resolve({ outcome: 'resume', codexHomePath: defaultHomes.systemHome })
      },
      resolveLaunch: resolveCodexResumeLaunch,
      resolveCurrentHome: async () => defaultHomes.currentHome,
      isEquivalentDefaultHome: (verifiedHome, currentHome) =>
        isSystemDefaultCodexHomeEquivalent({
          ...defaultHomes,
          settings: { activeCodexManagedAccountId: 'other' },
          verifiedHome,
          currentHome
        })
    })
    expect(launch.command).toBe('codex')
    expect(launch.codexResumeHome).toBe(null)
    expect(launch.notifyResumeUnavailable).toBe(true)
  })
})
