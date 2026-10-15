import { describe, expect, it } from 'vitest'
import {
  resolveCodexReplacementResumeLaunch,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv,
  type PreparedCodexResumeHome
} from './codex-resume'

const providerSession = { key: 'session_id' as const, id: 'exact-session' }
const command = "codex '--model' 'current-model' 'resume' 'exact-session'"

function resume(home: string): PreparedCodexResumeHome {
  return {
    providerSession,
    preparation: Promise.resolve({ outcome: 'resume', codexHomePath: home })
  }
}

describe('Codex replacement account and home selection', () => {
  it('resumes exactly when the verified home matches the current selection', async () => {
    const launch = await resolveCodexReplacementResumeLaunch({
      command,
      prepared: resume('C:/Users/test/.codex'),
      resolveLaunch: resolveCodexResumeLaunch,
      resolveCurrentHome: async () => 'c:\\users\\test\\.codex'
    })
    expect(launch.command).toBe(command)
    expect(launch.codexResumeHome?.codexHomePath).toBe('C:/Users/test/.codex')
    expect(launch.notifyResumeUnavailable).toBe(false)
  })

  it('does not silently retain a previous account when no restart notice was supplied', async () => {
    const launch = await resolveCodexReplacementResumeLaunch({
      command,
      prepared: resume('/accounts/previous'),
      resolveLaunch: resolveCodexResumeLaunch,
      resolveCurrentHome: async () => '/accounts/selected'
    })
    expect(launch.command).toBe("codex '--model' 'current-model'")
    expect(launch.codexResumeHome).toBeNull()
    expect(launch.notifyResumeUnavailable).toBe(true)
    expect(
      stripSequencedStartupResumeArgv({ ORCA_SEQUENCED_STARTUP_COMMAND: command }, launch)
    ).toEqual({ ORCA_SEQUENCED_STARTUP_COMMAND: "codex '--model' 'current-model'" })
  })

  it('starts fresh when origin-home preparation refuses a replacement', async () => {
    const launch = await resolveCodexReplacementResumeLaunch({
      command,
      prepared: { providerSession, preparation: Promise.reject(new Error('Origin unavailable')) },
      resolveLaunch: resolveCodexResumeLaunch,
      resolveCurrentHome: async () => '/accounts/selected'
    })
    expect(launch.command).toBe("codex '--model' 'current-model'")
    expect(launch.codexResumeHome).toBeNull()
    expect(launch.notifyResumeUnavailable).toBe(true)
  })

  it('does not rewrite an ordinary saved-chat resume into the current account', async () => {
    const launch = await resolveCodexResumeLaunch(command, resume('/accounts/origin'))
    expect(launch.command).toBe(command)
    expect(launch.codexResumeHome?.codexHomePath).toBe('/accounts/origin')
  })

  it('refuses an unstrippable claimed resume rather than crossing accounts', async () => {
    await expect(
      resolveCodexReplacementResumeLaunch({
        command: 'wrapper --resume-something exact-session',
        prepared: resume('/accounts/previous'),
        resolveLaunch: resolveCodexResumeLaunch,
        resolveCurrentHome: async () => '/accounts/selected'
      })
    ).rejects.toThrow('could not verify')
  })
})
