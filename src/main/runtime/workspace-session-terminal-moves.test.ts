import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))
const { Store } = await import('../persistence/loading-store/store')
const SOURCE = 'folder:source',
  DESTINATION = 'folder:destination'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = `${SOURCE}@@retained`
const stores: InstanceType<typeof Store>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
})
function createStore() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-move-')))
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  stores.push(store)
  return store
}
function initial(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [SOURCE]: [
        {
          id: 'tab',
          worktreeId: SOURCE,
          ptyId: PTY,
          title: 'Saved chat',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ],
      [DESTINATION]: []
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: PTY }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [`tab:${LEAF}`]: 'same-process-generation' },
    terminalTopologyRevisionByRepoId: { [SOURCE]: 1 }
  }
}
function moved(
  prior: WorkspaceSessionState,
  source = SOURCE,
  destination = DESTINATION
): WorkspaceSessionState {
  const tab = prior.tabsByWorktree[source][0]
  return {
    ...prior,
    tabsByWorktree: {
      ...prior.tabsByWorktree,
      [source]: [],
      [destination]: [
        {
          ...tab,
          worktreeId: destination,
          workspaceMoveRevision: (tab.workspaceMoveRevision ?? 0) + 1,
          relocatedFromWorktreeIds: [...new Set([...(tab.relocatedFromWorktreeIds ?? []), source])]
        }
      ]
    }
  }
}
describe('durable local tab moves', () => {
  it('restores a removed source group without duplicating a tab coalesced into another group', () => {
    const store = createStore()
    const before = initial()
    before.tabsByWorktree[SOURCE].push({
      ...before.tabsByWorktree[SOURCE][0],
      id: 'other',
      ptyId: null
    })
    const unified = {
      id: 'tab',
      entityId: 'tab',
      groupId: 'g1',
      worktreeId: SOURCE,
      contentType: 'terminal' as const,
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    before.unifiedTabs = { [SOURCE]: [unified, { ...unified, id: 'other', entityId: 'other' }] }
    before.tabGroups = {
      [SOURCE]: [
        { id: 'g1', worktreeId: SOURCE, activeTabId: 'tab', tabOrder: ['tab', 'other'] },
        { id: 'g2', worktreeId: SOURCE, activeTabId: null, tabOrder: [] }
      ]
    }
    before.tabGroupLayouts = {
      [SOURCE]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g1' },
        second: { type: 'leaf', groupId: 'g2' }
      }
    }
    store.setWorkspaceSession(before)
    const candidate = moved(store.getWorkspaceSession())
    candidate.tabsByWorktree[DESTINATION][0].workspaceMoveRevision = 0
    candidate.tabsByWorktree[SOURCE] = [before.tabsByWorktree[SOURCE][1]]
    candidate.unifiedTabs = {
      [SOURCE]: [{ ...before.unifiedTabs[SOURCE][1], groupId: 'g2' }],
      [DESTINATION]: [{ ...unified, worktreeId: DESTINATION }]
    }
    candidate.tabGroups = {
      [SOURCE]: [{ id: 'g2', worktreeId: SOURCE, activeTabId: 'other', tabOrder: ['other'] }]
    }
    candidate.tabGroupLayouts = { [SOURCE]: { type: 'leaf', groupId: 'g2' } }
    store.setWorkspaceSession(candidate)
    const saved = store.getWorkspaceSession()
    expect(saved.tabGroups?.[SOURCE].map((group) => [group.id, group.tabOrder])).toEqual([
      ['g2', ['other']],
      ['g1', ['tab']]
    ])
    expect(saved.tabGroupLayouts?.[SOURCE]).toEqual(before.tabGroupLayouts[SOURCE])
  })
  it('accepts and rejects moves between two worktrees sharing a repository fence', () => {
    const store = createStore()
    const source = 'repo::/one',
      destination = 'repo::/two'
    const before = initial()
    before.tabsByWorktree = {
      [source]: [{ ...before.tabsByWorktree[SOURCE][0], worktreeId: source }],
      [destination]: []
    }
    before.terminalTopologyRevisionByRepoId = { repo: 1 }
    store.setWorkspaceSession(before)
    store.setWorkspaceSession(moved(store.getWorkspaceSession(), source, destination))
    expect(store.getWorkspaceSession().tabsByWorktree[source]).toEqual([])
    const rejected = moved(store.getWorkspaceSession(), destination, source)
    rejected.tabsByWorktree[source][0].workspaceMoveRevision = 0
    store.setWorkspaceSession(rejected)
    expect(store.getWorkspaceSession().tabsByWorktree[source]).toEqual([])
    expect(store.getWorkspaceSession().tabsByWorktree[destination]).toHaveLength(1)
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId).toEqual({ repo: 1 })
  })
  it('leaves topology fences unchanged and retains later destination tabs and splits', async () => {
    const store = createStore()
    store.setWorkspaceSession(initial())
    store.setWorkspaceSession(moved(store.getWorkspaceSession()))
    const admitted = store.getWorkspaceSession()
    expect(admitted.terminalTopologyRevisionByRepoId).toEqual({ [SOURCE]: 1 })
    const extraLeaf = '22222222-2222-4222-8222-222222222222'
    const extra = {
      ...admitted.tabsByWorktree[DESTINATION][0],
      id: 'extra',
      ptyId: null,
      workspaceMoveRevision: undefined,
      relocatedFromWorktreeIds: undefined
    }
    store.setWorkspaceSession({
      ...admitted,
      tabsByWorktree: {
        ...admitted.tabsByWorktree,
        [DESTINATION]: [...admitted.tabsByWorktree[DESTINATION], extra]
      },
      terminalLayoutsByTabId: {
        ...admitted.terminalLayoutsByTabId,
        tab: {
          ...admitted.terminalLayoutsByTabId.tab,
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF },
            second: { type: 'leaf', leafId: extraLeaf }
          }
        },
        extra: {
          root: { type: 'leaf', leafId: '33333333-3333-4333-8333-333333333333' },
          activeLeafId: '33333333-3333-4333-8333-333333333333',
          expandedLeafId: null
        }
      }
    })
    await store.flushPendingOrThrowAsync()
    const reopened = createSqliteTestStore(Store, {
      dataFile: join(store.getProfileStorageDirectory(), 'orca-data.json')
    })
    stores.push(reopened)
    expect(reopened.getWorkspaceSession().tabsByWorktree[DESTINATION].map((tab) => tab.id)).toEqual(
      ['tab', 'extra']
    )
    expect(reopened.getWorkspaceSession().terminalLayoutsByTabId.tab.root?.type).toBe('split')
    expect(reopened.getWorkspaceSession().terminalLayoutsByTabId.extra).toBeDefined()
  })
  it('settles rejected ownership even when a coalesced save outruns both topology fences', () => {
    const store = createStore()
    const before = initial()
    before.terminalTopologyRevisionByRepoId = { [SOURCE]: 1, [DESTINATION]: 1 }
    store.setWorkspaceSession(before)
    const candidate = moved(store.getWorkspaceSession())
    candidate.tabsByWorktree[DESTINATION][0].workspaceMoveRevision = 0
    candidate.terminalTopologyRevisionByRepoId = { [SOURCE]: 5, [DESTINATION]: 5 }
    candidate.tabsByWorktree[DESTINATION].push({
      ...candidate.tabsByWorktree[DESTINATION][0],
      id: 'unrelated',
      ptyId: null
    })
    store.setWorkspaceSession(candidate)
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE].map((tab) => tab.id)).toEqual(['tab'])
    expect(store.getWorkspaceSession().tabsByWorktree[DESTINATION].map((tab) => tab.id)).toEqual([
      'unrelated'
    ])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab).toEqual(
      before.terminalLayoutsByTabId.tab
    )
  })
  it('restores rejected unified tabs and groups without dropping unrelated incoming tabs', () => {
    const store = createStore()
    const before = initial()
    before.unifiedTabs = {
      [SOURCE]: [
        {
          id: 'tab',
          entityId: 'tab',
          groupId: 'source-group',
          worktreeId: SOURCE,
          contentType: 'terminal',
          label: 'Saved chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
    before.tabGroups = {
      [SOURCE]: [{ id: 'source-group', worktreeId: SOURCE, activeTabId: 'tab', tabOrder: ['tab'] }]
    }
    before.tabGroupLayouts = { [SOURCE]: { type: 'leaf', groupId: 'source-group' } }
    store.setWorkspaceSession(before)
    const candidate = moved(store.getWorkspaceSession())
    candidate.tabsByWorktree[DESTINATION][0].workspaceMoveRevision = 0
    candidate.unifiedTabs = {
      [SOURCE]: [],
      [DESTINATION]: [
        { ...before.unifiedTabs[SOURCE][0], worktreeId: DESTINATION, groupId: 'target' }
      ]
    }
    candidate.tabGroups = {
      [SOURCE]: [],
      [DESTINATION]: [
        { id: 'target', worktreeId: DESTINATION, activeTabId: 'tab', tabOrder: ['tab'] }
      ]
    }
    candidate.tabGroupLayouts = { [DESTINATION]: { type: 'leaf', groupId: 'target' } }
    store.setWorkspaceSession(candidate)
    const saved = store.getWorkspaceSession()
    expect(saved.unifiedTabs?.[SOURCE]).toEqual(before.unifiedTabs[SOURCE])
    expect(saved.unifiedTabs?.[DESTINATION]).toEqual([])
    expect(saved.tabGroups?.[SOURCE][0].tabOrder).toEqual(['tab'])
    expect(saved.tabGroups?.[DESTINATION]).toEqual([])
    expect(saved.tabGroupLayouts?.[SOURCE]).toEqual(before.tabGroupLayouts[SOURCE])
  })
  it('keeps one owner through moves, reverse moves, stale saves and a durable reload', async () => {
    const store = createStore()
    const before = initial()
    store.setWorkspaceSession(before)
    const forward = moved(store.getWorkspaceSession())
    store.setWorkspaceSession(forward)
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE]).toEqual([])
    expect(store.getWorkspaceSession().tabsByWorktree[DESTINATION][0]).toMatchObject({
      id: 'tab',
      ptyId: PTY,
      workspaceMoveRevision: 1
    })
    store.setWorkspaceSession(before)
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE]).toEqual([])
    const reverse = moved(store.getWorkspaceSession(), DESTINATION, SOURCE)
    store.setWorkspaceSession(reverse)
    store.setWorkspaceSession(forward)
    const saved = store.getWorkspaceSession()
    expect(saved.tabsByWorktree[DESTINATION]).toEqual([])
    expect(saved.tabsByWorktree[SOURCE][0]).toMatchObject({ workspaceMoveRevision: 2, ptyId: PTY })
    expect(saved.terminalLayoutsByTabId.tab).toEqual(before.terminalLayoutsByTabId.tab)
    expect(saved.terminalPtyIncarnationsByPaneKey).toEqual(before.terminalPtyIncarnationsByPaneKey)
    await store.flushPendingOrThrowAsync()
    const reopened = createSqliteTestStore(Store, {
      dataFile: join(store.getProfileStorageDirectory(), 'orca-data.json')
    })
    stores.push(reopened)
    expect(reopened.getWorkspaceSession().tabsByWorktree).toEqual(saved.tabsByWorktree)
  })
  it.each(['incarnation', 'binding', 'duplicate', 'revision', 'remote'] as const)(
    'rejects a move with invalid %s evidence',
    (invalid) => {
      const store = createStore()
      const prior = initial()
      store.setWorkspaceSession(prior)
      const candidate = moved(store.getWorkspaceSession())
      if (invalid === 'incarnation') {
        candidate.terminalPtyIncarnationsByPaneKey = { [`tab:${LEAF}`]: 'replacement' }
      } else if (invalid === 'binding') {
        candidate.terminalLayoutsByTabId = {
          tab: {
            ...candidate.terminalLayoutsByTabId.tab,
            ptyIdsByLeafId: { [LEAF]: 'different-process' }
          }
        }
      } else if (invalid === 'duplicate') {
        candidate.tabsByWorktree[SOURCE] = prior.tabsByWorktree[SOURCE]
      } else if (invalid === 'revision') {
        candidate.tabsByWorktree[DESTINATION][0].workspaceMoveRevision = 0
      } else {
        const remotePty = 'ssh:connection:retained'
        prior.tabsByWorktree[SOURCE][0].ptyId = remotePty
        prior.terminalLayoutsByTabId.tab.ptyIdsByLeafId![LEAF] = remotePty
        store.setWorkspaceSession(prior)
        candidate.tabsByWorktree[DESTINATION][0].ptyId = remotePty
        candidate.terminalLayoutsByTabId.tab.ptyIdsByLeafId![LEAF] = remotePty
      }
      store.setWorkspaceSession(candidate)
      expect(store.getWorkspaceSession().tabsByWorktree[SOURCE]).toHaveLength(1)
      expect(store.getWorkspaceSession().tabsByWorktree[DESTINATION]).toEqual([])
      expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab).toEqual(
        prior.terminalLayoutsByTabId.tab
      )
      expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey).toEqual(
        prior.terminalPtyIncarnationsByPaneKey
      )
    }
  )
  it('accepts coalesced moves while refusing an intermediate delayed save', () => {
    const store = createStore()
    store.setWorkspaceSession(initial())
    const intermediate = moved(store.getWorkspaceSession())
    const returned = moved(intermediate, DESTINATION, SOURCE)
    store.setWorkspaceSession(returned)
    store.setWorkspaceSession(intermediate)
    expect(store.getWorkspaceSession().tabsByWorktree[DESTINATION]).toEqual([])
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE][0].workspaceMoveRevision).toBe(2)
    const third = moved(returned)
    const fourth = moved(third, DESTINATION, SOURCE)
    const fifth = moved(fourth)
    store.setWorkspaceSession(fifth)
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE]).toEqual([])
    expect(store.getWorkspaceSession().tabsByWorktree[DESTINATION][0].workspaceMoveRevision).toBe(5)
  })
  it.each([SOURCE, DESTINATION])('keeps rejected ownership when only %s was fenced', (fenced) => {
    const store = createStore()
    const before = initial()
    before.terminalTopologyRevisionByRepoId = { [fenced]: 1 }
    store.setWorkspaceSession(before)
    const rejected = moved(store.getWorkspaceSession())
    rejected.tabsByWorktree[DESTINATION][0].workspaceMoveRevision = 0
    store.setWorkspaceSession(rejected)
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE]).toHaveLength(1)
    expect(store.getWorkspaceSession().tabsByWorktree[DESTINATION]).toEqual([])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab).toEqual(
      before.terminalLayoutsByTabId.tab
    )
    const retry = moved(rejected, DESTINATION, SOURCE)
    retry.tabsByWorktree[SOURCE][0].workspaceMoveRevision = 2
    store.setWorkspaceSession(retry)
    const valid = moved(store.getWorkspaceSession())
    store.setWorkspaceSession(valid)
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE]).toEqual([])
    expect(store.getWorkspaceSession().tabsByWorktree[DESTINATION][0].workspaceMoveRevision).toBe(3)
  })
  it('retains an unspawned sibling leaf when moving a live tab', () => {
    const store = createStore()
    const before = initial()
    before.terminalLayoutsByTabId.tab.root = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF },
      second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
    }
    store.setWorkspaceSession(before)
    store.setWorkspaceSession(moved(store.getWorkspaceSession()))
    expect(store.getWorkspaceSession().tabsByWorktree[SOURCE]).toEqual([])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId.tab).toEqual(
      before.terminalLayoutsByTabId.tab
    )
  })
})
