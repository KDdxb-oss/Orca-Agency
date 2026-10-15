import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  makeRuntimeStoreWithWorkspaceSession,
  TEST_WORKTREE_ID
} from './orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import fixture from './__fixtures__/codex-compact-recovery-titles.json'

const tabId = 'tab-1'
const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = makePaneKey(tabId, leafId)
const incarnationId = '22222222-2222-4222-8222-222222222222'
const handle = `term_${incarnationId}`

class ColdRuntime extends OrcaRuntimeService {
  inventory() {
    return this.refreshPtyWorktreeRecordsWithControllerInventory([])
  }

  mountedLeaves() {
    return this.getLeavesForPty('pty-1')
  }
}

function setup(graphReady = true) {
  const session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: tabId,
          worktreeId: TEST_WORKTREE_ID,
          ptyId: 'pty-1',
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf' as const, leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'pty-1' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [paneKey]: incarnationId }
  }
  const persisted = makeRuntimeStoreWithWorkspaceSession(session)
  const row: AgentStatusIpcPayload = {
    paneKey,
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    agentType: 'codex',
    state: 'working',
    stateStartedAt: 1,
    receivedAt: 1,
    prompt: '',
    restoredUnconfirmed: true
  }
  const events = vi.fn()
  const runtime = new ColdRuntime(persisted.runtimeStore, undefined, {
    getAgentProviderSessionRowsForPane: () => [row],
    readObservedAgentStatusPaneIdentity: () => ({ kind: 'unobserved' }),
    onTerminalAgentStatus: events
  })
  const process: PtyProcessInfo = {
    id: 'pty-1',
    cwd: '',
    title: '',
    worktreeId: TEST_WORKTREE_ID,
    incarnationId,
    terminalHandle: handle
  }
  const attach = vi.fn().mockResolvedValue(true)
  const spawn = vi.fn()
  const write = vi.fn(() => true)
  const kill = vi.fn(() => true)
  runtime.setPtyController({
    listProcesses: async () => [process],
    attach,
    spawn,
    write,
    kill,
    getForegroundProcess: async () => 'codex'
  })
  runtime.attachWindow(1)
  if (graphReady) {
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  }
  return { runtime, row, events, attach, process, persisted, spawn, write, kill }
}

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('restored working terminal without a mounted view', () => {
  it('attaches when the graph becomes ready after the only startup inventory', async () => {
    const c = setup(false)
    await c.runtime.inventory()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(c.attach).not.toHaveBeenCalled()
    c.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    expect(c.attach).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(c.events).not.toHaveBeenCalled()
    c.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    expect(c.events).toHaveBeenCalledWith(
      expect.objectContaining({ confirmRestoredWorkingTitle: true })
    )
  })

  it('attaches the exact retained process and confirms only fresh native working bytes', async () => {
    const c = setup()
    await c.runtime.inventory()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(c.runtime.mountedLeaves()).toEqual([])
    expect(c.attach).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(c.events).not.toHaveBeenCalled()
    c.runtime.onPtyData('pty-1', fixture.frames[1], Date.now())
    expect(c.events).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceOnly: true,
        confirmRestoredWorkingTitle: true,
        observedTerminalHandle: handle,
        payload: expect.objectContaining({ state: 'working' })
      })
    )
    await c.runtime.inventory()
    expect(c.attach).toHaveBeenCalledTimes(1)
    expect(c.spawn).not.toHaveBeenCalled()
    expect(c.write).not.toHaveBeenCalled()
    expect(c.kill).not.toHaveBeenCalled()
  })

  it.each([
    'idle',
    'confirmed',
    'other-agent',
    'remote-row',
    'wrong-handle',
    'replacement',
    'missing-proof',
    'graph-unavailable'
  ])('does not attach with %s evidence', async (kind) => {
    const c = setup()
    if (kind === 'idle') {
      c.row.state = 'done'
    }
    if (kind === 'confirmed') {
      c.row.restoredUnconfirmed = false
    }
    if (kind === 'other-agent') {
      c.row.agentType = 'claude'
    }
    if (kind === 'remote-row') {
      c.row.connectionId = 'ssh-connection'
    }
    if (kind === 'wrong-handle') {
      c.row.terminalHandle = 'term_other'
    }
    if (kind === 'replacement') {
      c.process.incarnationId = '33333333-3333-4333-8333-333333333333'
    }
    if (kind === 'missing-proof') {
      c.persisted.setSession({ ...c.persisted.getSession(), terminalPtyIncarnationsByPaneKey: {} })
    }
    if (kind === 'graph-unavailable') {
      c.runtime.markGraphUnavailable(1)
    }
    await c.runtime.inventory()
    expect(c.attach).not.toHaveBeenCalled()
    expect(c.events).not.toHaveBeenCalled()
  })

  it.each([false, 'rejected'])(
    'retries failed attachment (%s) on the next inventory',
    async (result) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const c = setup()
      if (result === false) {
        c.attach.mockResolvedValueOnce(false)
      } else {
        c.attach.mockRejectedValueOnce(new Error('daemon unavailable'))
      }
      await c.runtime.inventory()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await c.runtime.inventory()
      expect(c.attach).toHaveBeenCalledTimes(2)
    }
  )

  it('retries transient startup attachment without another inventory and then stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const c = setup()
    c.attach.mockResolvedValue(false)
    await c.runtime.inventory()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(1500)
    expect(c.attach).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(5000)
    expect(c.attach).toHaveBeenCalledTimes(3)
    expect(c.events).not.toHaveBeenCalled()
  })
})
