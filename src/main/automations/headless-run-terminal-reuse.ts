import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun
} from '../../shared/automations-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** Reuse only a completed, untouched pane whose PTY and agent still match. */
export function findReusableRunTerminal(input: {
  store: Store
  runtime: OrcaRuntimeService
  automation: Automation
  currentRun: AutomationRun
  reusedPaneRuns: Map<string, string>
}): { run: AutomationRun & { terminalPaneKey: string }; handle: string } | null {
  const { store, runtime, automation, currentRun, reusedPaneRuns } = input
  const runs = store.listAutomationRuns(automation.id)
  for (const candidate of runs
    .filter(
      (run) =>
        run.id !== currentRun.id &&
        run.workspaceId === automation.workspaceId &&
        run.status === 'completed' &&
        Boolean(run.terminalPaneKey && run.terminalPtyId)
    )
    .sort((a, b) => b.createdAt - a.createdAt)) {
    const paneKey = candidate.terminalPaneKey!
    const previousUse = reusedPaneRuns.get(paneKey)
    if (previousUse) {
      const previousRun = runs.find((run) => run.id === previousUse)
      if (previousRun && !isFinalAutomationRunStatus(previousRun.status)) {
        continue
      }
      reusedPaneRuns.delete(paneKey)
    }
    if (
      runs.some(
        (run) =>
          run.id !== candidate.id &&
          run.terminalPaneKey === paneKey &&
          !isFinalAutomationRunStatus(run.status)
      )
    ) {
      continue
    }
    const handle = runtime.getTerminalHandleForPaneKey(paneKey)
    if (
      !handle ||
      runtime.getTerminalPtyIdForHandle(handle) !== candidate.terminalPtyId ||
      runtime.readTerminalClientUse(candidate.terminalPtyId!) !== 'unused'
    ) {
      continue
    }
    const latest = runtime
      .getAgentStatusRowsForPane(paneKey)
      .toSorted((a, b) => b.receivedAt - a.receivedAt)[0]
    if (
      latest?.state !== 'done' ||
      (latest.agentType &&
        latest.agentType !== 'unknown' &&
        latest.agentType !== automation.agentId)
    ) {
      continue
    }
    return { run: candidate as AutomationRun & { terminalPaneKey: string }, handle }
  }
  return null
}
