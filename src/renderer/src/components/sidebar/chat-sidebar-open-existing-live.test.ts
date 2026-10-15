import { beforeEach, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import {
  chatRow,
  chatSession,
  chatState,
  chatTab,
  chatWorktree
} from './chat-sidebar-test-fixtures'
import { chatSessionKey, type ChatSidebarState } from './chat-sidebar-types'
import { openSavedSidebarChat } from './chat-sidebar-open'

const mocks = vi.hoisted(() => {
  let state: ChatSidebarState | null = null
  return {
    getState: () => state,
    setState: (next: ChatSidebarState | null) => {
      state = next
    },
    activateWorkspace: vi.fn(() => true),
    activateStructured: vi.fn(() => false),
    focusPane: vi.fn(),
    createWorkspace: vi.fn(),
    resume: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateWorkspace
}))
vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: mocks.activateStructured
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.focusPane
}))
vi.mock('./chat-sidebar-detach', () => ({
  createSeparateChatWorkspace: mocks.createWorkspace,
  discardEmptyChatWorkspace: vi.fn()
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.setState(null)
})

it('focuses the existing plain Claude tab when its saved conversation is clicked', async () => {
  const paneKey = makePaneKey('a', '77777777-7777-4777-8777-777777777777')
  const session = chatSession('session-a', {
    id: 'claude:session-a',
    agent: 'claude',
    resumeCommand: 'claude --resume session-a'
  })
  const key = chatSessionKey('local', 'claude', session.sessionId)
  const state = chatState({
    tabsByWorktree: {
      [chatWorktree.id]: [chatTab('a', { launchAgent: 'claude', aiVaultTitle: undefined })]
    },
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        state: 'working',
        stateStartedAt: 3_000,
        updatedAt: 3_000,
        stateHistory: [],
        prompt: 'Client work',
        agentType: 'claude',
        providerSession: { key: 'session_id', id: session.sessionId }
      }
    }
  })
  state.settings!.chatSidebar = {
    historySince: 0,
    sessions: { [key]: { worktreeId: chatWorktree.id } }
  }
  mocks.setState(state)

  const rows = buildChatSidebarRows(state, [session], 10_000)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ sessionKey: key, tabId: 'a', paneKey })

  await openSavedSidebarChat(
    chatRow({ id: key, sessionKey: key, tabId: null, session, paneKey: null }),
    mocks.resume
  )

  expect(mocks.activateWorkspace).toHaveBeenCalledWith(chatWorktree.id, {
    executionHostId: 'local',
    revealInSidebar: false,
    providesInitialSurface: true
  })
  expect(mocks.focusPane).toHaveBeenCalledWith('a', '77777777-7777-4777-8777-777777777777')
  expect(mocks.createWorkspace).not.toHaveBeenCalled()
  expect(mocks.resume).not.toHaveBeenCalled()
})
