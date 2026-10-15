import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { store, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import fixture from './__fixtures__/codex-compact-recovery-titles.json'
import claudeFixture from './__fixtures__/claude-native-activity-titles.json'
import actionRequiredFixture from './__fixtures__/codex-action-required-titles.json'
import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from './agent-status-observed-pane-identity'
import { buildBody, postHookEvent } from '../agent-hooks/server.test-fixtures'
import type { AgentHookServer } from '../agent-hooks/server'
import type { LocalPtyAgentOwnerObservation } from './local-pty-agent-owner-observation'
import { restoreWorkingRow } from './working-title-restored-row.test-fixture'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey('tab-1', leafId)

class EvidenceRuntime extends OrcaRuntimeService {
  ownerObservation: LocalPtyAgentOwnerObservation = { available: false }
  ownerObservationCount = 0

  protected observePtyLocalOwner() {
    this.ownerObservationCount += 1
    return Promise.resolve(this.ownerObservation)
  }

  refreshLocalOwner() {
    return this.ptyForegroundAgent.refresh('pty-1')
  }
  readPromptLifecycle() {
    return this.agentPromptLifecycleByPtyId.get('pty-1')
  }

  setRetainedLaunchToken(token: string | null) {
    this.ptysById.get('pty-1')!.launchToken = token
  }

  setManagedCodexOwner() {
    const pty = this.ptysById.get('pty-1')!
    pty.launchAgent = 'codex'
    pty.launchIncarnationId = pty.incarnationId
  }
}

const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  vi.useRealTimers()
})

