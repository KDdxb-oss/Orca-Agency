import { describe, expect, it } from 'vitest'
import { chatSidebarListItems } from './chat-sidebar-groups'
import { chatRow, chatState, chatTab, chatWorktree } from './chat-sidebar-test-fixtures'
import { placeWorkspaceAtEdge } from '@/lib/workspace-split-layout'

function source(groupBy: 'folder' | 'status' | 'recent', showOnlyInProgress = true) {
  const state = chatState({
    tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b'), chatTab('c')] }
  })
  return {
    ...state,
    settings: { ...state.settings!, chatSidebar: { groupBy, showOnlyInProgress } }
  }
}

const rows = [
  chatRow({ id: 'main', tabId: 'a', ownsWorkspaceName: true }),
  chatRow({ id: 'sub', tabId: 'b', state: 'idle' }),
  chatRow({ id: 'done-tab', tabId: 'c', completed: true }),
  chatRow({ id: 'history', tabId: null, completed: true }),
  chatRow({ id: 'done-folder', folder: 'Completed only', tabId: null, completed: true })
]

describe('chat sidebar in-progress filter', () => {
  it.each(['folder', 'status', 'recent'] as const)(
    'hides Done chats while retaining idle in-progress tabs under %s grouping',
    (groupBy) => {
      const items = chatSidebarListItems(rows, source(groupBy), '')
      expect(items.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual([
        'main',
        'sub'
      ])
      expect(items.filter((item) => item.kind === 'chat').map((item) => item.subTab)).toEqual([
        false,
        true
      ])
      expect(items.filter((item) => item.kind === 'heading').map((item) => item.label)).toEqual(
        groupBy === 'recent'
          ? []
          : groupBy === 'folder'
            ? ['Acme (2)', 'Completed only (0)']
            : ['In Progress (2)']
      )
    }
  )

  it('restores Done chats when disabled without changing the records or folder collapse state', () => {
    const state = source('folder', false)
    const before = JSON.stringify({ rows, state })
    const items = chatSidebarListItems(rows, state, '', [], new Set(['chat:folder:Acme']))
    expect(items.find((item) => item.id === 'chat:folder:Acme')).toMatchObject({
      label: 'Acme (4)',
      collapsed: true
    })
    expect(items.filter((item) => item.kind === 'chat').map((item) => item.id)).toEqual([
      'done-folder'
    ])
    expect(JSON.stringify({ rows, state })).toBe(before)
    expect(
      chatSidebarListItems(rows, state, '').filter((item) => item.kind === 'chat')
    ).toHaveLength(5)
  })

  it('promotes the remaining child when its completed parent is filtered out', () => {
    const items = chatSidebarListItems(
      rows.map((row) => (row.id === 'main' ? { ...row, completed: true } : row)),
      source('folder'),
      ''
    ).filter((item) => item.kind === 'chat')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'sub', subTab: false, showFolder: true })
  })

  it('keeps visible split panes bracketed and does not restore filtered chats through search', () => {
    const other = chatRow({
      id: 'other',
      worktree: { ...chatWorktree, id: 'other-workspace' },
      folder: 'Other folder'
    })
    const splits = placeWorkspaceAtEdge([], other.worktree.id, chatWorktree.id, 'right', 'split')
    const items = chatSidebarListItems([...rows, other], source('folder'), '', splits).filter(
      (item) => item.kind === 'chat'
    )
    expect(items.map((item) => item.id)).toEqual(['main', 'sub', 'other'])
    expect(items.map((item) => item.splitId)).toEqual(['split', 'split', 'split'])
    expect(items.map((item) => item.showFolder)).toEqual([false, true, true])
    expect(items[0].splitStart).toBe(true)
    expect(items[2].splitEnd).toBe(true)
    expect(chatSidebarListItems(rows, source('folder'), 'Completed only')).toMatchObject([
      { kind: 'heading', label: 'Completed only (0)' }
    ])
    expect(
      chatSidebarListItems(
        rows,
        {
          ...source('folder'),
          settings: {
            ...source('folder').settings,
            chatSidebar: {
              groupBy: 'folder',
              showOnlyInProgress: true,
              hiddenFolders: ['Acme', 'Completed only']
            }
          }
        },
        ''
      )
    ).toEqual([])
  })
})
