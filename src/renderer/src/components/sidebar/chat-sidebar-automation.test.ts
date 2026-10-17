import { describe, expect, it } from 'vitest'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatSidebarPreferencePatch } from './chat-sidebar-identity'
import { chatFallbackId, chatSessionKey } from './chat-sidebar-types'
import { chatState, chatTab, chatSession, chatWorktree } from './chat-sidebar-test-fixtures'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'

describe('automation runs in Chats', () => {
  it('never lists a workspace created by an automation before the provider hook arrives', () => {
    const automatedWorktree = {
      ...chatWorktree,
      automationProvenance: {
        kind: 'created-by-automation' as const,
        automationId: 'automation',
        automationNameSnapshot: 'Nightly review',
        automationRunId: 'run',
        automationRunTitleSnapshot: 'Nightly review run',
        createdAt: 1,
        executionTargetType: 'local' as const,
        executionTargetId: 'local',
        projectId: 'repo'
      }
    }
    const state = chatState({
      worktreesByRepo: { repo: [automatedWorktree] },
      tabsByWorktree: { [automatedWorktree.id]: [chatTab('scheduled')] }
    })
    expect(buildChatSidebarRows(state, [], 5_000)).toEqual([])
  })

  it('hides a scheduled tab without hiding a manual sibling in the same workspace', () => {
    const state = chatState({
      tabsByWorktree: { [chatWorktree.id]: [chatTab('scheduled'), chatTab('manual')] }
    })
    state.settings!.chatSidebar = { automationChats: [chatFallbackId('local', 'scheduled')] }
    expect(buildChatSidebarRows(state, [], 5_000).map((row) => row.tabId)).toEqual(['manual'])
  })

  it('shows a manually reopened automation session in a split workspace', () => {
    const original = chatTab('scheduled', {
      aiVaultTitle: { agent: 'codex', sessionId: 'shared', title: 'Manatal audit' }
    })
    const reopened = chatTab('reopened', {
      createdAt: 10_000,
      aiVaultTitle: { agent: 'codex', sessionId: 'shared', title: 'Manatal audit' }
    })
    const lateAutomationTab = chatTab('late-automation', {
      createdAt: 11_000,
      aiVaultTitle: { agent: 'codex', sessionId: 'shared', title: 'Manatal audit' }
    })
    const folder = makeFolderWorkspace({ id: 'manual-workspace', folderPath: '/clients/Acme' })
    const otherWorktree = folderWorkspaceToWorktree(folder)
    const state = chatState({
      folderWorkspaces: [folder],
      tabsByWorktree: {
        [chatWorktree.id]: [original, lateAutomationTab],
        [otherWorktree.id]: [{ ...reopened, worktreeId: otherWorktree.id }]
      }
    })
    const key = chatSessionKey('local', 'codex', 'shared')
    state.settings!.chatSidebar = {
      historySince: 0,
      automationChats: [
        key,
        chatFallbackId('local', 'scheduled'),
        chatFallbackId('local', 'late-automation'),
        // Older preference writes also marked the manually reopened tab as automated.
        chatFallbackId('local', 'reopened')
      ],
      userResumedTabs: [chatFallbackId('local', 'reopened')]
    }
    const session = chatSession('shared', { createdAt: new Date(2_000).toISOString() })
    state.settings!.chatSidebar.userResumedTabs = []
    expect(buildChatSidebarRows(state, [session], 12_000)).toEqual([])
    state.settings!.chatSidebar.userResumedTabs = [chatFallbackId('local', 'reopened')]
    expect(buildChatSidebarRows(state, [session], 12_000).map((row) => row.tabId)).toEqual([
      'reopened'
    ])
    state.tabsByWorktree[otherWorktree.id] = []
    expect(buildChatSidebarRows(state, [session], 13_000)).toEqual([])
  })

  it('remembers the provider identity after automation cleanup removes its tab', () => {
    const state = chatState({ tabsByWorktree: { [chatWorktree.id]: [chatTab('scheduled')] } })
    const current = { automationChats: [chatFallbackId('local', 'scheduled')], historySince: 0 }
    state.settings!.chatSidebar = current
    const session = chatSession('session-scheduled')
    const raw = buildChatSidebarRows(state, [session], 5_000, undefined, true)
    const patch = chatSidebarPreferencePatch(raw, current, 5_000)
    expect(patch?.automationChats).toContain(chatSessionKey('local', 'codex', session.sessionId))
    state.settings!.chatSidebar = { ...current, ...patch }
    state.tabsByWorktree = {}
    expect(buildChatSidebarRows(state, [session], 6_000)).toEqual([])
    expect(buildChatSidebarRows(state, [], 6_000)).toEqual([])
  })

  it('does not hide the same provider identity on another host', () => {
    const state = chatState({ tabsByWorktree: { [chatWorktree.id]: [chatTab('scheduled')] } })
    state.settings!.chatSidebar = {
      automationChats: [chatSessionKey('ssh:other', 'codex', 'session-scheduled')]
    }
    expect(buildChatSidebarRows(state, [], 5_000)).toHaveLength(1)
  })
})
