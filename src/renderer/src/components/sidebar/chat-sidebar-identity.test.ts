import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { chatSidebarPreferencePatch, isChatCompleted } from './chat-sidebar-identity'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { activeChatTarget, isChatRowSelected } from './chat-sidebar-selection'
import { chatFallbackId, chatSessionKey } from './chat-sidebar-types'
import { chatRow, chatSession, chatState, chatWorktree } from './chat-sidebar-test-fixtures'
import { chatSessionSnapshot, chatSnapshotSessions } from './chat-sidebar-session-snapshot'

const key = chatSessionKey('local', 'codex', 'session-a')
const fallback = chatFallbackId('local', 'a')
const leafA = '77777777-7777-4777-8777-777777777777'
const leafB = '88888888-8888-4888-8888-888888888888'

describe('chat sidebar preferences', () => {
  it('preserves original creation time when a chat closes and resumes in a new tab', () => {
    const first = chatSidebarPreferencePatch([chatRow({ createdAt: 100 })], {}, 200)
    expect(first?.sessions?.[key].createdAt).toBe(100)
    const resumed = chatSidebarPreferencePatch(
      [chatRow({ tabId: 'resumed', createdAt: 300 })],
      { sessions: first?.sessions },
      400
    )
    expect(resumed).toBeNull()
  })
  it('moves a name and completion to the provider session once it is known', () => {
    const patch = chatSidebarPreferencePatch(
      [chatRow({ aliases: [fallback], turnStartedAt: 1 })],
      {
        titles: { [fallback]: 'Early name' },
        completed: { [fallback]: { activityAt: 1, at: 2 } }
      },
      10
    )
    expect(patch).toEqual({
      sessions: { [key]: { worktreeId: chatWorktree.id } },
      titles: { [key]: 'Early name' },
      completed: { [key]: { activityAt: 1, at: 2 } }
    })
  })

  it('writes nothing when every preference is already current', () => {
    expect(
      chatSidebarPreferencePatch(
        [chatRow()],
        { sessions: { [key]: { worktreeId: chatWorktree.id } } },
        10
      )
    ).toBeNull()
  })

  it('pins the workspace name owner and drops the pin when the chat moves workspaces', () => {
    const owned = chatSidebarPreferencePatch([chatRow({ ownsWorkspaceName: true })], {}, 10)
    expect(owned?.sessions?.[key]).toEqual({ worktreeId: chatWorktree.id, ownsWorkspaceName: true })
    const moved = chatSidebarPreferencePatch(
      [chatRow({ worktree: { ...chatWorktree, id: 'other' } })],
      { sessions: { [key]: { worktreeId: chatWorktree.id, ownsWorkspaceName: true } } },
      10
    )
    expect(moved?.sessions?.[key]).toEqual({ worktreeId: 'other' })
  })

  it('keeps a title-only chat Done until a new turn is proven', () => {
    const titleRow = chatRow({
      id: fallback,
      sessionKey: null,
      activityFromState: true,
      turnStartedAt: 1
    })
    const markedIdle = { [fallback]: { activityAt: 1, at: 5 } }
    expect(isChatCompleted({ ...titleRow, state: 'working' }, markedIdle[fallback])).toBe(true)
    expect(
      chatSidebarPreferencePatch([{ ...titleRow, state: 'working' }], { completed: markedIdle }, 9)
    ).toBeNull()
    const prompted = { ...titleRow, state: 'working' as const, turnStartedAt: 9 }
    expect(isChatCompleted(prompted, markedIdle[fallback])).toBe(false)
    expect(chatSidebarPreferencePatch([prompted], { completed: markedIdle }, 9)).toEqual({
      completed: { [fallback]: { activityAt: 1, at: 5, done: false, closedTabId: undefined } }
    })

    const markedWorking = { [fallback]: { activityAt: 1, at: 5, working: true } }
    expect(isChatCompleted({ ...titleRow, state: 'working' }, markedWorking[fallback])).toBe(true)
    expect(
      chatSidebarPreferencePatch(
        [{ ...titleRow, state: 'working' }],
        { completed: markedWorking },
        9
      )
    ).toBeNull()
    expect(chatSidebarPreferencePatch([titleRow], { completed: markedWorking }, 9)).toEqual({
      completed: { [fallback]: { activityAt: 1, at: 5, working: false } }
    })
  })

  it('never reopens a hook-tracked chat from a stale working snapshot', () => {
    const row = chatRow({ state: 'working', turnStartedAt: 4 })
    const completion = { activityAt: 1, at: 5 }
    expect(isChatCompleted(row, completion)).toBe(true)
    expect(
      chatSidebarPreferencePatch(
        [row],
        { sessions: { [key]: { worktreeId: chatWorktree.id } }, completed: { [key]: completion } },
        9
      )
    ).toBeNull()
  })
})

