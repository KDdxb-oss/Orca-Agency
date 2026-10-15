// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { placeWorkspaceAtEdge } from '@/lib/workspace-split-layout'
import type { ChatSidebarSettings } from '../../../../shared/chat-sidebar-settings'
import { chatSidebarListItems } from './chat-sidebar-groups'
import { chatRow, chatState, chatWorktree } from './chat-sidebar-test-fixtures'
import { useChatSidebarSectionToggle } from './use-chat-sidebar-section-toggle'
import { useRevealWorkingChatFolders } from './use-reveal-working-chat-folders'

const initialState = useAppStore.getInitialState()
const id = 'chat:folder:Acme'
const persist = vi.fn().mockResolvedValue(undefined)
const defaults = {
  working: true,
  split: true,
  query: '',
  groupBy: 'folder' as ChatSidebarSettings['groupBy'],
  collapseDoneFolders: true,
  hiddenFolders: [] as string[]
}

function renderFolder(initial = defaults) {
  return renderHook(
    (props) => {
      const collapsed = useAppStore((s) => s.collapsedGroups)
      const settings: ChatSidebarSettings = {
        groupBy: props.groupBy,
        collapseDoneFolders: props.collapseDoneFolders,
        hiddenFolders: props.hiddenFolders
      }
      const state = chatState()
      state.settings!.chatSidebar = settings
      const rows = [
        chatRow({ id: 'active', state: props.working ? 'working' : 'idle' }),
        chatRow({ id: 'history', tabId: null, completed: true }),
        chatRow({
          id: 'other',
          tabId: 'b',
          folder: 'Other',
          worktree: { ...chatWorktree, id: 'other' }
        })
      ]
      const splits = props.split
        ? placeWorkspaceAtEdge([], chatWorktree.id, 'other', 'right', 'joined')
        : []
      const items = chatSidebarListItems(rows, state, props.query, splits, collapsed)
      useRevealWorkingChatFolders(
        items,
        props.query,
        props.groupBy === 'folder' && props.collapseDoneFolders
      )
      const toggle = useChatSidebarSectionToggle()
      const match = items.find((item) => item.kind === 'heading' && item.id === id)
      return { heading: match?.kind === 'heading' ? match : undefined, toggle }
    },
    { initialProps: initial }
  )
}

describe('working chat folder reveal', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialState, collapsedGroups: new Set([id]) }, true)
    persist.mockClear()
    Object.assign(window, { api: { ui: { set: persist } } })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('reveals a working chat returning from a split once, then respects manual collapse', () => {
    const view = renderFolder()
    expect(view.result.current.heading?.collapsed).toBe(true)
    view.rerender({ ...defaults, split: false })
    expect(view.result.current.heading?.collapsed).toBe(false)
    act(() => {
      const heading = view.result.current.heading
      if (!heading || heading.kind !== 'heading') {
        throw new Error('Folder heading missing')
      }
      view.result.current.toggle(heading)
    })
    view.rerender({ ...defaults, split: false })
    expect(view.result.current.heading?.collapsed).toBe(true)
    expect(persist).toHaveBeenLastCalledWith({ collapsedGroups: [id] })
    view.rerender({ ...defaults, split: false, working: false })
    view.rerender({ ...defaults, split: false })
    expect(view.result.current.heading?.collapsed).toBe(true)
  })

  it('keeps idle chats returning from a split collapsed until manually opened', () => {
    const view = renderFolder({ ...defaults, working: false })
    view.rerender({ ...defaults, working: false, split: false })
    view.rerender({ ...defaults, split: false })
    expect(useAppStore.getState().collapsedGroups.has(id)).toBe(true)
  })

  it('keeps manually collapsed working folders collapsed on mount and ordinary new turns', () => {
    const view = renderFolder({ ...defaults, split: false })
    view.rerender({ ...defaults, split: false, working: false })
    view.rerender({ ...defaults, split: false })
    expect(view.result.current.heading?.collapsed).toBe(true)
    view.unmount()
    renderFolder({ ...defaults, split: false })
    expect(useAppStore.getState().collapsedGroups.has(id)).toBe(true)
  })

  it.each(['groupBy', 'collapseDoneFolders'] as const)(
    'does not reopen a folder after changing %s',
    (setting) => {
      const view = renderFolder()
      view.rerender({
        ...defaults,
        groupBy: setting === 'groupBy' ? 'status' : 'folder',
        collapseDoneFolders: setting !== 'collapseDoneFolders'
      })
      view.rerender({ ...defaults, split: false })
      expect(useAppStore.getState().collapsedGroups.has(id)).toBe(true)
    }
  )

  it('does not reopen on unhiding a folder that contains a working chat', () => {
    const view = renderFolder()
    view.rerender({ ...defaults, hiddenFolders: ['Acme'] })
    view.rerender({ ...defaults, split: false })
    expect(useAppStore.getState().collapsedGroups.has(id)).toBe(true)
  })

  it('preserves a collapse made during search when clearing search after a split return', () => {
    const view = renderFolder()
    act(() => useAppStore.getState().toggleCollapsedGroup(id))
    view.rerender({ ...defaults, query: 'Chat' })
    view.rerender({ ...defaults, query: 'Chat', split: false })
    act(() => useAppStore.getState().toggleCollapsedGroup(id))
    view.rerender({ ...defaults, split: false })
    expect(useAppStore.getState().collapsedGroups.has(id)).toBe(true)
  })
})
