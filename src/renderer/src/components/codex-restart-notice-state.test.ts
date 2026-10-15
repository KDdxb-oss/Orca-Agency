import { describe, expect, it } from 'vitest'
import { awaitsCodexRestartAnswer, blocksCodexPaneInput } from './codex-restart-notice-state'

describe('configuration restart notices', () => {
  const configuration = {
    homeRouteChanged: true,
    previousAccountId: 'account',
    nextAccountId: 'account'
  } as const

  it('keeps a same-account conversation usable without a popup', () => {
    expect(blocksCodexPaneInput(configuration)).toBe(false)
    expect(awaitsCodexRestartAnswer(configuration)).toBe(false)
    expect(
      blocksCodexPaneInput({ ...configuration, previousAccountId: null, nextAccountId: null })
    ).toBe(false)
  })

  it('still blocks actual account changes and unknown identities', () => {
    expect(blocksCodexPaneInput({ ...configuration, nextAccountId: 'other' })).toBe(true)
    expect(awaitsCodexRestartAnswer({ ...configuration, nextAccountId: 'other' })).toBe(true)
    expect(blocksCodexPaneInput({ homeRouteChanged: true })).toBe(true)
  })

  it('blocks input during an explicitly requested restart and honors Keep', () => {
    expect(blocksCodexPaneInput({ ...configuration, restartRequested: true })).toBe(true)
    expect(awaitsCodexRestartAnswer({ ...configuration, restartRequested: true })).toBe(false)
    expect(blocksCodexPaneInput({ ...configuration, dismissed: true })).toBe(false)
  })
})
