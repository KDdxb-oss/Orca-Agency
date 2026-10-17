import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findTabAndWorktree, pickNextActiveTab, sanitizeRecentTabIds } from '../tab-group-state'
import { collapseGroupLayout } from './tabs-layout'
import { buildActiveSurfacePatch } from './tabs-surface'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { moveParkedTerminalTabWorkspace } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { applyTabOrderSortValues } from './tabs-tab-order'

/** Move the surface, retaining its terminal, pane identities, drafts and provider session. */
export function createTabsWorkspaceTransferActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'moveTerminalTabToWorkspace'> {
  return {
    moveTerminalTabToWorkspace: (tabId, destinationId, options) => {
      let moved = false
      let sourceWorkspaceId: string | null = null
      let terminalTabId: string | null = null
      set((state) => {
        const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        if (!found || found.tab.contentType !== 'terminal' || found.worktreeId === destinationId) {
          return state
        }
        const { tab, worktreeId: sourceId } = found
        const terminal = state.tabsByWorktree[sourceId]?.find((item) => item.id === tab.entityId)
        const sourceGroup = state.groupsByWorktree[sourceId]?.find(
          (item) => item.id === tab.groupId
        )
        const targetGroup = options?.groupId
          ? state.groupsByWorktree[destinationId]?.find((group) => group.id === options.groupId)
          : state.groupsByWorktree[destinationId]?.[0]
        const source = state.getKnownWorktreeById(sourceId, 'local')
        const destination = state.getKnownWorktreeById(destinationId, 'local')
        if (
          !source ||
          !destination ||
          !terminal ||
          !sourceGroup ||
          !targetGroup ||
          getConnectionIdFromState(state, sourceId) !== null ||
          getConnectionIdFromState(state, destinationId) !== null ||
          (tab.executionHostId && tab.executionHostId !== 'local')
        ) {
          return state
        }
        const sourceOrder = sourceGroup.tabOrder.filter((id) => id !== tabId)
        const targetOrder = targetGroup.tabOrder.filter((id) => id !== tabId)
        targetOrder.splice(
          Math.max(0, Math.min(options?.index ?? targetOrder.length, targetOrder.length)),
          0,
          tabId
        )
        const destinationOrder = state.groupsByWorktree[destinationId].flatMap((group) =>
          group.id === targetGroup.id ? targetOrder : group.tabOrder
        )
        const destinationTabs = applyTabOrderSortValues(
          [
            ...(state.unifiedTabsByWorktree[destinationId] ?? []),
            { ...tab, worktreeId: destinationId, groupId: targetGroup.id }
          ],
          destinationOrder
        ).sort((a, b) => a.sortOrder - b.sortOrder)
        const terminalOrder = new Map(
          destinationTabs
            .filter((item) => item.contentType === 'terminal')
            .map((item, index) => [item.entityId, index])
        )
        const legacyOrder = destinationTabs.map((item) => item.entityId)
        const removeSourceGroup =
          sourceOrder.length === 0 && state.groupsByWorktree[sourceId].length > 1
        const nextSourceGroups = state.groupsByWorktree[sourceId].map((group) =>
          group.id === sourceGroup.id
            ? {
                ...group,
                tabOrder: sourceOrder,
                activeTabId:
                  group.activeTabId === tabId
                    ? pickNextActiveTab(group.tabOrder, group.recentTabIds, tabId)
                    : group.activeTabId,
                recentTabIds: sanitizeRecentTabIds(group.recentTabIds, sourceOrder)
              }
            : group
        )
        const collapsed = removeSourceGroup
          ? collapseGroupLayout(
              state.layoutByWorktree,
              state.activeGroupIdByWorktree,
              sourceId,
              sourceGroup.id,
              nextSourceGroups.find((group) => group.id !== sourceGroup.id)?.id
            )
          : {
              layoutByWorktree: state.layoutByWorktree,
              activeGroupIdByWorktree: state.activeGroupIdByWorktree
            }
        const patch = {
          ...collapsed,
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [sourceId]: state.tabsByWorktree[sourceId].filter((item) => item.id !== terminal.id),
            [destinationId]: [
              ...(state.tabsByWorktree[destinationId] ?? []),
              {
                ...terminal,
                worktreeId: destinationId,
                startupCwd: terminal.startupCwd ?? source.path,
                workspaceMoveRevision: (terminal.workspaceMoveRevision ?? 0) + 1,
                relocatedFromWorktreeIds: [
                  ...new Set([...(terminal.relocatedFromWorktreeIds ?? []), sourceId])
                ]
              }
            ]
              .map((item) => ({ ...item, sortOrder: terminalOrder.get(item.id) ?? item.sortOrder }))
              .sort((a, b) => a.sortOrder - b.sortOrder)
          },
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [sourceId]: state.unifiedTabsByWorktree[sourceId].filter((item) => item.id !== tabId),
            [destinationId]: destinationTabs
          },
          retainedAgentsByPaneKey: Object.fromEntries(
            Object.entries(state.retainedAgentsByPaneKey).map(([key, retained]) => [
              key,
              retained.worktreeId === sourceId && retained.tab.id === terminal.id
                ? {
                    ...retained,
                    worktreeId: destinationId,
                    tab: { ...retained.tab, worktreeId: destinationId }
                  }
                : retained
            ])
          ),
          agentStatusByPaneKey: Object.fromEntries(
            Object.entries(state.agentStatusByPaneKey).map(([key, entry]) => [
              key,
              !entry.connectionId && parsePaneKey(key)?.tabId === terminal.id
                ? { ...entry, worktreeId: destinationId }
                : entry
            ])
          ),
          sleepingAgentSessionsByPaneKey: Object.fromEntries(
            Object.entries(state.sleepingAgentSessionsByPaneKey).map(([key, saved]) => [
              key,
              saved.worktreeId === sourceId && parsePaneKey(key)?.tabId === terminal.id
                ? { ...saved, worktreeId: destinationId }
                : saved
            ])
          ),
          pendingReconnectTabByWorktree: {
            ...state.pendingReconnectTabByWorktree,
            ...(state.pendingReconnectTabByWorktree[sourceId]?.includes(terminal.id)
              ? {
                  [sourceId]: state.pendingReconnectTabByWorktree[sourceId].filter(
                    (id) => id !== terminal.id
                  ),
                  [destinationId]: [
                    ...new Set([
                      ...(state.pendingReconnectTabByWorktree[destinationId] ?? []),
                      terminal.id
                    ])
                  ]
                }
              : {})
          },
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [sourceId]: removeSourceGroup
              ? nextSourceGroups.filter((group) => group.id !== sourceGroup.id)
              : nextSourceGroups,
            [destinationId]: state.groupsByWorktree[destinationId].map((group) =>
              group.id === targetGroup.id
                ? {
                    ...targetGroup,
                    activeTabId: tabId,
                    tabOrder: targetOrder,
                    recentTabIds: [
                      tabId,
                      ...(targetGroup.recentTabIds ?? []).filter((id) => id !== tabId)
                    ]
                  }
                : group
            )
          },
          activeGroupIdByWorktree: {
            ...collapsed.activeGroupIdByWorktree,
            [destinationId]: targetGroup.id
          },
          activeTabIdByWorktree: {
            ...state.activeTabIdByWorktree,
            [sourceId]:
              state.activeTabIdByWorktree[sourceId] === terminal.id
                ? (state.tabsByWorktree[sourceId].find((item) => item.id !== terminal.id)?.id ??
                  null)
                : state.activeTabIdByWorktree[sourceId],
            [destinationId]: terminal.id
          },
          tabBarOrderByWorktree: {
            ...state.tabBarOrderByWorktree,
            [sourceId]: (state.tabBarOrderByWorktree[sourceId] ?? []).filter(
              (id) => id !== terminal.id
            ),
            [destinationId]: [
              ...legacyOrder,
              ...(state.tabBarOrderByWorktree[destinationId] ?? []).filter(
                (id) => id !== terminal.id && !legacyOrder.includes(id)
              )
            ]
          }
        }
        moved = true
        sourceWorkspaceId = sourceId
        terminalTabId = terminal.id
        return {
          ...patch,
          ...(state.activeWorktreeId === sourceId
            ? buildActiveSurfacePatch({ ...state, ...patch }, sourceId)
            : {})
        }
      })
      if (moved) {
        if (sourceWorkspaceId && terminalTabId) {
          moveParkedTerminalTabWorkspace(terminalTabId, sourceWorkspaceId, destinationId)
        }
        scheduleRuntimeGraphSync()
        get().recordFeatureInteraction?.('tab-splits')
      }
      return moved
    }
  }
}
