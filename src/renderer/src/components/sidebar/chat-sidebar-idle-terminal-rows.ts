import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { hasChatConversation } from './chat-sidebar-conversation'
import { savedClaudeTabRow } from './chat-sidebar-saved-claude-tab'
import { chatLiveSession } from './chat-sidebar-session-snapshot'
import {
  chatFallbackId,
  chatSessionKey,
  chatSessionTime,
  chatSessionHumanTurnTime,
  type ChatSidebarRow,
  type ChatSidebarState
} from './chat-sidebar-types'

/** Open tabs remain resident without fresh agent status, including saved Claude resume links. */
export function idleTerminalChatRows(args: {
  state: ChatSidebarState
  worktree: Worktree
  hostId: ExecutionHostId
  folder: string
  sessions: ReadonlyMap<string, AiVaultSession>
  representedTabIds: ReadonlySet<string>
}): ChatSidebarRow[] {
  const { state, worktree, hostId, folder, sessions, representedTabIds } = args
  const sleepingByTabId = new Map(
    Object.values(state.sleepingAgentSessionsByPaneKey).flatMap((record) =>
      record.tabId ? [[`${record.worktreeId}\n${record.tabId}`, record] as const] : []
    )
  )
  const rows: ChatSidebarRow[] = []
  for (const tab of state.tabsByWorktree[worktree.id] ?? []) {
    const sleeping = sleepingByTabId.get(`${worktree.id}\n${tab.id}`)
    if (representedTabIds.has(tab.id) || (!tab.launchAgent && !tab.aiVaultTitle && !sleeping)) {
      continue
    }
    const resumed = savedClaudeTabRow({ state, tab, worktree, hostId, folder, sessions })
    if (resumed) {
      rows.push(resumed)
      continue
    }
    const agent = tab.aiVaultTitle?.agent ?? sleeping?.agent ?? tab.launchAgent ?? 'unknown'
    const sessionId = tab.aiVaultTitle?.sessionId ?? sleeping?.providerSession.id
    const key = sessionId ? chatSessionKey(hostId, agent, sessionId) : null
    const session = key ? (sessions.get(key) ?? null) : null
    if (
      !hasChatConversation({
        session,
        saved: key ? state.settings?.chatSidebar?.sessions?.[key] : undefined,
        providerTitle: tab.aiVaultTitle?.title,
        savedPrompt: sleeping?.providerSession.id === sessionId ? sleeping?.prompt : undefined
      })
    ) {
      continue
    }
    const fallbackIds = [
      chatFallbackId(hostId, tab.id),
      ...(sleeping ? [chatFallbackId(hostId, sleeping.paneKey)] : [])
    ]
    const sessionAt = session ? chatSessionTime(session) : tab.createdAt
    const title =
      getAgentRowConversationName(
        tab,
        agent,
        state.settings?.tabAutoGenerateTitle === true,
        undefined,
        sessionId
      ) ??
      session?.title ??
      tab.title
    rows.push({
      id: key ?? fallbackIds[0],
      aliases: key ? fallbackIds : fallbackIds.slice(1),
      sessionKey: key,
      agentType: agent,
      title,
      manualTitle: tab.customTitle?.trim() || null,
      folder,
      worktree,
      hostId,
      tabId: tab.id,
      paneKey: sleeping?.paneKey ?? null,
      session,
      timestamp: sleeping?.updatedAt ?? sessionAt,
      turnStartedAt: chatSessionHumanTurnTime(session),
      activityFromState: false,
      promptBackedWorking: false,
      state: 'idle',
      completed: false,
      ownsWorkspaceName: false,
      liveSession: sleeping
        ? chatLiveSession(sleeping.agent, sleeping.providerSession, title)
        : null
    })
  }
  return rows
}
