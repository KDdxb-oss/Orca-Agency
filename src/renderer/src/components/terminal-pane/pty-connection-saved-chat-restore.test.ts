import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: connection hooks run outside React in this suite.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })
  it.each([
    { restoredId: 'lost-pty', explicit: false, obsolete: false },
    { restoredId: null, explicit: false, obsolete: false },
    { restoredId: null, explicit: true, obsolete: false },
    { restoredId: null, explicit: false, obsolete: true }
  ])(
    'restores saved identity with handle $restoredId and explicit startup $explicit',
    async ({ restoredId, explicit, obsolete }) => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('fresh-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
        sessionId
          ? { id: 'fresh-pty', coldRestore: { scrollback: 'saved', cwd: '/tmp/wt-1' } }
          : 'fresh-pty'
      )
      transportFactoryQueue.push(transport)
      mockStoreState.tabsByWorktree['wt-1'] = [
        {
          id: 'tab-1',
          ptyId: restoredId,
          aiVaultTitle: {
            agent: 'codex',
            sessionId: 'original-aside-conversation',
            title: 'Import extensions'
          }
        }
      ]
      mockStoreState.settings!.chatSidebar = {
        sessions: {
          '["local","codex","original-aside-conversation"]': {
            worktreeId: 'wt-1',
            snapshot: {
              executionHostId: 'local',
              agent: 'codex',
              sessionId: 'original-aside-conversation',
              title: 'Import extensions',
              cwd: '/tmp/wt-1',
              filePath: '/home/.codex/sessions/2026/09/26/rollout.jsonl',
              codexHome: null,
              createdAt: null,
              updatedAt: null,
              modifiedAt: '2026-09-26T00:00:00Z'
            }
          }
        }
      }
      mockStoreState.ptyIdsByTabId = {}
      mockStoreState.terminalLayoutsByTabId = {}
      if (obsolete) {
        const paneKey = `tab-1:${LEAF_1}`
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          paneKey,
          agentType: 'codex',
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'newer-conversation' }
        }
      }
      const pane = createPane(1),
        manager = createManager(1)
      const deps = createDeps({
        startup: explicit ? { command: 'codex resume explicitly-prepared-session' } : null,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: restoredId ? { [LEAF_1]: restoredId } : {}
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Established connection fixtures implement only the transport and pane methods exercised by this test.
      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      await new Promise((resolve) => setTimeout(resolve, 70))
      if (explicit || obsolete) {
        expect(createdTransportOptions[0].command).toBe(
          explicit ? 'codex resume explicitly-prepared-session' : undefined
        )
        expect(transport.connect.mock.calls[0][0].command).toBeUndefined()
        expect(transport.sendInput).not.toHaveBeenCalled()
        return
      }
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.stringContaining("'resume' 'original-aside-conversation'"),
          resumeProviderSession: expect.objectContaining({
            key: 'session_id',
            id: 'original-aside-conversation'
          })
        })
      )
      expect(transport.connect.mock.calls[0][0].command).toContain('CODEX_HOME')
      expect(transport.sendInput).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'cold restores a proven Claude background target instead of its launcher in split=%s',
    async (split) => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('fresh-pty')
      transportFactoryQueue.push(transport)
      const launcherId = '8b1a93a0-1576-43df-88ba-5b3e742e8496'
      const targetId = '170dd324-3d4f-40d8-8e8b-ba261c0ee064'
      const dir = '/home/ada/.claude/projects/-tmp-wt-1'
      const launcherPath = `${dir}/${launcherId}.jsonl`
      const paneKey = `tab-1:${LEAF_1}`
      mockStoreState.tabsByWorktree['wt-1'] = [
        {
          id: 'tab-1',
          ptyId: null,
          launchAgent: 'claude',
          aiVaultTitle: split
            ? { agent: 'codex', sessionId: 'sibling-session', title: 'Sibling' }
            : null
        }
      ]
      mockStoreState.ptyIdsByTabId = {}
      mockStoreState.terminalLayoutsByTabId = split
        ? {
            'tab-1': {
              root: {
                type: 'split',
                direction: 'horizontal',
                first: { type: 'leaf', leafId: LEAF_1 },
                second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
              },
              activeLeafId: LEAF_1,
              expandedLeafId: null
            }
          }
        : {}
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        agentType: 'claude',
        state: 'waiting',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        providerSession: { key: 'session_id', id: launcherId, transcriptPath: launcherPath }
      }
      if (split) {
        const siblingPaneKey = 'tab-1:22222222-2222-4222-8222-222222222222'
        mockStoreState.agentStatusByPaneKey[siblingPaneKey] = {
          paneKey: siblingPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agentType: 'codex',
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'sibling-session' }
        }
      }
      mockStoreState.settings!.chatSidebar = {
        sessions: {
          [JSON.stringify(['local', 'claude', targetId])]: {
            worktreeId: 'wt-1',
            snapshot: {
              executionHostId: 'local',
              agent: 'claude',
              sessionId: targetId,
              title: 'Real conversation',
              cwd: '/tmp/wt-1',
              filePath: `${dir}/${targetId}.jsonl`,
              codexHome: null,
              createdAt: null,
              updatedAt: null,
              modifiedAt: '2026-09-26T00:00:00Z'
            },
            resumeLauncher: {
              agent: 'claude',
              sessionId: launcherId,
              transcriptPath: launcherPath,
              tabId: 'tab-1',
              paneKey,
              targetSessionIdPrefix: '170dd324'
            }
          }
        }
      }
      connectPanePty(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The focused pane fixture implements the methods exercised by this restore path.
        createPane(1) as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The focused manager fixture implements the methods exercised by this restore path.
        createManager(split ? 2 : 1) as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The focused dependency fixture implements the methods exercised by this restore path.
        createDeps() as never
      )
      await flushAsyncTicks(20)
      await new Promise((resolve) => setTimeout(resolve, 70))
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.stringContaining(targetId),
          resumeProviderSession: { key: 'session_id', id: targetId }
        })
      )
      expect(transport.connect.mock.calls[0][0].command).not.toContain(launcherId)
    }
  )
})
