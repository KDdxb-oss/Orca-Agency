import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { AGENT_WORKING_TITLE_REFRESH_AFTER_MS } from '../../shared/agent-working-title-freshness'
import {
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../../shared/agent-hook-listener/listener-state'

const event = {
  paneKey: PANE,
  ptyId: 'pty-current',
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  terminalHandle: 'term-current',
  observedTerminalHandle: 'term-current',
  connectionId: null,
  payload: { state: 'working' as const, prompt: '', agentType: 'codex' as const },
  evidenceOnly: true as const
}

function seed(server: AgentHookServer): void {
  server.ingestTerminalStatus({
    ...event,
    evidenceOnly: undefined,
    payload: { ...event.payload, prompt: 'Continue after compaction', toolName: 'Bash' }
  })
}

beforeEach(() => {
  _internals.resetCachesForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
})
afterEach(() => vi.useRealTimers())

describe('live working-title evidence in the authoritative store', () => {
  it('refreshes stale evidence and publishes it without changing the task or state clock', () => {
    const server = new AgentHookServer()
    seed(server)
    const previous = server.getStatusSnapshot()[0]
    const listener = vi.fn()
    server.setListener(listener)
    listener.mockClear()
    const now = 1_001 + AGENT_STATUS_STALE_AFTER_MS
    vi.setSystemTime(now)

    server.ingestTerminalStatus(event)

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      ...previous,
      receivedAt: now,
      evidenceObservedAt: now,
      observation: expect.objectContaining({ origin: 'osc', observedAt: now })
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toMatchObject({
      evidenceObservedAt: now,
      stateStartedAt: previous.stateStartedAt,
      payload: { state: 'working', prompt: previous.prompt, toolName: 'Bash' }
    })
  })

  it('does not create a status row from a title', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus(event)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('does not publish repeated frames while the evidence is fresh', () => {
    const server = new AgentHookServer()
    seed(server)
    const previous = server.getStatusSnapshot()
    const listener = vi.fn()
    server.setListener(listener)
    listener.mockClear()
    vi.setSystemTime(1_000 + AGENT_WORKING_TITLE_REFRESH_AFTER_MS)
    server.ingestTerminalStatus(event)
    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual(previous)
  })

  it.each([
    { terminalHandle: 'term-other' },
    { observedTerminalHandle: undefined },
    { worktreeId: 'wt-other' },
    { connectionId: 'remote-other' },
    { tabId: 'tab-other' },
    { ptyId: undefined },
    { payload: { ...event.payload, agentType: 'claude' } }
  ])('rejects another or missing terminal owner: %j', (override) => {
    const server = new AgentHookServer()
    seed(server)
    const previous = server.getStatusSnapshot()
    vi.setSystemTime(1_001 + AGENT_STATUS_STALE_AFTER_MS)
    server.ingestTerminalStatus({ ...event, ...override })
    expect(server.getStatusSnapshot()).toEqual(previous)
  })

  it.each([
    { restoredUnconfirmed: true as const },
    { providerSessionOnly: true },
    { payload: { state: 'done' as const, prompt: '', agentType: 'codex' } },
    { payload: { ...event.payload, mainAgent: { state: 'done' as const, stateStartedAt: 1_000 } } }
  ])('cannot revive restored, hidden or settled evidence: %j', (override) => {
    const server = new AgentHookServer()
    seed(server)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The server owns this state; the fixture seeds provenance through its admission helper.
    const internal = server as unknown as {
      state: HookListenerState
    }
    const previous = { ...internal.state.lastStatusByPaneKey.get(PANE)!, ...override }
    seedLegacyAgentStatusForTests(internal.state, previous)
    vi.setSystemTime(1_001 + AGENT_STATUS_STALE_AFTER_MS)
    server.ingestTerminalStatus(event)
    expect(internal.state.lastStatusByPaneKey.get(PANE)).toEqual(previous)
    expect(server.getStatusSnapshot()[0].evidenceObservedAt).toBe(1_000)
  })

  it.each([1_001, 999])(
    'confirms retained local working state without moving clocks backwards at %i',
    (clock) => {
      const server = new AgentHookServer()
      seed(server)
      const timing = server.getStatusSnapshot()[0]
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture marks the same admitted row as hydrated.
      const internal = server as unknown as { state: HookListenerState }
      const previous = {
        ...internal.state.lastStatusByPaneKey.get(PANE)!,
        terminalHandle: undefined,
        launchToken: 'retained-test-token',
        restoredUnconfirmed: true as const
      }
      seedLegacyAgentStatusForTests(internal.state, previous)
      const listener = vi.fn()
      server.setListener(listener)
      listener.mockClear()
      vi.setSystemTime(clock)
      server.ingestTerminalStatus({
        ...event,
        confirmRestoredWorkingTitle: true,
        restoredLaunchToken: 'retained-test-token'
      })
      const confirmed = internal.state.lastStatusByPaneKey.get(PANE)!
      expect(confirmed.restoredUnconfirmed).toBeUndefined()
      expect(confirmed).toMatchObject({
        payload: previous.payload,
        stateStartedAt: timing.stateStartedAt,
        turnStartedAt: timing.turnStartedAt,
        receivedAt: 1_001,
        evidenceObservedAt: 1_001,
        terminalHandle: event.terminalHandle,
        observation: expect.objectContaining({ origin: 'osc', observedAt: 1_001 })
      })
      expect(listener).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    { terminalHandle: 'another-terminal' },
    { connectionId: 'remote-host' },
    { providerSessionOnly: true },
    { payload: { state: 'done' as const, prompt: '', agentType: 'codex' } },
    { payload: { ...event.payload, mainAgent: { state: 'done' as const, stateStartedAt: 1_000 } } }
  ])(
    'does not use native confirmation to revive an unrelated or settled restored row: %j',
    (override) => {
      const server = new AgentHookServer()
      seed(server)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture marks an admitted row as hydrated and seeds the refusal case.
      const internal = server as unknown as { state: HookListenerState }
      const previous = {
        ...internal.state.lastStatusByPaneKey.get(PANE)!,
        ...override,
        restoredUnconfirmed: true as const
      }
      seedLegacyAgentStatusForTests(internal.state, previous)
      vi.setSystemTime(1_001 + AGENT_STATUS_STALE_AFTER_MS)
      server.ingestTerminalStatus({ ...event, confirmRestoredWorkingTitle: true })
      expect(internal.state.lastStatusByPaneKey.get(PANE)).toEqual(previous)
    }
  )
})
