import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { useAiVaultSessionRefresh } from '../right-sidebar/ai-vault-session-refresh'
import { useAiVaultSessionWorktreeMap } from '../right-sidebar/ai-vault-session-worktree'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from '../right-sidebar/ai-vault-session-limit'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../../shared/execution-host'
import { buildChatSidebarRows, chatSidebarWorktrees } from './chat-sidebar-rows'
import { updateChatSidebar, syncChatSidebarTabTitles } from './chat-sidebar-preferences'
import { chatSidebarPreferencePatch } from './chat-sidebar-identity'
import { classifyUnscannedClaudeHistory } from './chat-sidebar-headless-history'
import type { ChatSidebarState } from './chat-sidebar-types'
import type { AppState } from '@/store/types'
import { useNow } from '@/hooks/use-now'

/** The store slices chat rows read; shared with the background snapshot recorder. */
export function selectChatSidebarState(s: AppState): ChatSidebarState {
  return {
    settings: s.settings,
    repos: s.repos,
    projectGroups: s.projectGroups,
    folderWorkspaces: s.folderWorkspaces,
    worktreesByRepo: s.worktreesByRepo,
    tabsByWorktree: s.tabsByWorktree,
    unifiedTabsByWorktree: s.unifiedTabsByWorktree,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    ptyIdsByTabId: s.ptyIdsByTabId,
    paneForegroundAgentByPaneKey: s.paneForegroundAgentByPaneKey,
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
    sleepingAgentSessionsByPaneKey: s.sleepingAgentSessionsByPaneKey
  }
}

export function useChatSidebarData() {
  const state = useAppStore(useShallow(selectChatSidebarState))
  const { worktreesByRepo, folderWorkspaces, repos } = state
  const worktrees = useMemo(
    () => chatSidebarWorktrees({ worktreesByRepo, folderWorkspaces }),
    [worktreesByRepo, folderWorkspaces]
  )
  const paths = useMemo(() => [...new Set(worktrees.map((item) => item.path))], [worktrees])
  // Why bounded: an unlimited scan across many folders can outlive its IPC deadline; registered
  // chats persist a snapshot, so the scan only needs to surface and refresh recent ones.
  const history = useAiVaultSessionRefresh(
    paths,
    ALL_EXECUTION_HOSTS_SCOPE,
    DEFAULT_AI_VAULT_SESSION_LIMIT
  )
  // Why: resolving a workspace per session on every status tick is sessions x workspaces path work.
  const sessionWorktrees = useAiVaultSessionWorktreeMap({
    sessions: history.sessions,
    repos,
    worktrees
  })
  const now = useNow(30_000)
  const rows = useMemo(
    () => buildChatSidebarRows(state, history.sessions, now, sessionWorktrees, true),
    [state, history.sessions, now, sessionWorktrees]
  )
  useEffect(() => {
    syncChatSidebarTabTitles(rows)
    void updateChatSidebar((current) =>
      chatSidebarPreferencePatch(rows, current, Date.now(), { scannedSessions: history.sessions })
    )
  }, [rows, history.sessions])
  const attemptedEmpty = useRef(new Set<string>())
  useEffect(() => {
    if (!history.scanResult || history.scanResult.cancelled) {
      return
    }
    const controller = new AbortController()
    void classifyUnscannedClaudeHistory({
      sessions: useAppStore.getState().settings?.chatSidebar?.sessions,
      scannedSessions: history.scanResult.sessions,
      resolveTitles: (request) => window.api.aiVault.resolveSessionTitles(request),
      update: updateChatSidebar,
      signal: controller.signal,
      attemptedEmpty: attemptedEmpty.current
    }).catch((error) => console.debug('[chat-sidebar] headless history lookup failed', error))
    return () => controller.abort()
  }, [history.scanResult])
  const chats = useMemo(() => rows.filter((row) => !row.automated), [rows])
  return { rows: chats, state, worktrees, history }
}
