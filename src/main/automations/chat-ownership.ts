import type { Store } from '../persistence'
import { isFinalAutomationRunStatus, type AutomationRun } from '../../shared/automations-types'
import type { AgentHookProviderSessionIdentity } from '../agent-hooks/server'
import { toSshExecutionHostId } from '../../shared/execution-host'

/** Keep origin after completion clears the run's terminal pointers. */
export function recordAutomationChatOwnership(
  store: Pick<Store, 'getSettings' | 'updateSettings' | 'listAutomations'>,
  run: AutomationRun,
  providers: readonly AgentHookProviderSessionIdentity[]
): void {
  if (!run.terminalSessionId && !run.terminalPaneKey && !run.usage?.providerSessionId) {
    return
  }
  const automation = store.listAutomations().find((item) => item.id === run.automationId)
  const hostId =
    run.runContext?.hostId ??
    automation?.runContext?.hostId ??
    (automation?.executionTargetType === 'ssh'
      ? toSshExecutionHostId(automation.executionTargetId)
      : automation?.executionTargetType === 'local'
        ? 'local'
        : null)
  if (!hostId) {
    return
  }
  const ids = [run.terminalSessionId, run.terminalPaneKey].flatMap((id) =>
    id ? [JSON.stringify([hostId, id])] : []
  )
  const provider = providers.find((item) => item.paneKey === run.terminalPaneKey)
  const sessionId = provider?.sessionId ?? run.usage?.providerSessionId
  const agent = automation?.agentId ?? run.usage?.provider
  if (sessionId && agent) {
    ids.push(JSON.stringify([hostId, agent, sessionId]))
  }
  const sidebar = store.getSettings().chatSidebar ?? {}
  const existing = new Set(sidebar.automationChats ?? [])
  if (ids.every((id) => existing.has(id))) {
    return
  }
  store.updateSettings(
    { chatSidebar: { ...sidebar, automationChats: [...new Set([...existing, ...ids])] } },
    { notifyListeners: true }
  )
}

/** Hook identity may arrive after dispatch and before the next run write. Tag it immediately. */
export function recordAutomationProviderSessionOwnership(
  store: Pick<Store, 'getSettings' | 'updateSettings' | 'listAutomations' | 'listAutomationRuns'>,
  providers: readonly AgentHookProviderSessionIdentity[]
): void {
  if (!providers.length) {
    return
  }
  const byPane = new Map(providers.map((provider) => [provider.paneKey, provider]))
  for (const run of store.listAutomationRuns()) {
    if (
      !isFinalAutomationRunStatus(run.status) &&
      run.terminalPaneKey &&
      byPane.has(run.terminalPaneKey)
    ) {
      recordAutomationChatOwnership(store, run, [byPane.get(run.terminalPaneKey)!])
    }
  }
}
