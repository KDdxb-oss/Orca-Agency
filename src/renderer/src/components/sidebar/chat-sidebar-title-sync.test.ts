import { beforeEach, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { chatRow, chatState, chatTab, chatWorktree } from './chat-sidebar-test-fixtures'
import { createTestStore, seedStore } from '@/store/slices/store-test-helpers'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  setChatSidebarTitle,
  syncChatSidebarTabTitles,
  updateChatSidebar
} from './chat-sidebar-preferences'

const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
beforeEach(() => vi.clearAllMocks())

function owner() {
  const store = createTestStore()
  seedStore(
    store,
    chatState({
      settings: createGlobalSettingsFixture(),
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b')] }
    })
  )
  store.setState({
    updateSettings: vi.fn(async (update) => {
      store.setState({ settings: { ...store.getState().settings!, ...update } })
    })
  })
  const rename = store.getState().setTabCustomTitle
  store.setState({ setTabCustomTitle: vi.fn(rename) })
  mocks.getState.mockImplementation(store.getState)
  return store
}

it('renames only the selected live tab and removes older alias names', async () => {
  const store = owner()
  const state = store.getState()
  state.settings!.chatSidebar = { titles: { alias: 'Earlier name', other: 'Other chat' } }
  await setChatSidebarTitle(chatRow({ id: 'chat', aliases: ['alias'] }), '  Renamed chat  ')
  expect(state.setTabCustomTitle).toHaveBeenCalledExactlyOnceWith('a', 'Renamed chat', {
    recordInteraction: false,
    syncSidebarTitle: false,
    sidebarTitleId: 'chat'
  })
  expect(store.getState().settings?.chatSidebar?.titles).toEqual({
    chat: 'Renamed chat',
    other: 'Other chat'
  })
  await setChatSidebarTitle(chatRow({ id: 'chat' }), ' ')
  expect(state.setTabCustomTitle).toHaveBeenLastCalledWith('a', null, {
    recordInteraction: false,
    syncSidebarTitle: false,
    sidebarTitleId: undefined
  })
  expect(store.getState().settings?.chatSidebar?.titles).toEqual({ other: 'Other chat' })
})

it('restores saved names onto idle or resumed tabs without replacing provider identity', async () => {
  const store = owner()
  const state = store.getState()
  await setChatSidebarTitle(chatRow({ id: 'closed', tabId: null }), 'Saved chat name')
  expect(state.setTabCustomTitle).not.toHaveBeenCalled()
  const provider = state.tabsByWorktree[chatWorktree.id][0].aiVaultTitle
  syncChatSidebarTabTitles([
    chatRow({ id: 'closed', tabId: 'a' }),
    chatRow({ id: 'sibling', tabId: 'b' }),
    chatRow({ id: 'missing', tabId: 'gone' })
  ])
  expect(state.setTabCustomTitle).toHaveBeenCalledExactlyOnceWith('a', 'Saved chat name', {
    recordInteraction: false,
    syncSidebarTitle: false,
    sidebarTitleId: 'closed'
  })
  expect(state.tabsByWorktree[chatWorktree.id][0].aiVaultTitle).toBe(provider)
  const rename = vi.mocked(state.setTabCustomTitle)
  rename.mockClear()
  syncChatSidebarTabTitles([chatRow({ id: 'closed' })])
  expect(rename).not.toHaveBeenCalled()
})

it('serializes filter toggles and renaming without dropping existing session and folder settings', async () => {
  const store = owner()
  const state = store.getState()
  state.settings!.chatSidebar = { hiddenFolders: ['Hidden'], completed: {} }
  await Promise.all([
    updateChatSidebar({ showOnlyOpenChats: true }),
    updateChatSidebar({ collapseDoneFolders: true }),
    setChatSidebarTitle(chatRow({ id: 'chat' }), 'Consistent name')
  ])
  expect(store.getState().settings?.chatSidebar).toEqual({
    hiddenFolders: ['Hidden'],
    completed: {},
    showOnlyOpenChats: true,
    collapseDoneFolders: true,
    titles: { chat: 'Consistent name' }
  })
})

it('accepts subsequent manual tab renames and clearing without restore fighting them', async () => {
  const store = owner()
  const row = buildChatSidebarRows(store.getState(), [], 10_000).find((row) => row.tabId === 'a')!
  await setChatSidebarTitle(row, 'Sidebar name')
  store.getState().setTabCustomTitle('a', 'Tab bar name', { recordInteraction: false })
  await vi.waitFor(() =>
    expect(store.getState().settings?.chatSidebar?.titles?.[row.id]).toBe('Tab bar name')
  )
  syncChatSidebarTabTitles(buildChatSidebarRows(store.getState(), [], 10_000))
  expect(store.getState().tabsByWorktree[chatWorktree.id][0].customTitle).toBe('Tab bar name')
  store.getState().setTabCustomTitle('a', null)
  await vi.waitFor(() =>
    expect(store.getState().settings?.chatSidebar?.titles?.[row.id]).toBeUndefined()
  )
  syncChatSidebarTabTitles(buildChatSidebarRows(store.getState(), [], 10_000))
  expect(store.getState().tabsByWorktree[chatWorktree.id][0].customTitle).toBeNull()
})

it('keeps sibling conversations distinct and cannot alternate their names on one split tab', async () => {
  const store = owner()
  const entries = Object.fromEntries(
    ['first', 'second'].map((id, index) => {
      const paneKey = makePaneKey('a', `${index + 1}1111111-1111-4111-8111-111111111111`)
      return [
        paneKey,
        {
          paneKey,
          state: 'done' as const,
          agentType: 'codex' as const,
          stateStartedAt: 2_000,
          updatedAt: 2_000,
          stateHistory: [],
          prompt: `Work on ${id}`,
          providerSession: { key: 'session_id' as const, id }
        }
      ]
    })
  )
  store.setState({ agentStatusByPaneKey: entries })
  const rows = buildChatSidebarRows(store.getState(), [], 10_000).filter((row) => row.tabId === 'a')
  expect(rows).toHaveLength(2)
  await setChatSidebarTitle(rows[0], 'First task')
  await setChatSidebarTitle(rows[1], 'Second task')
  vi.mocked(store.getState().setTabCustomTitle).mockClear()
  for (let i = 0; i < 3; i++) {
    syncChatSidebarTabTitles(buildChatSidebarRows(store.getState(), [], 10_000))
  }
  expect(store.getState().setTabCustomTitle).not.toHaveBeenCalled()
  expect(
    buildChatSidebarRows(store.getState(), [], 10_000)
      .filter((row) => row.tabId === 'a')
      .map((row) => row.title)
      .sort()
  ).toEqual(['First task', 'Second task'])
})

it('drops a mirrored name when the same tab starts a different conversation', async () => {
  const store = owner()
  const row = buildChatSidebarRows(store.getState(), [], 10_000).find((row) => row.tabId === 'a')!
  await setChatSidebarTitle(row, 'Original conversation')
  store.getState().setAiVaultTabTitle('a', {
    agent: 'codex',
    sessionId: 'new-session',
    title: 'New conversation'
  })
  syncChatSidebarTabTitles(buildChatSidebarRows(store.getState(), [], 10_000))
  expect(store.getState().tabsByWorktree[chatWorktree.id][0].customTitle).toBeNull()
  expect(store.getState().settings?.chatSidebar?.titles?.[row.id]).toBe('Original conversation')
})
