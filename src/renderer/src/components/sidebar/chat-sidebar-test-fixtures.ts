import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { chatSessionKey, type ChatSidebarRow, type ChatSidebarState } from './chat-sidebar-types'

export const chatWorktree: Worktree = {
  id: 'repo::/clients/Acme',
  repoId: 'repo',
  path: '/clients/Acme',
  displayName: 'Acme',
  head: '',
  branch: '',
  isBare: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  isMainWorktree: true
}

export function chatState(overrides: Partial<ChatSidebarState> = {}): ChatSidebarState {
  return {
    settings: createGlobalSettingsFixture(),
    repos: [
      {
        id: 'repo',
        path: '/clients/Acme',
        displayName: 'Acme',
        badgeColor: '',
        addedAt: 1,
        connectionId: null,
        executionHostId: 'local'
      }
    ],
    projectGroups: [],
    folderWorkspaces: [],
    worktreesByRepo: { repo: [chatWorktree] },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    paneForegroundAgentByPaneKey: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    ...overrides
  }
}

export function chatTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    worktreeId: chatWorktree.id,
    ptyId: null,
    title: `Chat ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_000,
    launchAgent: 'codex',
    aiVaultTitle: { agent: 'codex', sessionId: `session-${id}`, title: `Chat ${id}` },
    ...overrides
  }
}

export function chatSession(id: string, overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: `codex:${id}`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: `History ${id}`,
    cwd: chatWorktree.path,
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: new Date(1_000).toISOString(),
    updatedAt: new Date(2_000).toISOString(),
    modifiedAt: new Date(2_000).toISOString(),
    messageCount: 2,
    totalTokens: 1,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${id}`,
    subagent: null,
    ...overrides
  }
}

export function chatRow(overrides: Partial<ChatSidebarRow> = {}): ChatSidebarRow {
  const key = chatSessionKey('local', 'codex', 'session-a')
  return {
    id: key,
    aliases: [],
    title: 'Chat a',
    manualTitle: null,
    folder: 'Acme',
    worktree: chatWorktree,
    hostId: 'local',
    tabId: 'a',
    paneKey: null,
    session: null,
    timestamp: 1_000,
    turnStartedAt: 1_000,
    activityFromState: false,
    promptBackedWorking: overrides.state === 'working',
    state: 'idle',
    completed: false,
    ownsWorkspaceName: false,
    sessionKey: key,
    liveSession: null,
    ...overrides
  }
}