async function setup(launchToken?: string, agent: 'codex' | 'claude' = 'codex') {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
  const wiring = makeAgentStatusStoreWiring()
  servers.push(wiring.statusStore)
  const identities = new AgentStatusObservedPaneIdentities()
  const runtime = new EvidenceRuntime(store, undefined, {
    ...wiring.deps,
    readObservedAgentStatusPaneIdentity: (key) => identities.read(key)
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => agent
  })
  runtime.attachWindow(1)
  runtime.registerPty('pty-1', TEST_WORKTREE_ID, null, {
    tabId: 'tab-1',
    leafId,
    incarnationId: 'retained-codex-process'
  })
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Codex',
        activeLeafId: leafId,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        leafId,
        paneRuntimeId: 1,
        ptyId: 'pty-1',
        paneTitle: null
      }
    ]
  })
  runtime.onPtyData('pty-1', fixture.frames[0], Date.now())
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(runtime.getLocalTerminalAgentForPane(paneKey)).toBe(agent)
  wiring.statusStore.setLocalTerminalAgentResolver((key) =>
    runtime.getLocalTerminalAgentForPane(key)
  )
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
  expect(terminalHandle).toBeTruthy()
  if (launchToken) {
    runtime.setRetainedLaunchToken(launchToken)
  }
  wiring.statusStore.setListener((event) =>
    recordObservedAgentStatusPaneIdentity(identities, event.paneKey, runtime)
  )
  await wiring.statusStore.start({ env: 'production' })
  const response = await postHookEvent(
    wiring.statusStore,
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Continue after compaction',
        session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      },
      { paneKey, worktreeId: TEST_WORKTREE_ID, launchToken }
    ),
    `/hook/${agent}`
  )
  expect(response.status).toBe(204)
  const previous = wiring.statusStore.getStatusSnapshot()[0]
  expect(previous).toMatchObject({ state: 'working', observation: { origin: 'hook' } })
  expect(previous.providerSession).toEqual({
    key: 'session_id',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  expect(previous.terminalHandle).toBeUndefined()
  expect(identities.read(paneKey)).toMatchObject({ kind: 'observed', terminalHandle })
  const listener = vi.fn()
  wiring.statusStore.setListener(listener)
  listener.mockClear()
  vi.setSystemTime(1_001 + AGENT_STATUS_STALE_AFTER_MS)
  return { runtime, wiring, previous, listener, identities }
}

describe('main runtime working-title evidence', () => {
  it.each(actionRequiredFixture.frames)(
    'records captured native action-required state without inventing hook evidence',
    async (frame) => {
      const context = await setup()
      const previous = restoreWorkingRow(context)
      context.runtime.onPtyData('pty-1', frame, Date.now())
      await new Promise<void>((resolve) => setImmediate(resolve))
      const handle = context.runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)!
      expect(await context.runtime.getTerminalInteractiveWait(handle)).toEqual({ source: 'title' })
      const row = context.wiring.statusStore.getStatusSnapshot()[0]
      expect(row.restoredUnconfirmed).toBe(true)
      expect(row.providerSession).toEqual(previous.providerSession)
      expect(row.turnStartedAt).toBe(previous.turnStartedAt)
    }
  )
  it.each(['idle', 'new-working'])(
    'waits out late idle after a new prompt and respects %s at the deadline',
    async (kind) => {
      const context = await setup(undefined, 'claude')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(context.previous.receivedAt + 1)
      context.runtime.onPtyData('pty-1', claudeFixture.frames[2], Date.now())
      expect(context.wiring.statusStore.getStatusSnapshot()[0].state).toBe('working')
      if (kind === 'new-working') {
        context.runtime.onPtyData('pty-1', claudeFixture.frames[0], Date.now())
      }
      await vi.advanceTimersByTimeAsync(16_000)
      expect(context.wiring.statusStore.getStatusSnapshot()[0].state).toBe(
        kind === 'idle' ? 'done' : 'working'
      )
    }
  )

  it.each(['claude'] as const)(
    'settles a silent %s turn from native idle without changing its prompt clock',
    async (agent) => {
      const context = await setup(undefined, agent)
      const previous = context.wiring.statusStore.getStatusSnapshot()[0]
      const idleFrame = agent === 'claude' ? claudeFixture.frames[2] : '\x1b]0;Codex idle\x07'
      context.runtime.onPtyData('pty-1', idleFrame, Date.now())
      const next = context.wiring.statusStore.getStatusSnapshot()[0]
      expect(next).toMatchObject({
        state: 'done',
        agentType: agent,
        mainAgent: { state: 'done' },
        providerSession: previous.providerSession,
        prompt: previous.prompt,
        stateStartedAt: previous.stateStartedAt,
        turnStartedAt: previous.turnStartedAt
      })
      expect(next.mainAgent?.outcome).toBeUndefined()
      expect(context.listener).toHaveBeenCalledTimes(1)
    }
  )

  it('settles the idle Claude lead while preserving registered background shell work', async () => {
    const context = await setup(undefined, 'claude')
    const state = context.wiring.statusStore._getStateForTests()
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
    const previous = context.wiring.statusStore.getStatusSnapshot()[0]
    context.runtime.onPtyData('pty-1', claudeFixture.frames[2], Date.now())
    const next = context.wiring.statusStore.getStatusSnapshot()[0]
    expect(next).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' },
      providerSession: previous.providerSession,
      prompt: previous.prompt,
      stateStartedAt: previous.stateStartedAt,
      turnStartedAt: previous.turnStartedAt
    })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)).toBe(true)
    expect(next.mainAgent?.outcome).toBeUndefined()
  })

  it.each(['synthetic', 'replacement', 'closed', 'later-working', 'child'])(
    'does not settle a Claude turn from %s idle evidence',
    async (kind) => {
      const context = await setup(undefined, 'claude')
      if (kind === 'replacement') {
        const owner = context.identities.read(paneKey)
        if (owner.kind !== 'observed') {
          throw new Error('Missing observed owner')
        }
        context.identities.record(paneKey, { ...owner, processIncarnation: 'old-process' })
      }
      if (kind === 'closed') {
        context.runtime.markGraphUnavailable(1)
      }
      if (kind === 'child') {
        await postHookEvent(
          context.wiring.statusStore,
          buildBody(
            { hook_event_name: 'SubagentStart', agent_id: 'child-1', agent_type: 'review' },
            { paneKey, worktreeId: TEST_WORKTREE_ID }
          ),
          '/hook/claude'
        )
      }
      const previous = context.wiring.statusStore.getStatusSnapshot()[0]
      context.listener.mockClear()
      const idle = claudeFixture.frames[2]
      if (kind === 'synthetic') {
        context.runtime.ingestSyntheticTitleFrame('pty-1', idle)
      } else {
        context.runtime.onPtyData(
          'pty-1',
          idle + (kind === 'later-working' ? claudeFixture.frames[0] : ''),
          Date.now()
        )
      }
      const next = context.wiring.statusStore.getStatusSnapshot()[0]
      if (kind === 'later-working') {
        expect(next).toMatchObject({
          state: 'working',
          mainAgent: { state: 'working' },
          prompt: previous.prompt,
          providerSession: previous.providerSession,
          stateStartedAt: previous.stateStartedAt,
          turnStartedAt: previous.turnStartedAt
        })
        expect(
          context.listener.mock.calls.every(([event]) => event.payload.state === 'working')
        ).toBe(true)
      } else {
        expect(next).toEqual(previous)
        expect(context.listener).not.toHaveBeenCalled()
      }
    }
  )

  it('keeps daemon-validated Codex ownership when a nested Claude is foreground', async () => {
    const context = await setup()
    context.runtime.registerPty('pty-1', TEST_WORKTREE_ID, null, {
      tabId: 'tab-1',
      leafId,
      incarnationId: 'retained-codex-process',
      providerReattachLaunchIdentity: {
        incarnationId: 'retained-codex-process',
        launchAgent: 'codex'
      }
    })
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const baseline = context.wiring.statusStore.getStatusSnapshot()[0]
    context.runtime.onPtyData('pty-1', claudeFixture.frames[2], Date.now())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('codex')
    const previous = context.wiring.statusStore.getStatusSnapshot()[0]
    expect(previous).toEqual(baseline)
    await postHookEvent(
      context.wiring.statusStore,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'nested child' },
        { paneKey, worktreeId: TEST_WORKTREE_ID }
      ),
      '/hook/claude'
    )
    expect(context.wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
  })

  it('retires a launch on an inspected bare shell without a command-finished marker', async () => {
    const context = await setup()
    context.runtime.setManagedCodexOwner()
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'powershell.exe',
      confirmShellForeground: async () => true
    })
    context.runtime.ownerObservation = { available: true, agent: null, launchPresent: false }
    context.runtime.onPtyData('pty-1', '\x1b]0;C:\\fixture\x07', Date.now())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBeNull()
  })

  it('preserves a new launch before its process has started', async () => {
    const context = await setup()
    context.runtime.setManagedCodexOwner()
    context.runtime.setRetainedLaunchToken('new-launch')
    context.runtime.ownerObservation = { available: true, agent: null, launchPresent: false }
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'powershell.exe',
      confirmShellForeground: async () => true
    })
    await context.runtime.refreshLocalOwner()
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('codex')
  })

  it('keeps an unmanaged outer Codex while its nested Claude is foreground', async () => {
    const context = await setup()
    context.runtime.ownerObservation = { available: true, agent: 'codex', launchPresent: false }
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const count = context.runtime.ownerObservationCount
    await context.runtime.refreshLocalOwner()
    await context.runtime.refreshLocalOwner()
    expect(context.runtime.ownerObservationCount - count).toBe(1)
    const previous = context.wiring.statusStore.getStatusSnapshot()[0]
    await postHookEvent(
      context.wiring.statusStore,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: 'nested review' },
        { paneKey, worktreeId: TEST_WORKTREE_ID }
      ),
      '/hook/claude'
    )
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('codex')
    expect(context.wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
  })

  it('admits a new outer Claude after a launch exits before it was ever observed', async () => {
    const context = await setup()
    context.runtime.setManagedCodexOwner()
    context.runtime.setRetainedLaunchToken('short-lived-launch')
    context.runtime.ownerObservation = { available: true, agent: 'claude', launchPresent: false }
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    await context.runtime.refreshLocalOwner()
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('claude')
  })

  it('records managed presence from incomplete proof and retires it after a semantic exit', async () => {
    const context = await setup()
    context.runtime.setManagedCodexOwner()
    context.runtime.setRetainedLaunchToken('observed-launch')
    context.runtime.ownerObservation = { available: false, launchPresent: true }
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      confirmShellForeground: async () => true
    })
    await context.runtime.refreshLocalOwner()
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('codex')
    context.runtime.ownerObservation = { available: true, agent: null, launchPresent: false }
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'powershell.exe',
      confirmShellForeground: async () => true
    })
    await context.runtime.refreshLocalOwner()
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBeNull()
  })

  it('accepts a new outer agent after the retained launch has left the process tree', async () => {
    const context = await setup()
    context.runtime.setManagedCodexOwner()
    context.runtime.ownerObservation = { available: true, agent: 'claude', launchPresent: false }
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    await context.runtime.refreshLocalOwner()
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('claude')
  })

  it('does not retire a launch added during a pending foreground read', async () => {
    const context = await setup()
    let resolveRead: ((name: string) => void) | undefined
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
      confirmShellForeground: async () => true
    })
    context.runtime.ownerObservation = { available: true, agent: null, launchPresent: false }
    const pending = context.runtime.refreshLocalOwner()
    context.runtime.setManagedCodexOwner()
    context.runtime.setRetainedLaunchToken('new-launch')
    resolveRead?.('powershell.exe')
    await pending
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('codex')
  })

  it('recovers Claude working after a missing-hook native idle settlement', async () => {
    const context = await setup(undefined, 'claude')
    context.runtime.onPtyData('pty-1', claudeFixture.frames[2], Date.now())
    const settled = context.wiring.statusStore.getStatusSnapshot()[0]
    expect(settled.state).toBe('done')
    vi.setSystemTime(Date.now() + 16_000)
    context.runtime.onPtyData('pty-1', claudeFixture.frames[0], Date.now())
    expect(context.wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      agentType: 'claude',
      mainAgent: { state: 'working' },
      prompt: settled.prompt,
      turnStartedAt: settled.turnStartedAt,
      providerSession: settled.providerSession
    })
  })

  it('retires the managed Codex claim before accepting Claude in the same shell', async () => {
    const context = await setup()
    context.runtime.setManagedCodexOwner()
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('codex')
    context.runtime.emitDaemonPtyTransientFact('pty-1', {
      kind: 'command-finished',
      exitCode: 0
    })
    context.runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    context.runtime.onPtyData('pty-1', claudeFixture.frames[2], Date.now())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(context.runtime.getLocalTerminalAgentForPane(paneKey)).toBe('claude')
    const response = await postHookEvent(
      context.wiring.statusStore,
      buildBody(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'New Claude task',
          session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        },
        { paneKey, worktreeId: TEST_WORKTREE_ID }
      ),
      '/hook/claude'
    )
    expect(response.status).toBe(204)
    expect(context.wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'claude',
      state: 'working',
      providerSession: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    })
  })

  it.each(['cancelled', 'restored'])(
    'rejects a nested review before parsing while the parent is %s',
    async (kind) => {
      const context = kind === 'cancelled' ? await cancelledContext() : await setup()
      if (kind === 'restored') {
        restoreWorkingRow(context)
      }
      const previous = context.wiring.statusStore.getStatusSnapshot()[0]
      const caches = context.wiring.statusStore._getStateForTests()
      const parentPrompt = caches.lastPromptByPaneKey.get(paneKey)
      const parentTool = caches.lastToolByPaneKey.get(paneKey)
      for (const hook of [
        { hook_event_name: 'UserPromptSubmit', prompt: 'child review prompt' },
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'child' } },
        { hook_event_name: 'Stop', last_assistant_message: 'child review' }
      ]) {
        const response = await postHookEvent(
          context.wiring.statusStore,
          buildBody(
            { ...hook, session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
            { paneKey, worktreeId: TEST_WORKTREE_ID }
          ),
          '/hook/claude'
        )
        expect(response.status).toBe(204)
      }
      expect(context.wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
      expect(caches.lastPromptByPaneKey.get(paneKey)).toBe(parentPrompt)
      expect(caches.lastToolByPaneKey.get(paneKey)).toEqual(parentTool)
    }
  )

  it.each(['success', 'failure'])(
    'corrects a stale %s verdict when the same Codex process is working again',
    async (outcome) => {
      const context = await setup()
      context.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
      if (outcome === 'failure') {
        context.wiring.statusStore.ingestTerminalStatus({
          ptyId: 'pty-1',
          paneKey,
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          terminalHandle:
            context.runtime.getAgentStatusTerminalHandleForPaneKey(paneKey) ?? undefined,
          payload: {
            state: 'done',
            agentType: 'codex',
            prompt: context.previous.prompt,
            mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: Date.now() }
          }
        })
      } else {
        await postHookEvent(
          context.wiring.statusStore,
          buildBody(
            {
              hook_event_name: 'Stop',
              session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            },
            { paneKey, worktreeId: TEST_WORKTREE_ID }
          ),
          '/hook/codex'
        )
      }
      const previous = context.wiring.statusStore.getStatusSnapshot()[0]
      expect(previous.state).toBe('done')
      if (outcome === 'failure') {
        expect(previous.mainAgent?.outcome).toBe('failure')
      }
      context.listener.mockClear()
      vi.setSystemTime(Date.now() + 16_000)
      context.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
      const recovered = context.wiring.statusStore.getStatusSnapshot()[0]
      expect(recovered).toMatchObject({
        state: 'working',
        mainAgent: { state: 'working' },
        providerSession: previous.providerSession
      })
      expect(recovered.prompt).toBe(outcome === 'success' ? '' : previous.prompt)
      expect(recovered.turnStartedAt).toBe(
        outcome === 'success' ? undefined : previous.turnStartedAt
      )
      expect(recovered.stateStartedAt).toBe(
        outcome === 'success' ? Date.now() : previous.stateStartedAt
      )
      expect(context.wiring.statusStore.getStatusSnapshot()[0].mainAgent?.outcome).toBeUndefined()
      expect(context.listener).toHaveBeenCalledTimes(1)
    }
  )

  async function cancelledContext() {
    const context = await setup()
    context.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    const baseline = context.wiring.statusStore.getStatusSnapshot()[0]
    expect(context.identities.read(paneKey)).toMatchObject({ kind: 'observed' })
    vi.setSystemTime(Date.now() + 1)
    // Stable requires provider evidence; Ctrl+C alone may leave the Codex turn running.
    context.wiring.statusStore.ingestRemote(
      {
        paneKey,
        tabId: 'tab-1',
        worktreeId: TEST_WORKTREE_ID,
        source: 'codex',
        hookEventName: 'Stop',
        providerSession: baseline.providerSession,
        payload: {
          state: 'done',
          prompt: baseline.prompt,
          agentType: 'codex',
          interrupted: true,
          mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: Date.now() }
        }
      },
      null
    )
    expect(context.wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      interrupted: true
    })
    context.listener.mockClear()
    return context
  }

  it('clears a cancellation when the same native Codex process resumes after compact recovery', async () => {
    const context = await cancelledContext()
    const cancelled = context.wiring.statusStore.getStatusSnapshot()[0]
    expect(cancelled).toMatchObject({ state: 'done', interrupted: true })
    vi.setSystemTime(Date.now() + 16_000)
    context.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    const recovered = context.wiring.statusStore.getStatusSnapshot()[0]
    expect(recovered).toMatchObject({
      state: 'working',
      stateStartedAt: cancelled.stateStartedAt,
      turnStartedAt: cancelled.turnStartedAt,
      mainAgent: { state: 'working' },
      observation: { origin: 'osc' },
      providerSession: cancelled.providerSession,
      terminalHandle: context.runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
    })
    expect(recovered.interrupted).toBeUndefined()
    expect(recovered.mainAgent?.outcome).toBeUndefined()
    expect(context.listener).toHaveBeenCalledTimes(1)
  })

  it.each(['late-frame', 'synthetic', 'replacement', 'closed', 'settled'])(
    'does not revive cancellation from %s output',
    async (kind) => {
      const context = await cancelledContext()
      if (kind === 'replacement') {
        const owner = context.identities.read(paneKey)
        if (owner.kind !== 'observed') {
          throw new Error('Missing observed owner')
        }
        context.identities.record(paneKey, { ...owner, processIncarnation: 'old-process' })
      }
      if (kind === 'closed') {
        context.runtime.markGraphUnavailable(1)
      }
      if (kind === 'settled') {
        await postHookEvent(
          context.wiring.statusStore,
          buildBody(
            {
              hook_event_name: 'Stop',
              session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            },
            { paneKey, worktreeId: TEST_WORKTREE_ID }
          ),
          '/hook/codex'
        )
      }
      const previous = context.wiring.statusStore.getStatusSnapshot()[0]
      context.listener.mockClear()
      vi.setSystemTime(Date.now() + (kind === 'late-frame' ? 1_000 : 16_000))
      if (kind === 'synthetic') {
        context.runtime.ingestSyntheticTitleFrame('pty-1', fixture.frames[1])
      } else {
        context.runtime.onPtyData(
          'pty-1',
          `${fixture.frames[1]}${kind === 'settled' ? '\x1b]0;Codex idle\x07' : ''}`,
          Date.now()
        )
      }
      expect(context.wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
      expect(context.listener).not.toHaveBeenCalled()
    }
  )

  it.each(['retained-launch', null, 'replacement-launch'])(
    'checks the saved launch commitment against %s after real persistence',
    async (launchToken) => {
      const context = await setup('retained-launch')
      restoreWorkingRow(context)
      const previous = context.wiring.statusStore.getStatusSnapshot()[0]
      context.runtime.setRetainedLaunchToken(launchToken)
      context.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
      if (launchToken === 'retained-launch' || launchToken === null) {
        expect(context.wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          terminalHandle: context.runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
        })
        expect(
          context.wiring.statusStore.getStatusSnapshot()[0].restoredUnconfirmed
        ).toBeUndefined()
        expect(context.listener).toHaveBeenCalledTimes(1)
        if (launchToken === null) {
          expect(context.wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
            prompt: '',
            stateStartedAt: previous.stateStartedAt,
            turnStartedAt: previous.turnStartedAt,
            observation: { origin: 'osc' }
          })
          expect(context.wiring.statusStore.getStatusSnapshot()[0].providerSession).toEqual(
            previous.providerSession
          )
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Read the real server's protected serializer to verify resume identity and the existing commitment survive.
          const persistence = context.wiring.statusStore as unknown as {
            serializeStatusFile(): string
          }
          const saved = JSON.parse(persistence.serializeStatusFile()).entries[paneKey]
          expect(saved.providerSession).toEqual(previous.providerSession)
          expect(saved.source).toBeUndefined()
          expect(saved.hookEventName).toBeUndefined()
          expect(saved.launchToken).toBeUndefined()
          expect(saved.launchTokenHash).toBe(
            createHash('sha256').update('retained-launch').digest('hex')
          )
        }
      } else {
        expect(context.wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
        expect(context.listener).not.toHaveBeenCalled()
      }
    }
  )

  it('confirms a cold restored working row from fresh native output without a new prompt', async () => {
    const context = await setup()
    const previous = restoreWorkingRow(context)
    context.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    const confirmed = context.wiring.statusStore.getStatusSnapshot()[0]
    expect(confirmed.restoredUnconfirmed).toBeUndefined()
    expect(confirmed).toMatchObject({
      state: 'working',
      stateStartedAt: previous.stateStartedAt,
      turnStartedAt: previous.turnStartedAt,
      prompt: '',
      evidenceObservedAt: Date.now(),
      terminalHandle: context.runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
    })
    expect(context.listener).toHaveBeenCalledTimes(1)
  })

  it.each(['synthetic', 'snapshot', 'idle', 'permission', 'closed'])(
    'does not confirm a restored row from %s evidence',
    async (kind) => {
      const context = await setup()
      restoreWorkingRow(context)
      const previous = context.wiring.statusStore.getStatusSnapshot()[0]
      if (kind === 'synthetic') {
        context.runtime.ingestSyntheticTitleFrame('pty-1', fixture.frames[1])
      } else if (kind === 'snapshot') {
        context.runtime.getTerminalSideEffectSnapshot('pty-1')
      } else {
        if (kind === 'closed') {
          context.runtime.markGraphUnavailable(1)
        }
        context.runtime.onPtyData(
          'pty-1',
          kind === 'closed'
            ? fixture.frames[1]
            : `${fixture.frames[1]}\x1b]0;Codex ${kind === 'idle' ? 'idle' : 'waiting for permission'}\x07`,
          Date.now()
        )
      }
      expect(context.wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
      expect(context.listener).not.toHaveBeenCalled()
    }
  )
  it.each(['idle', 'waiting for permission'])(
    'preserves the final %s lifecycle when working and settled titles share a chunk',
    async (title) => {
      const { runtime, wiring } = await setup()
      const previousSequence = runtime.readPromptLifecycle()?.workingSequence
      expect(previousSequence).toEqual(expect.any(Number))
      runtime.onPtyData('pty-1', `${fixture.frames[1]}\x1b]0;Codex ${title}\x07`, Date.now())
      expect(runtime.readPromptLifecycle()).toMatchObject({
        status: title === 'idle' ? 'idle' : 'permission',
        workingSequence: previousSequence
      })
      expect(wiring.statusStore.getStatusSnapshot()[0].evidenceObservedAt).toBe(Date.now())
    }
  )

  it('renews a stale hook from captured provider output without a mounted renderer consumer', async () => {
    const { runtime, wiring, previous, listener } = await setup()
    runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
      evidenceObservedAt: Date.now(),
      stateStartedAt: previous.stateStartedAt,
      prompt: previous.prompt,
      turnStartedAt: previous.turnStartedAt,
      observation: {
        origin: 'hook',
        kind: 'snapshot',
        incarnation: previous.observation?.incarnation
      }
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects titles from a replacement process even with the same handle', async () => {
    const { runtime, wiring, previous, listener, identities } = await setup()
    const observed = identities.read(paneKey)
    if (observed.kind !== 'observed') {
      throw new Error('Missing captured hook owner')
    }
    identities.record(paneKey, { ...observed, processIncarnation: 'previous-process' })
    runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    expect(wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not renew an owner after its authoritative graph is removed', async () => {
    const { runtime, wiring, previous, listener } = await setup()
    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    expect(wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not renew a stale row from synthetic hook spinner frames', async () => {
    const { runtime, wiring, previous, listener } = await setup()
    runtime.ingestSyntheticTitleFrame('pty-1', fixture.frames[1])
    expect(wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
    expect(listener).not.toHaveBeenCalled()
  })

  it('a title snapshot read does not renew the stale row', async () => {
    const { runtime, wiring, previous, listener } = await setup()
    runtime.getTerminalSideEffectSnapshot('pty-1')
    expect(wiring.statusStore.getStatusSnapshot()[0]).toEqual(previous)
    expect(listener).not.toHaveBeenCalled()
  })
})
