import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveAiVaultSessionTitlesInBackground = vi.hoisted(() => vi.fn())
vi.mock('./session-scanner-background', () => ({ resolveAiVaultSessionTitlesInBackground }))

const { resolveLocalAiVaultSessionTitles } = await import('./session-title-resolver')

describe('resolveLocalAiVaultSessionTitles', () => {
  beforeEach(() => {
    resolveAiVaultSessionTitlesInBackground.mockReset()
    resolveAiVaultSessionTitlesInBackground.mockResolvedValue({ titles: [] })
  })

  it('preserves the bounded tab-title intent when forwarding a transcript request', async () => {
    await resolveLocalAiVaultSessionTitles([
      {
        agent: 'codex',
        sessionId: 'session-1',
        transcriptPath: 'C:\\sessions\\session-1.jsonl',
        titleOnly: true
      }
    ])

    expect(resolveAiVaultSessionTitlesInBackground).toHaveBeenCalledWith(
      [
        {
          agent: 'codex',
          sessionId: 'session-1',
          transcriptPath: 'C:\\sessions\\session-1.jsonl',
          titleOnly: true
        }
      ],
      undefined
    )
  })

  it('keeps history classification requests unmarked', async () => {
    await resolveLocalAiVaultSessionTitles([
      { agent: 'claude', sessionId: 'session-2', transcriptPath: 'C:\\sessions\\session-2.jsonl' }
    ])

    expect(resolveAiVaultSessionTitlesInBackground).toHaveBeenCalledWith(
      [
        { agent: 'claude', sessionId: 'session-2', transcriptPath: 'C:\\sessions\\session-2.jsonl' }
      ],
      undefined
    )
  })
})
