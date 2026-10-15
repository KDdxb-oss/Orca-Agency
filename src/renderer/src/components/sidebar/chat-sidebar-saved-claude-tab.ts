import { collectRuntimePaneLeafIds } from '@/lib/runtime-pane-title-leaf-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { savedClaudeResume } from './chat-sidebar-claude-resume'
import { chatLiveSession } from './chat-sidebar-session-snapshot'
import {
  chatFallbackId,
  chatSessionKey,
  chatSessionTime,
  chatSessionHumanTurnTime,
  type ChatSidebarRow,
  type ChatSidebarState
} from './chat-sidebar-types'

/** Keep a verified Claude resume attached to its saved tab before hooks reconnect. */
export function savedClaudeTabRow(args: {
  state: ChatSidebarState
  tab: TerminalTab
  worktree: Worktree
  hostId: ExecutionHostId
  folder: string
  sessions: ReadonlyMap<string, AiVaultSession>
}): ChatSidebarRow | null {
  const { state, tab, worktree, hostId, folder, sessions } = args
  if (tab.aiVaultTitle?.agent !== 'claude') {
    return null
  }
  const launcherSessionId = tab.aiVaultTitle.sessionId
  const launcher = sessions.get(chatSessionKey(hostId, 'claude', launcherSessionId)) ?? null
  const matches = collectRuntimePaneLeafIds(state.terminalLayoutsByTabId[tab.id]?.root).flatMap(
    (leafId) => {
      const paneKey = makePaneKey(tab.id, leafId)
      const live = state.agentStatusByPaneKey[paneKey]
      const saved = state.sleepingAgentSessionsByPaneKey[paneKey]
      const sleeping =
        saved?.worktreeId === worktree.id && (!saved.tabId || saved.tabId === tab.id)
          ? saved
          : undefined
      const prior = state.retainedAgentsByPaneKey[paneKey]
      const retained =
        prior?.worktreeId === worktree.id && prior.tab.id === tab.id ? prior : undefined
      const reported =
        live?.providerSession ?? sleeping?.providerSession ?? retained?.entry.providerSession
      const agent = live?.agentType ?? sleeping?.agent ?? retained?.agentType
      if (
        (agent && agent !== 'claude' && agent !== 'unknown') ||
        (reported && reported.id !== launcherSessionId)
      ) {
        return []
      }
      const resume = savedClaudeResume({
        settings: state.settings?.chatSidebar,
        sessions,
        launcher,
        launcherSessionId,
        launcherTranscriptPath: reported?.transcriptPath ?? launcher?.filePath,
        hostId,
        worktreeId: worktree.id,
        tabId: tab.id,
        paneKey
      })
      return resume ? [resume] : []
    }
  )
  if (matches.length !== 1) {
    return null
  }
  const { session, proof } = matches[0]
  const key = chatSessionKey(hostId, 'claude', session.sessionId)
  return {
    id: key,
    aliases: [chatFallbackId(hostId, tab.id), chatFallbackId(hostId, proof.paneKey)],
    sessionKey: key,
    agentType: 'claude',
    title: session.title,
    manualTitle: tab.customTitle?.trim() || null,
    folder,
    worktree,
    hostId,
    tabId: tab.id,
    paneKey: proof.paneKey,
    session,
    timestamp: chatSessionTime(session),
    turnStartedAt: chatSessionHumanTurnTime(session),
    activityFromState: false,
    promptBackedWorking: false,
    state: 'idle',
    completed: false,
    ownsWorkspaceName: false,
    liveSession: chatLiveSession(
      'claude',
      { key: 'session_id', id: session.sessionId, transcriptPath: session.filePath },
      session.title
    ),
    resumeLauncher: proof
  }
}
