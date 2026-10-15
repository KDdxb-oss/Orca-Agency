import { buildWorktreeAgentRows } from './worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './worktree-agent-row-selectors'
import { rowConversationName } from '../dashboard/dashboard-card-labels'
import { lastEnteredDoneAt } from '../dashboard/agent-finished-timestamp'
import type { DashboardAgentRow } from '../dashboard/useDashboardData'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { agentStatusEvidenceObservedAt } from '../../../../shared/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ChatSidebarResumeLauncher } from '../../../../shared/chat-sidebar-settings'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  chatFallbackId,
  chatSessionKey,
  chatSessionTime,
  chatSessionHumanTurnTime,
  type ChatSidebarRow,
  type ChatSidebarState
} from './chat-sidebar-types'
import { chatLiveSession } from './chat-sidebar-session-snapshot'
import { hasChatConversation } from './chat-sidebar-conversation'
import { withSleepingChatAgents } from './chat-sidebar-sleeping-agents'
import { resumedClaudeSession, savedClaudeResume } from './chat-sidebar-claude-resume'

/** When the latest working turn began; heartbeats and session-boundary snapshots never move it. */
function latestTurnStart(entry: AgentStatusEntry): number {
  let latest =
    !entry.sessionBoundary && !entry.restoredUnconfirmed
      ? (entry.turnStartedAt ?? (entry.state === 'working' ? entry.stateStartedAt : 0))
      : 0
  for (const item of entry.stateHistory) {
    if (item.state === 'working' && item.startedAt > latest) {
      latest = item.startedAt
    }
  }
  return latest
}

function rowTimestamp(agent: DashboardAgentRow, sessionAt: number): number {
  if (agent.startedAt === 0) {
    // Why: title-derived rows stamp `now` on every render, which is not activity.
    return sessionAt
  }
  if (agent.state === 'done') {
    // Why: resuming an idle session emits done without completing a new turn.
    return (
      lastEnteredDoneAt(agent) ??
      (agent.entry.sessionBoundary ? sessionAt : agentStatusEvidenceObservedAt(agent.entry))
    )
  }
  // Why: updatedAt moves on heartbeats and relay restamps; state start and evidence time do not.
  return agent.state === 'working'
    ? agent.entry.stateStartedAt
    : agentStatusEvidenceObservedAt(agent.entry)
}

