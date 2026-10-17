import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorktreeExecutionHostId,
  getSettingsFocusedExecutionHostId
} from '../../../../shared/execution-host'
import {
  resolveAiVaultSessionWorktreeInfo,
  type AiVaultSessionWorktreeInfo
} from '../right-sidebar/ai-vault-session-worktree'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import {
  chatFallbackId,
  chatSessionKey,
  chatSessionTime,
  chatSessionHumanTurnTime,
  type ChatSidebarRow,
  type ChatSidebarState
} from './chat-sidebar-types'
import { buildAgentChatRows } from './chat-sidebar-agent-rows'
import { chatPreference, isChatCompleted, outranksChatRow } from './chat-sidebar-identity'
import { chatCompletionActivityTime } from './chat-sidebar-completion'
import { chatWorkspaceNameOwners, manualWorkspaceName } from './chat-sidebar-workspace-names'
import { chatSnapshotSessions, chatSessionMap } from './chat-sidebar-session-snapshot'
import { chatWorkspaceFolders } from './chat-sidebar-workspace-folder'
import { chatSidebarWorktrees, chatFolderLabel } from './chat-sidebar-worktrees'
import { hasChatConversation } from './chat-sidebar-conversation'
import { idleTerminalChatRows } from './chat-sidebar-idle-terminal-rows'
export { chatSidebarWorktrees, chatFolderLabel } from './chat-sidebar-worktrees'

