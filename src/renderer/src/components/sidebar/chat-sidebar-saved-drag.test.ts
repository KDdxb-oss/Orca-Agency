import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chatRow,
  chatSession,
  chatState,
  chatTab,
  chatWorktree
} from './chat-sidebar-test-fixtures'
import { resumeSavedChatAtDrop } from './chat-sidebar-saved-drag'
import { placeWorkspaceAtEdge } from '@/lib/workspace-split-layout'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  error: vi.fn(),
  createSeparate: vi.fn(),
  discard: vi.fn(),
  dropEdge: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('./chat-sidebar-detach', () => ({
  createSeparateChatWorkspace: mocks.createSeparate,
  discardEmptyChatWorkspace: mocks.discard
}))
vi.mock('../workspace-split/workspace-tab-edge-drop', () => ({
  dropTerminalTabAtWorkspaceEdge: mocks.dropEdge
}))
vi.mock('@/lib/ai-vault-resume-command', () => ({ buildAiVaultResumeStartupForWorktree: vi.fn() }))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn()
}))

const target = { worktreeId: chatWorktree.id, groupId: 'pane', splitDirection: 'right' as const }
const session = chatSession('fork')
const row = chatRow({ tabId: null, state: 'idle', session })
const resume = vi.fn()
let state: ReturnType<typeof makeState>
function makeState() {
  return {
    ...chatState(),
    worktreesByRepo: { repo: [chatWorktree, { ...chatWorktree, id: 'other' }] },
    groupsByWorktree: { [chatWorktree.id]: [{ id: 'pane' }], other: [{ id: 'pane' }] },
    workspaceSplitGroups: placeWorkspaceAtEdge([], 'other', chatWorktree.id, 'right', 'split'),
    dropUnifiedTab: vi.fn(),
    activateTab: vi.fn(),
    placeWorkspaceAtEdge: vi.fn()
  }
}

describe('saved chat sidebar drop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state = makeState()
    mocks.getState.mockReturnValue(state)
    mocks.createSeparate.mockResolvedValue({ ...chatWorktree, id: 'separate' })
    mocks.dropEdge.mockResolvedValue(undefined)
  })

  it.each([false, true])(
    'resumes an idle saved chat in the chosen pane regardless of Done=%s',
    async (completed) => {
      await resumeSavedChatAtDrop({ ...row, completed }, target, resume)
      expect(resume).toHaveBeenCalledWith(session, 'separate', {
        onResumed: expect.any(Function),
        onSettled: expect.any(Function),
        validateDestination: expect.any(Function)
      })
    }
  )

  it('retains its folder when dropped on another workspace', async () => {
    await resumeSavedChatAtDrop(
      row,
      { ...target, worktreeId: 'other', splitDirection: 'down' },
      resume
    )
    const [resumed, source, placement] = resume.mock.calls[0]
    expect(resumed.sessionId).toBe('fork')
    expect(source).toBe('separate')
    expect(placement.targetGroupId).toBeUndefined()
    expect(state.placeWorkspaceAtEdge).not.toHaveBeenCalled()
    placement.onResumed()
    expect(state.placeWorkspaceAtEdge).toHaveBeenCalledWith('separate', 'other', 'bottom')
  })
  it('uses the source workspace when an ungrouped chat cannot create a separate workspace', async () => {
    mocks.createSeparate.mockResolvedValue(chatWorktree)
    await resumeSavedChatAtDrop(row, target, resume)
    expect(mocks.createSeparate).toHaveBeenCalledWith(row, { useSourceWhenUngrouped: true })
    expect(resume).toHaveBeenCalledWith(session, chatWorktree.id, expect.any(Object))
    resume.mock.calls[0][2].onSettled('not-created')
    expect(mocks.discard).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'honors the reported fork identity when the tab link is stale=%s',
    async (forked) => {
      state.tabsByWorktree[chatWorktree.id] = [
        chatTab('live', { aiVaultTitle: { agent: 'codex', sessionId: 'fork', title: 'Fork' } })
      ]
      state.unifiedTabsByWorktree[chatWorktree.id] = [
        {
          id: 'unified',
          entityId: 'live',
          groupId: 'old',
          worktreeId: chatWorktree.id,
          contentType: 'terminal',
          label: 'Fork',
          customLabel: null,
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
      if (forked) {
        const paneKey = 'live:77777777-7777-4777-8777-777777777777'
        state.agentStatusByPaneKey[paneKey] = {
          paneKey,
          tabId: 'live',
          worktreeId: chatWorktree.id,
          agentType: 'codex',
          state: 'done',
          stateStartedAt: 2000,
          updatedAt: 2000,
          stateHistory: [],
          prompt: 'A forked chat',
          providerSession: { key: 'session_id', id: 'different-fork' }
        }
      }
      await resumeSavedChatAtDrop(row, target, resume)
      if (forked) {
        expect(state.dropUnifiedTab).not.toHaveBeenCalled()
        expect(resume).toHaveBeenCalledWith(session, 'separate', expect.any(Object))
        return
      }
      expect(resume).not.toHaveBeenCalled()
      expect(state.dropUnifiedTab).toHaveBeenCalledWith('unified', {
        groupId: 'pane',
        splitDirection: 'right'
      })
      await resumeSavedChatAtDrop(row, { ...target, worktreeId: 'other' }, resume)
      expect(resume).not.toHaveBeenCalled()
      expect(mocks.dropEdge).toHaveBeenCalledWith({
        sourceId: chatWorktree.id,
        unifiedTabId: 'unified',
        targetId: 'other',
        edge: 'right',
        wholeWindow: false
      })
    }
  )

  it('rejects a destination that disappeared and rechecks after preparation', async () => {
    await resumeSavedChatAtDrop(row, target, resume)
    const placement = resume.mock.calls[0][2]
    expect(placement.validateDestination()).toBe(true)
    state.groupsByWorktree[chatWorktree.id] = []
    expect(placement.validateDestination()).toBe(false)
    resume.mockClear()
    await resumeSavedChatAtDrop(row, target, resume)
    expect(resume).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalled()
  })

  it('accepts real folder workspaces through their canonical workspace key', async () => {
    state.folderWorkspaces = [
      {
        id: 'folder-only',
        projectGroupId: 'local-apps',
        name: 'Folder only',
        folderPath: '/apps',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const folderKey = 'folder:folder-only'
    state.groupsByWorktree[folderKey] = [{ id: 'pane' }]
    await resumeSavedChatAtDrop(row, { ...target, worktreeId: folderKey }, resume)
    expect(resume).toHaveBeenCalledOnce()
    const placement = resume.mock.calls[0][2]
    expect(placement.validateDestination()).toBe(true)
    state.folderWorkspaces[0].isArchived = true
    expect(placement.validateDestination()).toBe(false)
  })
})
