import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { findRenamableUnifiedTab } from './renamable-unified-tab'
import { updateChatSidebarSettings } from '@/lib/chat-sidebar-settings-update'
import { chatSidebarTabRename } from '@/components/sidebar/chat-sidebar-tab-rename'

export function createTerminalTabAttentionActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'markTerminalTabUnread'
  | 'markTerminalPaneUnread'
  | 'markAgentCompletionPaneUnread'
  | 'clearTerminalTabUnread'
  | 'clearTerminalPaneUnread'
  | 'setTabCustomTitle'
  | 'setTabColor'
> {
  return {
    markTerminalTabUnread: (tabId, reason) => {
      const state = get()
      // Why both indexes: a container id is a terminal tab id, or a structured chat's unified tab
      // id (which has no TerminalTab record) — the same pair `findRenamableUnifiedTab` resolves,
      // and the same pair SortableTab reads this marker back under.
      const ownsTab =
        Object.values(state.tabsByWorktree ?? {})
          .flat()
          .some((tab) => tab.id === tabId) ||
        Object.values(state.unifiedTabsByWorktree ?? {})
          .flat()
          .some((tab) => tab.contentType === 'agent-session' && tab.id === tabId)
      if (!ownsTab) {
        return
      }
      // Why: terminal attention persists until real interaction.
      set((s) => {
        if (s.unreadTerminalTabs[tabId]) {
          return s
        }
        return { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: reason } }
      })
    },
    markTerminalPaneUnread: (paneKey, reason) => {
      set((s) => {
        if (s.unreadTerminalPanes[paneKey]) {
          return s
        }
        return { unreadTerminalPanes: { ...s.unreadTerminalPanes, [paneKey]: reason } }
      })
    },
    markAgentCompletionPaneUnread: (paneKey, reason) => {
      set((s) => {
        if (s.unreadAgentCompletionPanes[paneKey]) {
          return s
        }
        return {
          unreadAgentCompletionPanes: {
            ...s.unreadAgentCompletionPanes,
            [paneKey]: reason
          }
        }
      })
    },
    clearTerminalTabUnread: (tabId) => {
      set((s) => {
        if (!s.unreadTerminalTabs[tabId]) {
          return s
        }
        const copy = { ...s.unreadTerminalTabs }
        delete copy[tabId]
        return { unreadTerminalTabs: copy }
      })
    },
    clearTerminalPaneUnread: (paneKey) => {
      set((s) => {
        if (!s.unreadTerminalPanes[paneKey] && !s.unreadAgentCompletionPanes[paneKey]) {
          return s
        }
        const nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
        const nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
        delete nextUnreadTerminalPanes[paneKey]
        delete nextUnreadAgentCompletionPanes[paneKey]
        return {
          unreadTerminalPanes: nextUnreadTerminalPanes,
          unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes
        }
      })
    },
    setTabCustomTitle: (tabId, title, opts) => {
      const applyTitle = () => {
        set((s) => {
          const next = { ...s.tabsByWorktree }
          for (const wId of Object.keys(next)) {
            next[wId] = next[wId].map((t) =>
              t.id === tabId
                ? { ...t, customTitle: title, sidebarTitleId: opts?.sidebarTitleId }
                : t
            )
          }
          scheduleRuntimeGraphSync()
          return { tabsByWorktree: next }
        })
        const item = findRenamableUnifiedTab(get().unifiedTabsByWorktree, tabId)
        if (item) {
          get().setTabCustomLabel(item.id, title, opts)
        }
      }
      const state = get()
      if (
        opts?.syncSidebarTitle !== false &&
        state.settings?.chatSidebar?.titles &&
        chatSidebarTabRename(state, tabId, title, state.settings.chatSidebar)
      ) {
        // Why: clearing a title must clear its saved name before restore can fill the tab again.
        void updateChatSidebarSettings(get, (current) =>
          chatSidebarTabRename(get(), tabId, title, current)
        )
          .then(applyTitle)
          .catch((error) => {
            applyTitle()
            console.debug('[chat-sidebar] tab rename could not be saved', error)
          })
      } else {
        applyTitle()
      }
    },
    setTabColor: (tabId, color) => {
      set((s) => {
        const next = { ...s.tabsByWorktree }
        for (const wId of Object.keys(next)) {
          next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, color } : t))
        }
        return { tabsByWorktree: next }
      })
      const item = findRenamableUnifiedTab(get().unifiedTabsByWorktree, tabId)
      if (item) {
        get().setUnifiedTabColor(item.id, color)
        // Why: tab color is host-authoritative for remote-server tabs; mirror it so it persists instead of reverting on the next snapshot.
        const state = get()
        const owningWorktreeId = Object.keys(state.unifiedTabsByWorktree).find((wId) =>
          (state.unifiedTabsByWorktree[wId] ?? []).some((entry) => entry.id === item.id)
        )
        if (
          owningWorktreeId &&
          resolveTerminalWorktreeRoute(state, owningWorktreeId)?.runtimeEnvironmentId
        ) {
          void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
            setWebRuntimeTabProps({ worktreeId: owningWorktreeId, tabId: item.id, color })
          )
        }
      }
    }
  }
}
