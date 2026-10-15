import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ChatSidebarRow } from './chat-sidebar-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { updateChatSidebarSettings } from '@/lib/chat-sidebar-settings-update'
import { chatWorkspaceFolderKey } from './chat-sidebar-workspace-folder'
import { chatCompletionEdit, chatPreference } from './chat-sidebar-identity'
import { buildChatSidebarRows } from './chat-sidebar-rows'

type Preferences = NonNullable<GlobalSettings['chatSidebar']>

export function updateChatSidebar(
  patch: Partial<Preferences> | ((current: Preferences) => Partial<Preferences> | null)
) {
  return updateChatSidebarSettings(useAppStore.getState, patch)
}

export function setChatCompleted(row: ChatSidebarRow, completed: boolean) {
  return updateChatSidebar((current) => chatCompletionEdit(row, current, completed, Date.now()))
}

export async function setChatSidebarTitle(
  row: Pick<ChatSidebarRow, 'id' | 'aliases'> & Partial<Pick<ChatSidebarRow, 'tabId'>>,
  title: string
) {
  await updateChatSidebar((current) => {
    const titles = { ...current.titles }
    // Why: a name left under an earlier id would resurface when this one is cleared.
    for (const id of [row.id, ...row.aliases]) {
      delete titles[id]
    }
    if (title.trim()) {
      titles[row.id] = title.trim()
    }
    return { titles }
  })
  if (row.tabId) {
    const state = useAppStore.getState()
    const siblings = buildChatSidebarRows(state, [], Date.now(), undefined, true).filter(
      (item) => item.tabId === row.tabId
    )
    // Why: several conversations can occupy one terminal tab; the tab is not their shared name.
    if (siblings.length === 1) {
      state.setTabCustomTitle(row.tabId, title.trim() || null, {
        recordInteraction: false,
        syncSidebarTitle: false,
        sidebarTitleId: title.trim() ? row.id : undefined
      })
    }
  }
}

/** Apply saved sidebar names to restored tabs without replacing provider session titles. */
export function syncChatSidebarTabTitles(rows: readonly ChatSidebarRow[]) {
  const state = useAppStore.getState()
  if (!state.settings?.chatSidebar?.titles) {
    return
  }
  for (const row of rows) {
    if (!row.tabId || row.automated) {
      continue
    }
    const title = chatPreference(state.settings.chatSidebar.titles, row)
    const terminal = state.tabsByWorktree[row.worktree.id]?.find((tab) => tab.id === row.tabId)
    const unified = state.unifiedTabsByWorktree[row.worktree.id]?.find(
      (tab) =>
        tab.id === row.tabId || (tab.contentType === 'terminal' && tab.entityId === row.tabId)
    )
    const siblings = rows.filter((item) => item.tabId === row.tabId)
    if (
      terminal?.sidebarTitleId &&
      (siblings.length !== 1 || ![row.id, ...row.aliases].includes(terminal.sidebarTitleId))
    ) {
      state.setTabCustomTitle(row.tabId, null, {
        recordInteraction: false,
        syncSidebarTitle: false
      })
      continue
    }
    if (
      title &&
      siblings.length === 1 &&
      (terminal || unified) &&
      !(terminal?.customTitle ?? unified?.customLabel)
    ) {
      state.setTabCustomTitle(row.tabId, title, {
        recordInteraction: false,
        syncSidebarTitle: false,
        sidebarTitleId: row.id
      })
    }
  }
}

export function setChatFolder(
  row: ChatSidebarRow,
  destination: Worktree,
  movedFromWorkspaceId?: string
) {
  return updateChatSidebar((current) => {
    const folderAssignments = { ...current.folderAssignments }
    for (const id of [row.id, ...row.aliases]) {
      delete folderAssignments[id]
    }
    folderAssignments[row.id] = { worktreeId: destination.id, executionHostId: row.hostId }
    return {
      folderAssignments,
      ...(row.tabId && movedFromWorkspaceId
        ? {
            sessions: Object.fromEntries(
              Object.entries(current.sessions ?? {}).map(([key, saved]) => [
                key,
                saved.resumeLauncher?.tabId === row.tabId &&
                saved.worktreeId === movedFromWorkspaceId
                  ? { ...saved, worktreeId: row.worktree.id, ownsWorkspaceName: false }
                  : saved
              ])
            )
          }
        : {}),
      ...(row.tabId
        ? {
            workspaceFolderAssignments: {
              ...current.workspaceFolderAssignments,
              [chatWorkspaceFolderKey(row)]: folderAssignments[row.id]
            }
          }
        : {})
    }
  })
}
