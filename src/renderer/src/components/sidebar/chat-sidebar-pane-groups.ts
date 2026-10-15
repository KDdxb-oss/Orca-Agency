import type { AppState } from '@/store/types'
import { collectLayoutGroupIds } from '@/runtime/web-session-tabs-sync/tab-group-layout-tree'
import { collectLeafIdsInOrder } from '../terminal-pane/terminal-layout-leaf-ids'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { ChatSidebarRow } from './chat-sidebar-types'
import type { ChatWorkspaceGroup } from './chat-sidebar-split-groups'

export type ChatPaneLayout = Partial<
  Pick<
    AppState,
    'groupsByWorktree' | 'layoutByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
  >
>

/** Split visible panes into sibling groups; tabs sharing a pane retain their elbows. */
export function chatSidebarPaneGroups(
  groups: ChatWorkspaceGroup[],
  state: ChatPaneLayout
): ChatWorkspaceGroup[] {
  return groups.flatMap((group) => {
    const first = group.members[0]
    if (!first.tabId) {
      return [group]
    }
    const worktreeId = first.worktree.id
    const unified = state.unifiedTabsByWorktree?.[worktreeId] ?? []
    const tabGroups = state.groupsByWorktree?.[worktreeId] ?? []
    const layoutIds = [...collectLayoutGroupIds(state.layoutByWorktree?.[worktreeId])]
    const visibleIds = layoutIds.length ? layoutIds : tabGroups.map((item) => item.id)
    const panes = new Map<string, { members: ChatSidebarRow[]; order: number }>()
    const tabOrder = new Map<string, number>()
    for (const row of group.members) {
      const tab = unified.find(
        (item) =>
          item.id === row.tabId || (item.contentType === 'terminal' && item.entityId === row.tabId)
      )
      const owner = tabGroups.find((item) => item.tabOrder.includes(tab?.id ?? row.tabId ?? ''))
      const index = owner?.tabOrder.indexOf(tab?.id ?? row.tabId ?? '') ?? -1
      if (index >= 0) {
        tabOrder.set(row.id, index)
      }
      const groupId = owner?.id ?? tab?.groupId
      const paneId =
        groupId && visibleIds.includes(groupId) ? groupId : (visibleIds[0] ?? 'default')
      const leaves = row.tabId
        ? collectLeafIdsInOrder(state.terminalLayoutsByTabId?.[row.tabId]?.root)
        : []
      const leaf = row.paneKey ? parsePaneKey(row.paneKey)?.leafId : undefined
      const leafIndex = leaf ? leaves.indexOf(leaf) : -1
      const chatLeaves = new Set(
        group.members.flatMap((member) => {
          const id = member.paneKey ? parsePaneKey(member.paneKey)?.leafId : undefined
          return member.tabId === row.tabId && id && leaves.includes(id) ? [id] : []
        })
      )
      const terminalSplit = chatLeaves.size > 1 && leafIndex >= 0
      const key = JSON.stringify([
        paneId,
        terminalSplit ? row.tabId : null,
        terminalSplit ? leaf : null
      ])
      const pane = panes.get(key) ?? {
        members: [],
        order:
          Math.max(0, visibleIds.indexOf(paneId)) + (terminalSplit ? leafIndex / leaves.length : 0)
      }
      pane.members.push(row)
      panes.set(key, pane)
    }
    for (const pane of panes.values()) {
      pane.members.sort(
        (a, b) =>
          (tabOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (tabOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      )
    }
    if (panes.size < 2) {
      return [{ ...group, members: [...panes.values()][0].members }]
    }
    const splitId = `panes:${JSON.stringify([first.hostId, worktreeId, group.id])}`
    return [...panes.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([paneId, pane]) => ({
        id: JSON.stringify([group.id, paneId]),
        members: pane.members,
        paneSplitId: splitId
      }))
  })
}
