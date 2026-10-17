import { describe, expect, it, vi } from 'vitest'
import { captureClosedChatTabCompletion, closedChatSidebarPatch } from './chat-sidebar-tab-close'
import { chatSidebarPreferencePatch } from '@/components/sidebar/chat-sidebar-identity'
import { buildChatSidebarRows } from '@/components/sidebar/chat-sidebar-rows'
import { chatSidebarListItems } from '@/components/sidebar/chat-sidebar-groups'
import {
  chatRow,
  chatSession,
  chatState,
  chatTab,
  chatWorktree
} from '@/components/sidebar/chat-sidebar-test-fixtures'
import { createTestStore } from '@/store/slices/store-test-helpers'

describe('closed chat sidebar lifecycle', () => {
  it('marks an idle chat Done only after its tab actually closes', async () => {
    const store = createTestStore()
    const state = chatState({ tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] } })
    state.settings!.chatSidebar = {}
    store.setState({
      ...state,
      updateSettings: async (updates) => {
        store.setState((current) => ({ settings: { ...current.settings!, ...updates } }))
      }
    })
    const complete = captureClosedChatTabCompletion(store.getState, 'a')
    expect(complete).toBeTypeOf('function')
    expect(store.getState().settings?.chatSidebar?.completed).toBeUndefined()

    store.setState({ tabsByWorktree: { [chatWorktree.id]: [] } })
    complete?.()
    await vi.waitFor(() =>
      expect(Object.values(store.getState().settings?.chatSidebar?.completed ?? {})).toEqual([
        expect.objectContaining({ done: true, closedTabId: 'a' })
      ])
    )
  })
  it('preserves existing history status until the user closes or completes a chat', () => {
    const session = chatSession('session-b')
    const state = chatState()
    state.settings!.chatSidebar = { historySince: 0 }
    const saved = buildChatSidebarRows(state, [session], 10_000)
    expect(saved[0].completed).toBe(false)
    state.settings!.chatSidebar = {
      ...state.settings!.chatSidebar,
      ...chatSidebarPreferencePatch(saved, state.settings!.chatSidebar, 10_000)
    }
    state.tabsByWorktree[chatWorktree.id] = [chatTab('b', { createdAt: 10_000 })]
    const resumed = buildChatSidebarRows(state, [session], 10_000)
    expect(resumed[0]).toMatchObject({ completed: false, timestamp: 2_000 })
    expect(state.settings!.chatSidebar.completed).toBeUndefined()
  })
  it('keeps closed chats as separate Done entries without changing their activity time', () => {
    const session = chatSession('session-b')
    const state = chatState({ tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b')] } })
    const before = buildChatSidebarRows(state, [session], 10_000)
    const closing = before.filter((row) => row.tabId === 'b')
    state.tabsByWorktree[chatWorktree.id] = [chatTab('a')]
    state.settings!.chatSidebar = closedChatSidebarPatch(
      closing,
      before.filter((row) => row.tabId !== 'b'),
      {},
      10_000
    )
    const rows = buildChatSidebarRows(state, [session], 10_000)
    const saved = rows.find((row) => row.sessionKey === closing[0].sessionKey)!
    expect(saved).toMatchObject({ tabId: null, completed: true, timestamp: 2_000 })
    expect(
      chatSidebarListItems(rows, state, '').find((item) => item.id === saved.id)
    ).toMatchObject({ subTab: false })
    expect(
      chatSidebarListItems(rows, state, '').some(
        (item) => item.kind === 'heading' && item.label === 'Done (1)'
      )
    ).toBe(true)
    state.tabsByWorktree[chatWorktree.id].push(chatTab('b'))
    expect(
      buildChatSidebarRows(state, [session], 11_000).find((row) => row.tabId === 'b')?.completed
    ).toBe(true)
  })

  it('does not mark a still-open duplicate done', () => {
    const a = chatRow(),
      b = chatRow({ tabId: 'b', id: 'duplicate' })
    expect(closedChatSidebarPatch([a], [b], {}, 10_000).completed).toEqual({})
    expect(closedChatSidebarPatch([b], [], {}, 11_000).completed?.[a.id].done).toBe(true)
  })
})
