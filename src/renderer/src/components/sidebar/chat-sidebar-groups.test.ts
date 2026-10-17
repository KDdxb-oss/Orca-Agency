import { describe, expect, it } from 'vitest'
import { chatSidebarListItems } from './chat-sidebar-groups'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatRow, chatState, chatTab, chatWorktree } from './chat-sidebar-test-fixtures'
import { placeWorkspaceAtEdge, removeWorkspaceFromSplit } from '@/lib/workspace-split-layout'

describe('workspace chat groups', () => {
  it('collapses statuses independently without losing their counts or nested layout', () => {
    const source = chatState({
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b')] }
    })
    const rows = [
      chatRow({ id: 'a', tabId: 'a' }),
      chatRow({ id: 'b', tabId: 'b' }),
      chatRow({ id: 'closed', tabId: null, completed: true })
    ]
    const items = chatSidebarListItems(rows, source, '', [], new Set(['chat:status:In progress']))
    expect(items.filter((item) => item.kind === 'heading')).toEqual([
      { kind: 'heading', id: 'chat:status:In progress', label: 'In Progress (2)', collapsed: true },
      { kind: 'heading', id: 'chat:status:Done', label: 'Done (1)', collapsed: false }
    ])
    expect(items.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual(['closed'])
    const reopened = chatSidebarListItems(rows, source, '', [], new Set(['chat:status:Done']))
    expect(reopened.filter((item) => item.kind === 'chat').map((item) => item.subTab)).toEqual([
      false,
      true
    ])
  })

  it('keeps restored idle tabs nested before any provider status or history scan arrives', () => {
    const source = chatState({
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b'), chatTab('c')] }
    })
    const persisted = JSON.parse(JSON.stringify(source.tabsByWorktree))
    const restored = chatState({ tabsByWorktree: persisted })
    const items = chatSidebarListItems(
      buildChatSidebarRows(restored, [], 10_000),
      restored,
      ''
    ).filter((item) => item.kind === 'chat')
    expect(items.map((item) => [item.row.tabId, item.subTab, item.row.state])).toEqual([
      ['a', false, 'idle'],
      ['b', true, 'idle'],
      ['c', true, 'idle']
    ])
    expect(items.filter((item) => item.showFolder)).toHaveLength(1)
  })
  const state = chatState({ tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b')] } })
  const main = chatRow({ id: 'main', tabId: 'a', timestamp: 10 })
  const child = chatRow({
    id: 'child',
    tabId: 'b',
    title: 'Claude review',
    state: 'working',
    timestamp: 20
  })
  const other = chatRow({ id: 'other', worktree: { ...chatWorktree, id: 'other' }, timestamp: 100 })

  it('adds an older reopened session after the existing resident main and sub-tab', () => {
    const reopenedState = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [chatTab('a'), chatTab('b'), chatTab('old', { createdAt: 9_000 })]
      }
    })
    const reopened = chatRow({ id: 'old', tabId: 'old', createdAt: 1 })
    const items = chatSidebarListItems(
      [{ ...main, createdAt: 5_000 }, { ...child, createdAt: 6_000 }, reopened],
      reopenedState,
      ''
    ).filter((item) => item.kind === 'chat')
    expect(items.map((item) => [item.id, item.subTab])).toEqual([
      ['main', false],
      ['child', true],
      ['old', true]
    ])
  })

  it('uses the current tab strip order for the bracket parent after a drag', () => {
    const reordered = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [chatTab('b', { createdAt: 6_000 }), chatTab('a', { createdAt: 1_000 })]
      }
    })
    const items = chatSidebarListItems(
      [
        { ...main, ownsWorkspaceName: true },
        { ...child, ownsWorkspaceName: false }
      ],
      reordered,
      ''
    ).filter((item) => item.kind === 'chat')
    expect(items.map((item) => [item.id, item.subTab])).toEqual([
      ['child', false],
      ['main', true]
    ])
  })

  it('brackets split workspaces together and restores independent sorting after unsplitting', () => {
    const older = { ...other, timestamp: 1 }
    const middle = {
      ...other,
      id: 'middle',
      worktree: { ...chatWorktree, id: 'middle' },
      timestamp: 50
    }
    const splits = placeWorkspaceAtEdge([], older.worktree.id, main.worktree.id, 'right', 'joined')
    const joined = chatSidebarListItems([main, child, middle, older], state, '', splits)
    const chats = joined.filter((item) => item.kind === 'chat')
    expect(chats.map((item) => item.id)).toEqual(['main', 'child', 'other', 'middle'])
    expect(chats.map((item) => item.splitId)).toEqual(['joined', 'joined', 'joined', undefined])
    expect(chats[0].splitStart).toBe(true)
    expect(chats[2].splitEnd).toBe(true)
    expect(chats[2].subTab).toBe(false)
    const unjoined = chatSidebarListItems(
      [main, child, middle, older],
      state,
      '',
      removeWorkspaceFromSplit(splits, older.worktree.id)
    )
    expect(unjoined.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual([
      'main',
      'child',
      'middle',
      'other'
    ])
    expect(unjoined.filter((item) => item.kind === 'chat').some((item) => item.splitId)).toBe(false)
  })

  it('respects hidden folders, search and multi-folder split windows', () => {
    const splits = placeWorkspaceAtEdge([], other.worktree.id, main.worktree.id, 'right', 'joined')
    const folderState = chatState({
      ...state,
      settings: { ...state.settings!, chatSidebar: { groupBy: 'folder' } }
    })
    const moved = { ...other, folder: 'Other folder' }
    const items = chatSidebarListItems([main, child, moved], folderState, 'review', splits)
    expect(items[0]).toMatchObject({ label: 'Split workspaces (3)' })
    expect(items.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual([
      'main',
      'child',
      'other'
    ])
    const hidden = chatState({
      ...folderState,
      settings: { ...state.settings!, chatSidebar: { hiddenFolders: ['Other folder'] } }
    })
    expect(
      chatSidebarListItems([main, child, moved], hidden, '', splits)
        .filter((item) => item.kind === 'chat')
        .some((item) => item.splitId)
    ).toBe(false)
  })

  it('orders whole groups by activity while keeping the first chat as the parent', () => {
    const items = chatSidebarListItems([other, child, main], state, '')
    expect(
      items
        .filter((item) => item.kind === 'chat')
        .map((item) => [item.id, item.subTab, item.showFolder])
    ).toEqual([
      ['main', false, false],
      ['child', true, true],
      ['other', false, true]
    ])
    expect(items[0]).toMatchObject({ kind: 'heading', label: 'In Progress (3)' })
    expect(
      chatSidebarListItems(
        [
          { ...main, completed: true },
          { ...child, completed: true, state: 'idle' }
        ],
        state,
        ''
      )[0]
    ).toMatchObject({ label: 'Done (2)' })
  })

  it('preserves parent context in search without reintroducing hidden folders or automation chats', () => {
    const filtered = chatState({
      ...state,
      settings: { ...state.settings!, chatSidebar: { hiddenFolders: ['Hidden'] } }
    })
    const items = chatSidebarListItems(
      [
        main,
        child,
        { ...main, id: 'unrelated-sibling', title: 'Other subject' },
        { ...other, folder: 'Hidden' },
        { ...other, id: 'bot', automated: true }
      ],
      filtered,
      'review'
    )
    expect(items.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual([
      'main',
      'child'
    ])
  })

  it('files moved siblings under the correct heading in Folder view', () => {
    const folderState = chatState({
      ...state,
      settings: { ...state.settings!, chatSidebar: { groupBy: 'folder' } }
    })
    const items = chatSidebarListItems([main, { ...child, folder: 'Other' }], folderState, '')
    expect(items.filter((item) => item.kind === 'heading').map((item) => item.label)).toEqual([
      'Other (1)',
      'Acme (1)'
    ])
    expect(items.filter((item) => item.kind === 'chat').every((item) => !item.subTab)).toBe(true)
  })

  it('keeps closed history separate from the LLM tabs currently open in a workspace', () => {
    const items = chatSidebarListItems(
      [
        { ...main, createdAt: 100, tabId: null },
        { ...child, createdAt: 200 }
      ],
      state,
      ''
    )
    expect(items.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual([
      'child',
      'main'
    ])
    expect(items.filter((item) => item.kind === 'chat').every((item) => !item.subTab)).toBe(true)
  })

  it('does not bracket historical chats merely because their old workspace is split', () => {
    const splits = placeWorkspaceAtEdge([], other.worktree.id, main.worktree.id, 'right', 'joined')
    const items = chatSidebarListItems(
      [main, child, other, { ...child, id: 'closed', tabId: null, state: 'idle' }],
      state,
      '',
      splits
    )
    const closed = items.find((item) => item.kind === 'chat' && item.id === 'closed')
    expect(closed).toMatchObject({ subTab: false, showFolder: true, splitId: undefined })
    expect(items.filter((item) => item.kind === 'chat' && item.splitId)).toHaveLength(3)
  })

  it('does not group workspaces on different hosts or merge distinct workspaces in the same directory', () => {
    const items = chatSidebarListItems([main, other, { ...child, hostId: 'ssh:box' }], state, '')
    expect(items.filter((item) => item.kind === 'chat').every((item) => !item.subTab)).toBe(true)
  })

  it('shows one folder footer beneath the resident workspace group', () => {
    const items = chatSidebarListItems([main, child], state, '')
    expect(items.filter((item) => item.kind === 'chat').map((item) => item.showFolder)).toEqual([
      false,
      true
    ])
  })

  it('keeps every LLM tab and excludes plain terminals, Markdown and browser tabs', () => {
    const tabs = Array.from({ length: 24 }, (_, index) => chatTab(`chat-${index}`))
    const source = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [
          ...tabs,
          chatTab('plain', { launchAgent: undefined, aiVaultTitle: null })
        ]
      },
      unifiedTabsByWorktree: {
        [chatWorktree.id]: (['editor', 'browser'] as const).map((contentType) => ({
          id: contentType,
          entityId: contentType,
          groupId: 'group',
          worktreeId: chatWorktree.id,
          contentType,
          label: contentType === 'editor' ? 'notes.md' : 'Website',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }))
      }
    })
    const items = chatSidebarListItems(buildChatSidebarRows(source, [], 10_000), source, '')
    const chats = items.filter((item) => item.kind === 'chat')
    expect(chats).toHaveLength(24)
    expect(chats.filter((item) => item.subTab)).toHaveLength(23)
    expect(chats[0].row.tabId).toBe('chat-0')
  })
})
