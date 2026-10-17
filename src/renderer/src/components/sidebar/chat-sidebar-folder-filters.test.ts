import { describe, expect, it } from 'vitest'
import { chatSidebarListItems } from './chat-sidebar-groups'
import { chatRow, chatState, chatTab, chatWorktree } from './chat-sidebar-test-fixtures'
import type { ChatSidebarSettings } from '../../../../shared/chat-sidebar-settings'
import { placeWorkspaceAtEdge } from '@/lib/workspace-split-layout'

const rows = [
  chatRow({ id: 'open', tabId: 'a', state: 'idle' }),
  chatRow({ id: 'closed', tabId: null }),
  chatRow({ id: 'done', folder: 'Finished', tabId: null, completed: true }),
  chatRow({ id: 'open-done', folder: 'Finished', tabId: 'b', completed: true })
].map((row) => ({ ...row, title: row.id }))

function items(settings: ChatSidebarSettings, query = '', collapsed = new Set<string>()) {
  const state = chatState({
    tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b')] }
  })
  return chatSidebarListItems(
    rows,
    { ...state, settings: { ...state.settings!, chatSidebar: settings } },
    query,
    [],
    collapsed
  )
}

describe('chat sidebar folder filters', () => {
  it('keeps a registered folder visible when Hide Done leaves no chat rows', () => {
    const state = chatState({
      projectGroups: [
        {
          id: 'example',
          name: 'Example',
          parentPath: '/clients/Example',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    state.settings!.chatSidebar = { groupBy: 'folder', showOnlyInProgress: true }
    const done = chatRow({ id: 'done-example', folder: 'Example', completed: true, tabId: null })
    expect(chatSidebarListItems([done], state, '')).toMatchObject([
      { kind: 'heading', id: 'chat:folder:Example', label: 'Example (0)' }
    ])
    expect(chatSidebarListItems([], state, '')).toMatchObject([
      { kind: 'heading', id: 'chat:folder:Example', label: 'Example (0)' }
    ])
    state.settings!.chatSidebar = { groupBy: 'folder', showOnlyOpenChats: true }
    expect(chatSidebarListItems([], state, '')).toEqual([])
    state.settings!.chatSidebar = {
      groupBy: 'folder',
      showOnlyOpenChats: true,
      showOnlyInProgress: true
    }
    expect(chatSidebarListItems([], state, '')).toMatchObject([
      { kind: 'heading', id: 'chat:folder:Example', label: 'Example (0)' }
    ])
  })

  it('does not expand a folder for an unprompted working startup snapshot', () => {
    const state = chatState()
    state.settings!.chatSidebar = { groupBy: 'folder', collapseDoneFolders: true }
    const row = chatRow({ state: 'working', promptBackedWorking: false })
    expect(
      chatSidebarListItems([row], state, '', [], new Set(['chat:folder:Acme']))[0]
    ).toMatchObject({ collapsed: true, workingChatIds: [] })
    expect(
      chatSidebarListItems(
        [{ ...row, promptBackedWorking: true }],
        state,
        '',
        [],
        new Set(['chat:folder:Acme'])
      )[0]
    ).toMatchObject({ collapsed: true, workingChatIds: [row.id] })
  })
  it('identifies a working folder on return from a split without overriding manual collapse', () => {
    const state = chatState()
    const preferences = new Set(['chat:folder:Acme'])
    state.settings!.chatSidebar = { groupBy: 'folder', collapseDoneFolders: true }
    const active = chatRow({ id: 'active', tabId: 'a', state: 'working' })
    const other = chatRow({
      id: 'other',
      tabId: 'b',
      folder: 'Other',
      worktree: { ...chatWorktree, id: 'other' }
    })
    const split = placeWorkspaceAtEdge([], chatWorktree.id, 'other', 'right', 'joined')
    expect(chatSidebarListItems([active, other], state, '', split, preferences)[0]).toMatchObject({
      label: 'Split workspaces (2)'
    })
    const detached = chatSidebarListItems([active, other], state, '', [], preferences)
    expect(detached.find((item) => item.id === 'chat:folder:Acme')).toMatchObject({
      collapsed: true,
      workingChatIds: ['active']
    })
    expect(detached.some((item) => item.kind === 'chat' && item.id === 'active')).toBe(false)
    expect(preferences.has('chat:folder:Acme')).toBe(true)
    state.settings!.chatSidebar.collapseDoneFolders = false
    expect(chatSidebarListItems([active], state, '', [], preferences)[0]).toMatchObject({
      collapsed: true
    })
  })

  it('does not reveal historical folder sections for a working chat in the split section', () => {
    const state = chatState()
    state.settings!.chatSidebar = { groupBy: 'folder', collapseDoneFolders: true }
    const active = chatRow({ id: 'active', tabId: 'a', state: 'working' })
    const other = chatRow({
      id: 'other',
      tabId: 'b',
      folder: 'Other',
      worktree: { ...chatWorktree, id: 'other' }
    })
    const history = chatRow({ id: 'history', tabId: null, completed: true })
    const split = placeWorkspaceAtEdge([], chatWorktree.id, 'other', 'right', 'joined')
    const result = chatSidebarListItems(
      [active, other, history],
      state,
      '',
      split,
      new Set(['chat:folder:Acme'])
    )
    expect(result.find((item) => item.id === 'chat:folder:Acme')).toMatchObject({
      collapsed: true,
      workingChatIds: []
    })
  })

  it.each(['folder', 'status', 'recent'] as const)(
    'only-open filtering keeps resident idle and Done tabs under %s grouping',
    (groupBy) => {
      expect(
        items({ groupBy, showOnlyOpenChats: true })
          .filter((item) => item.kind === 'chat')
          .map((item) => item.id)
      ).toEqual(['open', 'open-done'])
      expect(
        items({ groupBy, showOnlyOpenChats: true, showOnlyInProgress: true })
          .filter((item) => item.kind === 'chat')
          .map((item) => item.id)
      ).toEqual(['open'])
    }
  )

  it('automatically collapses only folders whose full membership is marked Done', () => {
    const settings = { groupBy: 'folder', collapseDoneFolders: true } as const
    const result = items(settings)
    expect(result.find((item) => item.id === 'chat:folder:Finished')).toMatchObject({
      collapsed: true,
      doneFolder: 'Finished',
      label: 'Finished (2)'
    })
    expect(result.find((item) => item.id === 'chat:folder:Acme')).toMatchObject({
      collapsed: false
    })
    expect(result.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual([
      'closed',
      'open'
    ])
    expect(items(settings, 'open-done')[0]).toMatchObject({ collapsed: true })
    expect(items(settings, 'closed')[0]).toMatchObject({ collapsed: false })
  })

  it('does not mistake a search result or only-open subset for an entirely Done folder', () => {
    const state = chatState()
    const mixed = rows.map((row) => ({ ...row, folder: 'Acme' }))
    const result = chatSidebarListItems(
      mixed,
      {
        ...state,
        settings: {
          ...state.settings!,
          chatSidebar: { groupBy: 'folder', collapseDoneFolders: true }
        }
      },
      'open-done'
    )
    expect(result[0]).toMatchObject({ collapsed: false })
    expect(result.some((item) => item.kind === 'chat' && item.id === 'open-done')).toBe(true)
  })

  it('allows manually expanding Done folders and preserves existing manual collapse preferences', () => {
    const settings = {
      groupBy: 'folder',
      collapseDoneFolders: true,
      expandedDoneFolders: ['Finished']
    } as const
    expect(
      items({ ...settings, expandedDoneFolders: [...settings.expandedDoneFolders] })
    ).toHaveLength(6)
    expect(
      items(
        { ...settings, expandedDoneFolders: [...settings.expandedDoneFolders] },
        '',
        new Set(['chat:folder:Acme'])
      )
        .filter((item) => item.kind === 'chat')
        .map((item) => item.id)
    ).toEqual(['done', 'open-done'])
    expect(items({ groupBy: 'folder', collapseDoneFolders: false })).toHaveLength(6)
    expect(items({ groupBy: 'status', collapseDoneFolders: true })[0]).toMatchObject({
      label: 'In Progress (2)',
      collapsed: false
    })
    expect(items({ groupBy: 'status' }, '', new Set(['chat:status:In progress']))[0]).toMatchObject(
      {
        label: 'In Progress (2)',
        collapsed: true
      }
    )
  })

  it('expands automatically when a Done folder acquires a chat still being reviewed', () => {
    const state = chatState()
    const result = chatSidebarListItems(
      rows.map((row) =>
        row.id === 'done' ? { ...row, completed: false, state: 'idle' as const } : row
      ),
      {
        ...state,
        settings: {
          ...state.settings!,
          chatSidebar: { groupBy: 'folder', collapseDoneFolders: true }
        }
      },
      ''
    )
    expect(result.find((item) => item.id === 'chat:folder:Finished')).toMatchObject({
      collapsed: false
    })
    expect(result.some((item) => item.kind === 'chat' && item.id === 'done')).toBe(true)
  })
})
