import { useAppStore } from '../store'

// Terminal and structured chat tabs expose different active IDs.
export function resolveRenameTargetTabId(activeWorktreeId: string | null): string | null {
  const store = useAppStore.getState()
  if (store.activeTabType === 'terminal') {
    return store.activeTabId
  }
  if (store.activeTabType !== 'agent-session' || !activeWorktreeId) {
    return null
  }
  const activeTab = store.getActiveTab(activeWorktreeId)
  return activeTab?.contentType === 'agent-session' ? activeTab.id : null
}