export function buildAgentChatRows(args: {
  state: ChatSidebarState
  worktree: Worktree
  hostId: ExecutionHostId
  folder: string
  sessions: ReadonlyMap<string, AiVaultSession>
  now: number
}): { rows: ChatSidebarRow[]; representedTabIds: Set<string> } {
  const { state, worktree, hostId } = args
  const tabs = state.tabsByWorktree[worktree.id] ?? []
  const unifiedById = new Map(
    (state.unifiedTabsByWorktree[worktree.id] ?? []).map((tab) => [tab.id, tab])
  )
  const residentTabIds = new Set([...tabs.map((tab) => tab.id), ...unifiedById.keys()])
  const agents = withSleepingChatAgents(
    buildWorktreeAgentRows({
      tabs,
      entries: selectLiveAgentStatusEntriesForWorktree(state, worktree.id),
      retained: selectRetainedAgentEntriesForWorktree(state, worktree.id),
      runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      ptyIdsByTabId: state.ptyIdsByTabId,
      foregroundAgentsByPaneKey: state.paneForegroundAgentByPaneKey,
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
      now: args.now
    }).filter((agent) => agent.rowSource !== 'subagent'),
    state,
    worktree.id
  )
  const chatPanesByTab = new Map<string, number>()
  for (const agent of agents) {
    chatPanesByTab.set(agent.tab.id, (chatPanesByTab.get(agent.tab.id) ?? 0) + 1)
  }
  const rows: ChatSidebarRow[] = []
  const representedTabIds = new Set<string>()
  for (const agent of agents) {
    const soleChat = chatPanesByTab.get(agent.tab.id) === 1
    const resident = residentTabIds.has(agent.tab.id)
    const hookProviderSession = agent.entry.providerSession
    // Why: the tab-level provider title belongs to one pane, so split siblings must not borrow it.
    const tabSession =
      !hookProviderSession &&
      soleChat &&
      (agent.agentType === agent.tab.aiVaultTitle?.agent || agent.agentType === 'unknown')
        ? agent.tab.aiVaultTitle
        : undefined
    const sessionAgent = hookProviderSession ? agent.agentType : tabSession?.agent
    const reportedSessionId = hookProviderSession?.id ?? tabSession?.sessionId
    const reportedKey =
      sessionAgent && reportedSessionId
        ? chatSessionKey(hostId, sessionAgent, reportedSessionId)
        : null
    const launcher = reportedKey ? (args.sessions.get(reportedKey) ?? null) : null
    const scannedResume = hookProviderSession
      ? resumedClaudeSession(launcher, args.sessions, hookProviderSession.transcriptPath)
      : null
    const rememberedResume =
      !scannedResume && resident && hookProviderSession?.id
        ? savedClaudeResume({
            settings: state.settings?.chatSidebar,
            sessions: args.sessions,
            launcher,
            launcherSessionId: hookProviderSession.id,
            launcherTranscriptPath: hookProviderSession.transcriptPath,
            hostId,
            worktreeId: worktree.id,
            tabId: agent.tab.id,
            paneKey: agent.paneKey
          })
        : null
    const resumed = scannedResume ?? rememberedResume?.session ?? null
    const resumeLauncher: ChatSidebarResumeLauncher | undefined =
      scannedResume && hookProviderSession?.transcriptPath && launcher?.resumedSessionIdPrefix
        ? {
            agent: 'claude',
            sessionId: hookProviderSession.id,
            transcriptPath: hookProviderSession.transcriptPath,
            tabId: agent.tab.id,
            paneKey: agent.paneKey,
            targetSessionIdPrefix: launcher.resumedSessionIdPrefix
          }
        : rememberedResume?.proof
    const providerSession =
      resumed && hookProviderSession
        ? { ...hookProviderSession, id: resumed.sessionId, transcriptPath: resumed.filePath }
        : hookProviderSession
    const sessionId = providerSession?.id ?? tabSession?.sessionId
    const structuredTab = unifiedById.get(agent.tab.id)
    const structuredKey =
      structuredTab?.contentType === 'agent-session'
        ? chatSessionKey(
            hostId,
            structuredTab.agentSessionAgent ?? 'unknown',
            structuredTab.entityId
          )
        : null
    const sessionKey =
      sessionAgent && sessionId ? chatSessionKey(hostId, sessionAgent, sessionId) : structuredKey
    const session = resumed ?? (sessionKey ? (args.sessions.get(sessionKey) ?? null) : null)
    if (!resident && !session) {
      continue
    }
    const sleeping = state.sleepingAgentSessionsByPaneKey[agent.paneKey]
    if (
      !hasChatConversation({
        session,
        saved: sessionKey ? state.settings?.chatSidebar?.sessions?.[sessionKey] : undefined,
        // Why: title-only rows put agent identity and Idle into prompt/reply fields.
        entry: agent.startedAt === 0 ? undefined : agent.entry,
        savedPrompt: sleeping?.providerSession.id === sessionId ? sleeping?.prompt : undefined,
        providerTitle:
          agent.tab.aiVaultTitle?.sessionId === sessionId &&
          agent.tab.aiVaultTitle?.agent === sessionAgent
            ? agent.tab.aiVaultTitle?.title
            : undefined
      })
    ) {
      continue
    }
    representedTabIds.add(agent.tab.id)
    const fallbackIds = [
      ...(structuredKey ? [structuredKey] : []),
      ...(soleChat ? [chatFallbackId(hostId, agent.tab.id)] : []),
      chatFallbackId(hostId, agent.paneKey)
    ]
    const id = sessionKey ?? fallbackIds[0]
    const nameSource =
      providerSession || !sessionId
        ? providerSession === hookProviderSession
          ? agent
          : { ...agent, entry: { ...agent.entry, providerSession } }
        : {
            ...agent,
            entry: {
              orchestration: agent.entry.orchestration,
              providerSession: { key: 'session_id' as const, id: sessionId }
            }
          }
    const sessionAt = session ? chatSessionTime(session) : agent.tab.createdAt
    const title =
      rowConversationName(
        soleChat ? nameSource : { ...nameSource, tab: { ...nameSource.tab, customTitle: null } },
        state.settings?.tabAutoGenerateTitle === true,
        state.terminalLayoutsByTabId[agent.tab.id],
        state.runtimePaneTitlesByTabId[agent.tab.id]
      ) ??
      session?.title ??
      (getAgentRowPrimaryText(agent.entry).split(/\r?\n/, 1)[0]?.trim() || 'New chat')
    rows.push({
      id,
      aliases: fallbackIds.filter((alias) => alias !== id),
      sessionKey,
      agentType: sessionAgent ?? agent.agentType,
      title,
      manualTitle: soleChat ? agent.tab.customTitle?.trim() || null : null,
      folder: args.folder,
      worktree,
      hostId,
      tabId: resident ? agent.tab.id : null,
      paneKey: resident ? agent.paneKey : null,
      session,
      promptBackedWorking:
        agent.state === 'working' &&
        !agent.entry.sessionBoundary &&
        !agent.entry.restoredUnconfirmed,
      timestamp: resumed ? sessionAt : rowTimestamp(agent, sessionAt),
      turnStartedAt: resumed
        ? chatSessionHumanTurnTime(resumed)
        : Math.max(
            chatSessionHumanTurnTime(session),
            agent.startedAt === 0 ? 0 : latestTurnStart(agent.entry)
          ),
      activityFromState: !resumed && agent.startedAt === 0,
      state: agent.state,
      displayState: agentRowDisplayDotState(agent),
      completed: false,
      ownsWorkspaceName: false,
      liveSession: chatLiveSession(agent.agentType, providerSession, title),
      ...(resident && resumeLauncher ? { resumeLauncher } : {})
    })
  }
  return { rows, representedTabIds }
}
