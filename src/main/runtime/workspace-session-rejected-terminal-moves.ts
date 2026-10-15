import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { rebaseTabGroups } from './workspace-session-tab-group-membership'
import { pruneTabGroupLayoutAfterRetirement } from './mobile-session-terminal-retirement'
import { collectTabGroupLayoutGroupIds } from './headless-tab-group-split-layout'

/** Restore only contested tabs, leaving unrelated renderer membership changes intact. */
export function restoreRejectedWorkspaceTerminalMoves(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  rejected: ReadonlyMap<string, TerminalTab>
): WorkspaceSessionState {
  if (rejected.size === 0) {
    return incoming
  }
  const tabsByWorktree = { ...incoming.tabsByWorktree }
  const unifiedTabs = { ...incoming.unifiedTabs }
  const tabGroups = { ...incoming.tabGroups }
  const tabGroupLayouts = { ...incoming.tabGroupLayouts }
  const activeTabIdByWorktree = { ...incoming.activeTabIdByWorktree }
  const activeGroupIdByWorktree = { ...incoming.activeGroupIdByWorktree }
  const terminalLayoutsByTabId = { ...incoming.terminalLayoutsByTabId }
  const terminalPtyIncarnationsByPaneKey = { ...incoming.terminalPtyIncarnationsByPaneKey }
  const worktreeIds = new Set(
    Object.keys(tabsByWorktree).filter((id) =>
      tabsByWorktree[id].some((tab) => rejected.has(tab.id))
    )
  )
  for (const [id, tabs] of Object.entries(unifiedTabs)) {
    if (
      tabs.some(
        (tab) =>
          tab.contentType === 'terminal' && (rejected.has(tab.id) || rejected.has(tab.entityId))
      )
    ) {
      worktreeIds.add(id)
    }
  }
  for (const tab of rejected.values()) {
    worktreeIds.add(tab.worktreeId)
    if (prior.terminalLayoutsByTabId[tab.id]) {
      terminalLayoutsByTabId[tab.id] = prior.terminalLayoutsByTabId[tab.id]
    } else {
      delete terminalLayoutsByTabId[tab.id]
    }
  }
  for (const paneKey of Object.keys(terminalPtyIncarnationsByPaneKey)) {
    if (rejected.has(paneKey.slice(0, paneKey.lastIndexOf(':')))) {
      delete terminalPtyIncarnationsByPaneKey[paneKey]
    }
  }
  for (const [paneKey, incarnation] of Object.entries(
    prior.terminalPtyIncarnationsByPaneKey ?? {}
  )) {
    if (rejected.has(paneKey.slice(0, paneKey.lastIndexOf(':')))) {
      terminalPtyIncarnationsByPaneKey[paneKey] = incarnation
    }
  }
  for (const worktreeId of worktreeIds) {
    const tabs = (tabsByWorktree[worktreeId] ?? []).filter((tab) => !rejected.has(tab.id))
    const restored = [...rejected.values()].filter((tab) => tab.worktreeId === worktreeId)
    tabsByWorktree[worktreeId] = [...tabs, ...restored]
    const unified = (unifiedTabs[worktreeId] ?? []).filter(
      (tab) =>
        tab.contentType !== 'terminal' || (!rejected.has(tab.id) && !rejected.has(tab.entityId))
    )
    const restoredUnified = (prior.unifiedTabs?.[worktreeId] ?? []).filter(
      (tab) =>
        tab.contentType === 'terminal' &&
        (rejected.get(tab.id)?.worktreeId === worktreeId ||
          rejected.get(tab.entityId)?.worktreeId === worktreeId)
    )
    unifiedTabs[worktreeId] = [...unified, ...restoredUnified]
    const validIds = new Set([
      ...tabsByWorktree[worktreeId].map((tab) => tab.id),
      ...unifiedTabs[worktreeId].map((tab) => tab.id)
    ])
    const restoredIds = new Set([
      ...restored.map((tab) => tab.id),
      ...restoredUnified.map((tab) => tab.id)
    ])
    const groups = [...(tabGroups[worktreeId] ?? [])]
    for (const priorGroup of prior.tabGroups?.[worktreeId] ?? []) {
      const restoredOrder = priorGroup.tabOrder.filter((id) => restoredIds.has(id))
      if (restoredOrder.length === 0) {
        continue
      }
      const index = groups.findIndex((group) => group.id === priorGroup.id)
      const current = groups[index] ?? { ...priorGroup, tabOrder: restoredOrder }
      const group = { ...current, tabOrder: [...new Set([...current.tabOrder, ...restoredOrder])] }
      if (index !== -1) {
        groups[index] = group
      } else {
        groups.push(group)
      }
    }
    const rebasedGroups = rebaseTabGroups(groups, validIds)
    tabGroups[worktreeId] = rebasedGroups
    const groupIds = new Set(rebasedGroups.map((group) => group.id))
    let layout = pruneTabGroupLayoutAfterRetirement(
      incoming.tabGroupLayouts?.[worktreeId] ?? prior.tabGroupLayouts?.[worktreeId],
      groupIds
    )
    const layoutIds = collectTabGroupLayoutGroupIds(layout)
    if ([...groupIds].some((id) => !layoutIds.has(id))) {
      const priorLayout = pruneTabGroupLayoutAfterRetirement(
        prior.tabGroupLayouts?.[worktreeId],
        groupIds
      )
      const priorIds = collectTabGroupLayoutGroupIds(priorLayout)
      if ([...groupIds].every((id) => priorIds.has(id))) {
        layout = priorLayout
      } else {
        for (const groupId of groupIds) {
          if (!layoutIds.has(groupId)) {
            const leaf = { type: 'leaf' as const, groupId }
            layout = layout
              ? { type: 'split', direction: 'horizontal', first: layout, second: leaf }
              : leaf
          }
        }
      }
    }
    if (layout) {
      tabGroupLayouts[worktreeId] = layout
    } else {
      delete tabGroupLayouts[worktreeId]
    }
    if (!validIds.has(activeTabIdByWorktree[worktreeId] ?? '')) {
      activeTabIdByWorktree[worktreeId] =
        rebasedGroups[0]?.activeTabId ?? tabsByWorktree[worktreeId][0]?.id ?? null
    }
    if (!rebasedGroups.some((group) => group.id === activeGroupIdByWorktree[worktreeId])) {
      const activeGroup = rebasedGroups[0]?.id
      if (activeGroup) {
        activeGroupIdByWorktree[worktreeId] = activeGroup
      } else {
        delete activeGroupIdByWorktree[worktreeId]
      }
    }
  }
  return {
    ...incoming,
    tabsByWorktree,
    terminalLayoutsByTabId,
    terminalPtyIncarnationsByPaneKey,
    activeTabIdByWorktree,
    ...(incoming.unifiedTabs || prior.unifiedTabs ? { unifiedTabs } : {}),
    ...(incoming.tabGroups || prior.tabGroups ? { tabGroups } : {}),
    ...(incoming.tabGroupLayouts || prior.tabGroupLayouts ? { tabGroupLayouts } : {}),
    ...(incoming.activeGroupIdByWorktree ? { activeGroupIdByWorktree } : {})
  }
}