describe('chat sidebar session snapshots', () => {
  it('upgrades old headless snapshots after scanning and restores later interactive chats', () => {
    const headless = chatSession('session-headless', { agent: 'claude', isHeadless: true })
    const sessionKey = chatSessionKey('local', 'claude', headless.sessionId)
    const snapshot = chatSessionSnapshot({ ...headless, isHeadless: undefined })
    const current = { sessions: { [sessionKey]: { worktreeId: chatWorktree.id, snapshot } } }
    const classified = chatSidebarPreferencePatch([], current, 10, {
      scannedSessions: [headless]
    })
    expect(classified?.sessions?.[sessionKey].snapshot?.isHeadless).toBe(true)
    const state = chatState()
    state.settings!.chatSidebar = { historySince: 0, sessions: classified?.sessions }
    expect(buildChatSidebarRows(state, [], 10)).toEqual([])
    const interactive = { ...headless, isHeadless: undefined }
    const restored = chatSidebarPreferencePatch([], { sessions: classified?.sessions }, 20, {
      scannedSessions: [interactive]
    })
    expect(restored?.sessions?.[sessionKey].snapshot?.isHeadless).toBeUndefined()
  })

  it('leaves an older remote Claude scan unclassified', () => {
    const session = chatSession('remote-session', {
      agent: 'claude',
      executionHostId: 'ssh:older-server'
    })
    const sessionKey = chatSessionKey(session.executionHostId, 'claude', session.sessionId)
    const current = {
      sessions: {
        [sessionKey]: { worktreeId: chatWorktree.id, snapshot: chatSessionSnapshot(session) }
      }
    }
    const patch = chatSidebarPreferencePatch([], current, 10, { scannedSessions: [session] })
    expect(patch).toBeNull()
    expect(current.sessions[sessionKey].snapshot.isHeadless).toBeUndefined()
  })

  it('remembers a scanned session and does not rewrite an unchanged snapshot', () => {
    const session = chatSession('session-a')
    const patch = chatSidebarPreferencePatch([chatRow({ session })], {}, 10)
    const stored = patch?.sessions?.[key]
    expect(stored).toEqual({ worktreeId: chatWorktree.id, snapshot: chatSessionSnapshot(session) })
    const [remembered] = chatSnapshotSessions(patch?.sessions, new Set())
    expect(
      chatSidebarPreferencePatch(
        [chatRow({ session: remembered })],
        { sessions: patch?.sessions },
        10
      )
    ).toBeNull()
  })
})

describe('chat sidebar selection', () => {
  const layouts = {
    a: { root: null, activeLeafId: leafB, expandedLeafId: null }
  }
  const base = {
    activeWorktreeId: chatWorktree.id,
    activeGroupIdByWorktree: { [chatWorktree.id]: 'g' },
    groupsByWorktree: {
      [chatWorktree.id]: [
        { id: 'g', worktreeId: chatWorktree.id, activeTabId: 'u', tabOrder: ['u'] }
      ]
    },
    activeTabType: 'terminal' as const,
    activeTabId: 'a',
    terminalLayoutsByTabId: layouts
  }
  const unifiedTab = {
    id: 'u',
    entityId: 'a',
    groupId: 'g',
    worktreeId: chatWorktree.id,
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }

  it('follows the focused group tab, not the last terminal, and ignores closed chats', () => {
    const terminal = activeChatTarget({
      ...base,
      unifiedTabsByWorktree: { [chatWorktree.id]: [{ ...unifiedTab, contentType: 'terminal' }] }
    })
    expect(terminal).toEqual({ worktreeId: chatWorktree.id, tabId: 'a', leafId: leafB })
    const editor = activeChatTarget({
      ...base,
      unifiedTabsByWorktree: { [chatWorktree.id]: [{ ...unifiedTab, contentType: 'editor' }] }
    })
    expect(editor.tabId).toBeNull()
    expect(isChatRowSelected(chatRow({ tabId: null }), { ...editor, tabId: null }, 0)).toBe(false)
  })

  it('selects only the focused pane when two chats share a tab', () => {
    const target = { worktreeId: chatWorktree.id, tabId: 'a', leafId: leafB }
    const paneA = chatRow({ paneKey: makePaneKey('a', leafA) })
    const paneB = chatRow({ paneKey: makePaneKey('a', leafB) })
    expect(isChatRowSelected(paneA, target, 2)).toBe(false)
    expect(isChatRowSelected(paneB, target, 2)).toBe(true)
    expect(isChatRowSelected(paneA, target, 1)).toBe(true)
  })
})
