import { describe, expect, it } from 'vitest'
import { getAiVaultAgentProviderSession } from './ai-vault-resume-command'

describe('Codex saved conversation provenance', () => {
  it.each([
    'C:\\Users\\alice\\.codex\\sessions\\2026\\09\\26\\rollout-saved.jsonl',
    '/home/alice/.codex/sessions/2026/09/26/rollout-saved.jsonl'
  ])('keeps the transcript location with the exact resume identity: %s', (filePath) => {
    expect(
      getAiVaultAgentProviderSession({ agent: 'codex', sessionId: 'saved-chat', filePath })
    ).toEqual({ key: 'session_id', id: 'saved-chat', transcriptPath: filePath })
  })

  it('keeps the legacy ID lookup when an older saved chat has no transcript path', () => {
    expect(getAiVaultAgentProviderSession({ agent: 'codex', sessionId: 'saved-chat' })).toEqual({
      key: 'session_id',
      id: 'saved-chat'
    })
  })

  it.each([
    [
      '/data/orca/codex-accounts/b/home',
      '/data/orca/codex-accounts/a/home/sessions/2026/09/26/rollout-saved.jsonl'
    ],
    [
      'C:\\Orca\\codex-accounts\\b\\home',
      'C:\\Orca\\codex-accounts\\a\\home\\sessions\\2026\\09\\26\\rollout-saved.jsonl'
    ],
    [null, '/data/orca/codex-runtime-home/home/sessions/2026/09/26/rollout-saved.jsonl']
  ])('keeps the selected resume home instead of an old alias: %s', (codexHome, filePath) => {
    expect(
      getAiVaultAgentProviderSession({
        agent: 'codex',
        sessionId: 'saved-chat',
        codexHome,
        filePath
      })
    ).toEqual({ key: 'session_id', id: 'saved-chat' })
  })

  it('retains provenance when the transcript belongs to the selected account', () => {
    const codexHome = 'C:\\Orca\\codex-accounts\\b\\home'
    const filePath = `${codexHome}\\sessions\\2026\\09\\26\\rollout-saved.jsonl`
    expect(
      getAiVaultAgentProviderSession({
        agent: 'codex',
        sessionId: 'saved-chat',
        codexHome,
        filePath
      })
    ).toEqual({ key: 'session_id', id: 'saved-chat', transcriptPath: filePath })
  })

  it('does not change another provider’s ID-based resume', () => {
    expect(
      getAiVaultAgentProviderSession({
        agent: 'claude',
        sessionId: 'saved-chat',
        filePath: '/home/alice/.claude/projects/project/session.jsonl'
      })
    ).toEqual({ key: 'session_id', id: 'saved-chat' })
  })
})
