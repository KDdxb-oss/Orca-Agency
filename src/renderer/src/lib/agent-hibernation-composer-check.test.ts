import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { verifyEmptyAgentComposer } from './agent-hibernation-composer-check'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

const candidate: AgentHibernationCandidate = {
  id: 'wt:tab:leaf',
  worktreeId: 'wt',
  paneKey: 'tab:leaf',
  tabId: 'tab',
  leafId: 'leaf',
  paneKeys: ['tab:leaf'],
  targetPtyIds: ['pty'],
  expectedRuntimePtyIds: ['pty'],
  signature: 'stable'
}

const blankRead: RuntimeTerminalRead & { composerState: 'empty' } = {
  handle: 'term',
  status: 'running',
  tail: [],
  truncated: false,
  nextCursor: null,
  source: 'screen',
  composerState: 'empty'
}

function resolvePane(ptyId = 'pty'): void {
  vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
    terminal: {
      handle: 'term',
      tabId: 'tab',
      leafId: 'leaf',
      ptyId,
      connected: true,
      worktreeId: 'wt'
    }
  })
}

beforeEach(() => vi.mocked(callRuntimeRpc).mockReset())

describe('agent hibernation composer check', () => {
  it('accepts only a fresh screen that confirms a blank composer', async () => {
    resolvePane()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ terminal: blankRead })

    expect(await verifyEmptyAgentComposer(candidate, null)).toBe(true)
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'terminal.read',
      { terminal: 'term', screen: true },
      { timeoutMs: 10_000 }
    )
  })

  it.each([
    { source: 'screen' as const, composerState: 'draft' as const, draft: 'unsent' },
    { source: 'screen' as const, composerState: 'unknown' as const },
    { source: 'screen' as const, composerState: undefined },
    { source: 'screen-unavailable' as const, composerState: 'empty' as const },
    { source: 'screen' as const, composerState: 'empty' as const, handle: 'other' }
  ])('rejects unproven or occupied composers: %j', async (read) => {
    resolvePane()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ terminal: { ...blankRead, ...read } })

    expect(await verifyEmptyAgentComposer(candidate, 'remote-1')).toBe(false)
  })

  it('refuses a pane rebound to a different PTY', async () => {
    resolvePane('replacement')

    expect(await verifyEmptyAgentComposer(candidate, null)).toBe(false)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('refuses a disconnected pane', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
      terminal: {
        handle: 'term',
        tabId: 'tab',
        leafId: 'leaf',
        ptyId: 'pty',
        connected: false,
        worktreeId: 'wt'
      }
    })

    expect(await verifyEmptyAgentComposer(candidate, null)).toBe(false)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('refuses an exited terminal even with an old blank screen', async () => {
    resolvePane()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
      terminal: { ...blankRead, status: 'exited' }
    })

    expect(await verifyEmptyAgentComposer(candidate, null)).toBe(false)
  })

  it('fails closed when the host cannot read the composer', async () => {
    resolvePane()
    vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('offline'))

    expect(await verifyEmptyAgentComposer(candidate, 'remote-1')).toBe(false)
  })
})
