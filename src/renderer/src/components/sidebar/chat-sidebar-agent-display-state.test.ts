import { describe, expect, it } from 'vitest'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatSession, chatState, chatTab, chatWorktree } from './chat-sidebar-test-fixtures'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { chatCompletionEdit, refreshedChatCompletion } from './chat-sidebar-completion'

const leafId = '77777777-7777-4777-8777-777777777777'
const paneKey = makePaneKey('a', leafId)

describe('chat sidebar status follows the shared agent display policy', () => {
  it.each([
    { state: 'working' as const, workingMode: 'monitoring' as const, expected: 'monitoring' },
    { state: 'working' as const, workingMode: undefined, expected: 'working' },
    { state: 'done' as const, workingMode: undefined, expected: 'done' }
  ])(
    'shows $expected without changing the canonical status',
    ({ state: status, workingMode, expected }) => {
      const state = chatState({
        tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] },
        ptyIdsByTabId: { a: ['live-pty'] },
        terminalLayoutsByTabId: {
          a: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
        },
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'a',
            worktreeId: chatWorktree.id,
            agentType: 'codex',
            state: status,
            workingMode,
            prompt: 'Original request',
            updatedAt: 2000,
            stateStartedAt: 1000,
            stateHistory: [],
            mainAgent: {
              state: status === 'working' && !workingMode ? 'working' : 'done',
              stateStartedAt: 2000
            },
            providerSession: { key: 'session_id', id: 'session-a' }
          }
        }
      })
      expect(buildChatSidebarRows(state, [chatSession('session-a')], 3000)).toMatchObject([
        { tabId: 'a', state: status, displayState: expected }
      ])
      expect(state.agentStatusByPaneKey[paneKey].state).toBe(status)
    }
  )

  it('does not reopen a marked Done chat when only its display changes to monitoring', () => {
    const completion = { at: 2000, activityAt: 1000, done: true, working: true }
    const row = {
      id: 'same-chat',
      aliases: [],
      timestamp: 1000,
      tabId: 'a',
      turnStartedAt: 1000,
      promptBackedWorking: true,
      activityFromState: true,
      state: 'working' as const
    }
    for (const displayState of ['working', 'monitoring', 'working'] as const) {
      const displayedRow = { ...row, displayState }
      expect(refreshedChatCompletion(displayedRow, completion, 3000)).toBeNull()
      expect(chatCompletionEdit(row, {}, true, 2000)).toEqual({
        completed: { 'same-chat': completion }
      })
    }
  })
})
