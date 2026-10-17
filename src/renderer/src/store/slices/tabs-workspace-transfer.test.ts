import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()

describe('moving a live chat out of its workspace', () => {
  let store: ReturnType<typeof createTestStore>
  const source = 'source',
    target = 'target'
  beforeEach(() => {
    store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [source, target].map((id) => makeWorktree({ id, repoId: 'repo1', hostId: 'local' }))
      }
    })
    store.getState().ensureWorktreeRootGroup(target)
  })

  it('preserves the exact PTY, session metadata, pane layout and pending reconnect', () => {
    const tab = store.getState().createTab(source)
    const sibling = store.getState().createTab(source)
    store.getState().setAiVaultTabTitle(tab.id, {
      agent: 'codex',
      sessionId: 'saved-provider-id',
      title: 'Existing conversation'
    })
    store.setState({
      ptyIdsByTabId: { [tab.id]: ['same-live-pty'] },
      pendingReconnectTabByWorktree: { [source]: [tab.id, sibling.id] }
    })
    const before = store.getState()
    const unified = before.unifiedTabsByWorktree[source].find((item) => item.entityId === tab.id)!
    expect(before.moveTerminalTabToWorkspace(unified.id, target)).toBe(true)
    const after = store.getState()
    expect(after.tabsByWorktree[source].map((item) => item.id)).toEqual([sibling.id])
    expect(after.tabsByWorktree[target][0].aiVaultTitle).toEqual(
      before.tabsByWorktree[source][0].aiVaultTitle
    )
    expect(after.tabsByWorktree[target][0].workspaceMoveRevision).toBe(1)
    expect(after.ptyIdsByTabId).toBe(before.ptyIdsByTabId)
    expect(after.terminalLayoutsByTabId).toBe(before.terminalLayoutsByTabId)
    expect(after.pendingReconnectTabByWorktree).toMatchObject({
      [source]: [sibling.id],
      [target]: [tab.id]
    })
    expect(after.unifiedTabsByWorktree[target][0]).toMatchObject({
      id: unified.id,
      entityId: tab.id,
      worktreeId: target,
      groupId: after.groupsByWorktree[target][0].id
    })
  })

  it('combines tabs from different folders while preserving the original execution folder', () => {
    seedStore(store, {
      worktreesByRepo: {
        repo1: [source, target].map((id) =>
          makeWorktree({ id, repoId: 'repo1', hostId: 'local', path: `/tmp/${id}` })
        )
      }
    })
    const tab = store.getState().createTab(source)
    const unified = store.getState().unifiedTabsByWorktree[source][0]
    const existing = store.getState().createTab(target)
    const before = store.getState()
    const targetGroup = before.groupsByWorktree[target][0]
    expect(
      before.moveTerminalTabToWorkspace(unified.id, target, { groupId: targetGroup.id, index: 0 })
    ).toBe(true)
    const after = store.getState()
    expect(after.tabsByWorktree[source]).toEqual([])
    expect(after.tabsByWorktree[target].map((item) => item.id)).toEqual([tab.id, existing.id])
    expect(after.tabsByWorktree[target][0].startupCwd).toBe('/tmp/source')
    expect(after.groupsByWorktree[target][0].tabOrder).toEqual([
      unified.id,
      before.unifiedTabsByWorktree[target][0].id
    ])
  })

  it('inserts a detached tab into an occupied same-folder bar without replacing sessions', () => {
    const sourcePath = store.getState().getKnownWorktreeById(source, 'local')!.path
    seedStore(store, {
      worktreesByRepo: {
        repo1: [source, target].map((id) =>
          makeWorktree({ id, repoId: 'repo1', hostId: 'local', path: sourcePath })
        )
      }
    })
    const review = store.getState().createTab(source)
    const anthony = store.getState().createTab(target)
    store.getState().setAiVaultTabTitle(review.id, {
      agent: 'codex',
      sessionId: 'same-provider-session',
      title: 'Review'
    })
    const before = store.getState()
    const unified = before.unifiedTabsByWorktree[source][0]
    const targetGroup = before.groupsByWorktree[target][0]
    const layouts = before.terminalLayoutsByTabId
    expect(
      before.moveTerminalTabToWorkspace(unified.id, target, { groupId: targetGroup.id, index: 0 })
    ).toBe(true)
    const after = store.getState()
    expect(after.tabsByWorktree[target].map((tab) => tab.id)).toEqual([review.id, anthony.id])
    expect(after.groupsByWorktree[target][0].tabOrder).toEqual([
      unified.id,
      before.unifiedTabsByWorktree[target][0].id
    ])
    expect(after.tabsByWorktree[target][0].aiVaultTitle?.sessionId).toBe('same-provider-session')
    expect(after.tabBarOrderByWorktree[target]).toEqual([review.id, anthony.id])
    expect(after.unifiedTabsByWorktree[target].map((tab) => tab.sortOrder)).toEqual([0, 1])
    expect(after.terminalLayoutsByTabId).toBe(layouts)
    expect(after.tabsByWorktree[source]).toEqual([])
  })

  it('rejects a remote destination even when the folder path matches', () => {
    store.getState().createTab(source)
    const unified = store.getState().unifiedTabsByWorktree[source][0]
    store.setState({
      repos: [
        ...store.getState().repos,
        {
          ...store.getState().repos[0],
          id: 'remote',
          connectionId: 'other',
          executionHostId: 'ssh:other'
        }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: source, repoId: 'repo1', hostId: 'local' })],
        remote: [makeWorktree({ id: target, repoId: 'remote', hostId: 'ssh:other' })]
      }
    })
    const before = store.getState()
    expect(before.moveTerminalTabToWorkspace(unified.id, target)).toBe(false)
    expect(store.getState()).toBe(before)
  })

  it('rejects remote-owned tabs without modifying their process or host state', () => {
    store.getState().createTab(source)
    const unified = store.getState().unifiedTabsByWorktree[source][0]
    store.setState({
      unifiedTabsByWorktree: { [source]: [{ ...unified, executionHostId: 'ssh:other' }] }
    })
    const before = store.getState()
    expect(before.moveTerminalTabToWorkspace(unified.id, target)).toBe(false)
    expect(store.getState()).toBe(before)
  })

  it('keeps empty sibling groups, selection, and the original execution folder', () => {
    const tab = store.getState().createTab(source)
    const other = store.getState().createTab(source)
    const root = store.getState().unifiedTabsByWorktree[source][0].groupId
    const empty = store
      .getState()
      .createEmptySplitGroup(source, root, 'right', { activate: false })!
    const before = store.getState()
    const unified = before.unifiedTabsByWorktree[source].find((item) => item.entityId === tab.id)!
    expect(before.moveTerminalTabToWorkspace(unified.id, target)).toBe(true)
    expect(store.getState().groupsByWorktree[source].some((group) => group.id === empty)).toBe(true)
    expect(store.getState().activeTabIdByWorktree[source]).toBe(other.id)
    expect(store.getState().tabsByWorktree[target][0]).toMatchObject({
      startupCwd: before.getKnownWorktreeById(source, 'local')!.path,
      relocatedFromWorktreeIds: [source]
    })
  })

  it('keeps a valid empty root after moving the only terminal', () => {
    store.getState().createTab(source)
    const unified = store.getState().unifiedTabsByWorktree[source][0]
    expect(store.getState().moveTerminalTabToWorkspace(unified.id, target)).toBe(true)
    const after = store.getState()
    expect(after.groupsByWorktree[source]).toHaveLength(1)
    expect(after.groupsByWorktree[source][0].id).toBe(after.activeGroupIdByWorktree[source])
    expect(after.groupsByWorktree[source][0].tabOrder).toEqual([])
  })
  it('keeps completion status with the moved tab and ignores later old-owner hooks', () => {
    const tab = store.getState().createTab(source)
    const paneKey = `${tab.id}:11111111-1111-4111-8111-111111111111`
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'done', agentType: 'claude', prompt: 'Finished' },
        'Claude',
        undefined,
        { worktreeId: source, tabId: tab.id }
      )
    const before = store.getState().agentStatusByPaneKey[paneKey]
    const unified = store.getState().unifiedTabsByWorktree[source][0]
    expect(store.getState().moveTerminalTabToWorkspace(unified.id, target)).toBe(true)
    expect(store.getState().agentStatusByPaneKey[paneKey]).toEqual({
      ...before,
      worktreeId: target
    })
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'done', agentType: 'claude', prompt: 'Still finished' },
        'Claude',
        undefined,
        { worktreeId: source, tabId: tab.id }
      )
    expect(store.getState().agentStatusByPaneKey[paneKey].worktreeId).toBe(target)
  })
})
