import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import type { AutomationRunWriter } from './automation-run-writer'
import { missedBeyondGrace, recordMissedRun } from './dispatch-refusal'

const LOCAL_RESOURCE_DEFERRAL_LIMIT_MS = 24 * 60 * 60 * 1000

export class ScheduledLocalAutomationDeferredError extends Error {}

/** Keep a local scheduled occurrence due until the laptop is quiet and no other agent run owns it. */
export function canStartScheduledLocalAutomation(
  automation: Pick<Automation, 'executionTargetType'>,
  store: Pick<Store, 'listAutomations' | 'listAutomationRuns'>,
  ready: (() => boolean) | null
): boolean {
  if (automation.executionTargetType !== 'local' || !ready) {
    return true
  }
  if (!ready()) {
    return false
  }
  const localIds = new Set(
    store
      .listAutomations()
      .filter((item) => item.executionTargetType === 'local')
      .map((item) => item.id)
  )
  return !store
    .listAutomationRuns()
    .some(
      (run) =>
        localIds.has(run.automationId) &&
        (run.status === 'dispatching' || run.status === 'dispatched')
    )
}

/** Persist one deferred occurrence so laptop activity or an app restart cannot consume its grace. */
export async function prepareScheduledAutomation(input: {
  automation: Automation
  store: Pick<Store, 'listAutomations' | 'listAutomationRuns' | 'getLatestAutomationOccurrence'>
  runs: AutomationRunWriter
  ready: (() => boolean) | null
  now: number
  tickMs: number
}): Promise<number | null> {
  const { automation, store, runs, ready, now, tickMs } = input
  let deferred =
    automation.executionTargetType === 'local' && ready
      ? store
          .listAutomationRuns(automation.id)
          .find((run) => run.trigger === 'scheduled' && run.status === 'pending')
      : undefined
  let scheduledFor = deferred?.scheduledFor ?? store.getLatestAutomationOccurrence(automation, now)
  if (scheduledFor === null) {
    await runs.advanceNextRun(automation.id, now)
    return null
  }
  const changedWhileWaiting =
    deferred && (automation.definitionRevision ?? 0) !== (deferred.definitionRevision ?? 0)
  const expired = deferred && now - deferred.createdAt >= LOCAL_RESOURCE_DEFERRAL_LIMIT_MS
  if (deferred && (changedWhileWaiting || expired)) {
    await runs.updateRun({
      runId: deferred.id,
      status: changedWhileWaiting ? 'skipped_unavailable' : 'skipped_missed',
      error: changedWhileWaiting
        ? 'This automation changed while its local run was waiting for resources.'
        : 'This run waited 24 hours for the local computer to become idle and was skipped.'
    })
    const currentOccurrence = store.getLatestAutomationOccurrence(automation, now)
    if (currentOccurrence === null || currentOccurrence <= deferred.scheduledFor) {
      await runs.advanceNextRun(automation.id, now)
      return null
    }
    scheduledFor = currentOccurrence
    deferred = undefined
  }
  if (!deferred && missedBeyondGrace({ automation, scheduledFor, now, tickMs })) {
    await recordMissedRun({ runs, automation, scheduledFor })
    await runs.advanceNextRun(automation.id, now)
    return null
  }
  if (!canStartScheduledLocalAutomation(automation, store, ready)) {
    if (!deferred) {
      await runs.createRun(automation, scheduledFor)
    }
    return null
  }
  return scheduledFor
}
