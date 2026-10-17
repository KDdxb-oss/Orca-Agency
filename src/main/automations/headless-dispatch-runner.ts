import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'
import type {
  HeadlessAutomationDispatcher,
  HeadlessAutomationDispatchLaunch
} from './headless-dispatch'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'
import { ScheduledLocalAutomationDeferredError } from './local-schedule-gate'

export type HeadlessAutomationDispatchContext = {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  dispatcher: HeadlessAutomationDispatcher
  runs: AutomationRunWriter
  runPrecheck: () => Promise<AutomationPrecheckResult | null>
  canLaunchScheduledLocal?: () => boolean
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  watchRun: (run: AutomationRun) => void
}

function describeDispatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runHeadlessAutomationDispatch(
  ctx: HeadlessAutomationDispatchContext
): Promise<AutomationRun> {
  const { automation, run, target, runs } = ctx
  let precheckResult: AutomationPrecheckResult | null
  try {
    precheckResult =
      run.trigger === 'scheduled' && automation.precheck ? await ctx.runPrecheck() : null
  } catch (error) {
    if (!(error instanceof ScheduledLocalAutomationDeferredError)) {
      throw error
    }
    return runs.updateRun({
      runId: run.id,
      status: 'pending',
      workspaceId: automation.workspaceId,
      error: null
    })
  }
  if (run.trigger === 'scheduled' && ctx.canLaunchScheduledLocal?.() === false) {
    return runs.updateRun({
      runId: run.id,
      status: 'pending',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: null
    })
  }
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return runs.updateRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }
  let launch: HeadlessAutomationDispatchLaunch
  try {
    launch = await ctx.dispatcher({ automation, run, target })
  } catch (error) {
    if (error instanceof ScheduledLocalAutomationDeferredError) {
      return runs.updateRun({
        runId: run.id,
        status: 'pending',
        workspaceId: automation.workspaceId,
        precheckResult,
        error: null
      })
    }
    return runs.updateRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      error: describeDispatchError(error)
    })
  }
  const launchRunTarget = {
    workspaceId: launch.workspaceId,
    workspaceDisplayName: launch.workspaceDisplayName ?? null,
    terminalSessionId: launch.terminalSessionId,
    terminalPaneKey: launch.terminalPaneKey ?? null,
    terminalPtyId: launch.terminalPtyId ?? null
  }
  const updated = runs.updateRun({
    runId: run.id,
    status: 'dispatched',
    ...launchRunTarget,
    // Kept here: a watched run's completion is written without it.
    ...(precheckResult ? { precheckResult } : {}),
    error: null
  })
  // Observe the launched agent even while persistence is stalled or rejects its acknowledgement.
  if (!launch.completion) {
    ctx.watchRun({ ...run, ...launchRunTarget, status: 'dispatched', error: null })
  } else {
    void launch.completion
      .then(
        (completion) =>
          ctx.markDispatchResult({
            runId: run.id,
            status: completion.status,
            ...launchRunTarget,
            precheckResult,
            outputSnapshot: completion.outputSnapshot ?? null,
            error: completion.error ?? null
          }),
        (error) =>
          ctx.markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            error: describeDispatchError(error)
          })
      )
      .catch((error) => console.error('[automations] Failed to persist run completion:', error))
  }
  return updated
}
