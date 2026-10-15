import type { TabGroup } from '../../shared/tab-types'

export function rebaseTabGroups(
  groups: readonly TabGroup[],
  validTabIds: ReadonlySet<string>
): TabGroup[] {
  return groups.flatMap((group) => {
    const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId))
    if (tabOrder.length === 0) {
      return []
    }
    const tabIds = new Set(tabOrder)
    const activeTabId =
      group.activeTabId && tabIds.has(group.activeTabId) ? group.activeTabId : (tabOrder[0] ?? null)
    const recentTabIds = group.recentTabIds?.filter((tabId) => tabIds.has(tabId))
    return [
      {
        ...group,
        tabOrder,
        activeTabId,
        // Why assigned even when it filters to empty: omitting the key lets `...group`
        // re-introduce the unfiltered array, persisting ids for tabs the host dropped.
        ...(group.recentTabIds ? { recentTabIds: recentTabIds ?? [] } : {})
      }
    ]
  })
}