export function buildChatSidebarRows(
  state: ChatSidebarState,
  sessions: readonly AiVaultSession[],
  now: number,
  /** Session id to its resolved workspace; computed per session when omitted. */
  sessionWorktrees?: ReadonlyMap<string, AiVaultSessionWorktreeInfo>,
  includeAutomationRows = false
): ChatSidebarRow[] {
  const rows = new Map<string, ChatSidebarRow>()
  const residentRows: ChatSidebarRow[] = []
  const tabCreatedAt = new Map(
    [
      ...Object.values(state.tabsByWorktree).flat(),
      ...Object.values(state.unifiedTabsByWorktree).flat()
    ].map((tab) => [tab.id, tab.createdAt])
  )
  const worktrees = chatSidebarWorktrees(state)
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo]))
  const focusedHostId = getSettingsFocusedExecutionHostId(state.settings)
  const hostOf = (worktree: Worktree) =>
    getWorktreeExecutionHostId(worktree, repoById.get(worktree.repoId), focusedHostId)
  const settings = state.settings?.chatSidebar
  const remembered = chatSnapshotSessions(settings?.sessions, new Set())
  const rememberedSessions = new Set(remembered)
  const sessionMap = chatSessionMap(sessions, rememberedSessions)
  const hidden = new Set(settings?.hidden ?? [])
  const automationChats = new Set(settings?.automationChats ?? [])
  const add = (row: ChatSidebarRow) => {
    const incumbent = rows.get(row.id)
    // Why: two resident terminals can resume the same provider session. Keep both navigable.
    if (
      row.tabId &&
      incumbent?.tabId &&
      (row.tabId !== incumbent.tabId ||
        (row.paneKey && incumbent.paneKey && row.paneKey !== incumbent.paneKey))
    ) {
      row.id = chatFallbackId(row.hostId, row.paneKey ?? row.tabId)
      row.aliases = row.aliases.filter((alias) => alias !== row.id)
    }
    const tab =
      state.tabsByWorktree[row.worktree.id]?.find((item) => item.id === row.tabId) ??
      state.unifiedTabsByWorktree[row.worktree.id]?.find((item) => item.id === row.tabId)
    const sessionCreatedAt = Date.parse(row.session?.createdAt ?? '')
    row.createdAt =
      chatPreference(settings?.sessions, row)?.createdAt ??
      (Number.isFinite(sessionCreatedAt) ? sessionCreatedAt : tab?.createdAt)
    const identities = [row.id, ...row.aliases, ...(row.sessionKey ? [row.sessionKey] : [])]
    const userResumedTab =
      !!row.tabId &&
      settings?.userResumedTabs?.includes(chatFallbackId(row.hostId, row.tabId)) === true
    // An explicit user resume overrides old automation markers only for that exact tab.
    row.automated =
      !userResumedTab && identities.some((id) => automationChats.has(id))
    // Why: hiding old history must not hide a conversation the user opens again.
    if (!row.tabId && identities.some((id) => hidden.has(id))) {
      return
    }
    const completion = chatPreference(settings?.completed, row)
    row.completed = isChatCompleted(row, completion)
    row.timestamp = chatCompletionActivityTime(row, completion)
    const previous = rows.get(row.id)
    if (!previous || outranksChatRow(row, previous)) {
      rows.set(row.id, row)
    }
  }
  for (const worktree of worktrees) {
    const hostId = hostOf(worktree)
    const folder = chatFolderLabel(state, worktree)
    const live = buildAgentChatRows({ state, worktree, hostId, folder, sessions: sessionMap, now })
    residentRows.push(...live.rows)
    residentRows.push(
      ...idleTerminalChatRows({
        state,
        worktree,
        hostId,
        folder,
        sessions: sessionMap,
        representedTabIds: live.representedTabIds
      })
    )
    for (const tab of state.unifiedTabsByWorktree[worktree.id] ?? []) {
      if (tab.contentType !== 'agent-session' || live.representedTabIds.has(tab.id)) {
        continue
      }
      const key = chatSessionKey(hostId, tab.agentSessionAgent ?? 'unknown', tab.entityId)
      const session = sessionMap.get(key) ?? null
      if (
        !hasChatConversation({
          session,
          saved: settings?.sessions?.[key],
          providerTitle:
            tab.aiVaultTitle?.sessionId === tab.entityId &&
            tab.aiVaultTitle?.agent === tab.agentSessionAgent
              ? tab.aiVaultTitle?.title
              : undefined
        })
      ) {
        continue
      }
      const sessionAt = session ? chatSessionTime(session) : tab.createdAt
      residentRows.push({
        id: key,
        aliases: [chatFallbackId(hostId, tab.id)],
        sessionKey: key,
        agentType: tab.agentSessionAgent,
        title: tab.customLabel ?? tab.aiVaultTitle?.title ?? tab.generatedLabel ?? tab.label,
        manualTitle: tab.customLabel?.trim() || null,
        folder,
        worktree,
        hostId,
        tabId: tab.id,
        paneKey: null,
        session,
        timestamp: sessionAt,
        turnStartedAt: chatSessionHumanTurnTime(session),
        activityFromState: false,
        promptBackedWorking: false,
        state: 'idle',
        completed: false,
        ownsWorkspaceName: false,
        liveSession: null
      })
    }
  }
  // Why: activity order must not transfer a duplicate session's names or completion to another tab.
  residentRows
    .sort(
      (a, b) =>
        (tabCreatedAt.get(a.tabId ?? '') ?? Number.MAX_SAFE_INTEGER) -
          (tabCreatedAt.get(b.tabId ?? '') ?? Number.MAX_SAFE_INTEGER) ||
        (a.tabId ?? '').localeCompare(b.tabId ?? '') ||
        (a.paneKey ?? '').localeCompare(b.paneKey ?? '')
    )
    .forEach(add)
  const worktreeById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const claimed = new Set([...rows.values()].flatMap((row) => [row.id, ...row.aliases]))
  for (const session of sessionMap.values()) {
    if (
      session.subagent ||
      session.isHeadless ||
      (!rememberedSessions.has(session) && !isAiVaultSessionResumableContent(session))
    ) {
      continue
    }
    const key = chatSessionKey(session.executionHostId, session.agent, session.sessionId)
    if (claimed.has(key) || hidden.has(key)) {
      continue
    }
    const tracked = settings?.sessions?.[key]
    const imported =
      settings?.historySince !== undefined &&
      Date.parse(session.createdAt ?? session.modifiedAt) >= settings.historySince
    if (!tracked && !imported) {
      continue
    }
    const worktreeId =
      tracked?.worktreeId ??
      (sessionWorktrees
        ? sessionWorktrees.get(session.id)
        : resolveAiVaultSessionWorktreeInfo({
            session,
            worktrees,
            repos: state.repos,
            activeWorktreeId: null
          })
      )?.worktreeId
    const original = worktreeId ? worktreeById.get(worktreeId) : undefined
    const assignment = settings?.folderAssignments?.[key]
    const fallback =
      assignment?.executionHostId === session.executionHostId
        ? worktreeById.get(assignment.worktreeId)
        : undefined
    const worktree = original && !original.isArchived ? original : fallback
    // Why: archived workspaces cannot resume, and a chat must stay on the host that ran it.
    if (!worktree || worktree.isArchived || hostOf(worktree) !== session.executionHostId) {
      continue
    }
    const sessionAt = chatSessionTime(session)
    add({
      id: key,
      aliases: [],
      sessionKey: key,
      agentType: session.agent,
      title: session.title,
      manualTitle: null,
      folder: chatFolderLabel(state, worktree),
      worktree,
      hostId: session.executionHostId,
      tabId: null,
      paneKey: null,
      session,
      timestamp: sessionAt,
      turnStartedAt: chatSessionHumanTurnTime(session),
      activityFromState: false,
      promptBackedWorking: false,
      state: 'idle',
      completed: false,
      ownsWorkspaceName: false,
      liveSession: null
    })
  }
  const result = [...rows.values()]
  const owners = chatWorkspaceNameOwners(state, result)
  const folders = chatWorkspaceFolders(result, settings, worktreeById, hostOf, tabCreatedAt)
  for (const row of result) {
    const destination = folders.get(row.id)
    if (destination) {
      row.folderWorktree = destination
      row.folder = chatFolderLabel(state, destination)
    }
    row.ownsWorkspaceName = owners.get(row.worktree.id) === row
    const workspaceName = row.ownsWorkspaceName ? manualWorkspaceName(state, row.worktree) : null
    row.title =
      chatPreference(settings?.titles, row) ?? row.manualTitle ?? workspaceName ?? row.title
  }
  return result
    .filter((row) => includeAutomationRows || !row.automated)
    .sort(compareChatSidebarRows)
}

export function compareChatSidebarRows(a: ChatSidebarRow, b: ChatSidebarRow): number {
  return (
    Number(b.state === 'working') - Number(a.state === 'working') ||
    b.timestamp - a.timestamp ||
    a.id.localeCompare(b.id)
  )
}
