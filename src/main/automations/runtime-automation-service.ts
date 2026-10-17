/**
 * The AutomationService a runtime host executes schedules with. Shared by Electron startup and
 * orcad so both hosts dispatch through the same headless path.
 */
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AutomationService } from './service'
import { isFinalAutomationRunStatus, type AutomationRun } from '../../shared/automations-types'
import { createHeadlessRunTerminalRetention } from './headless-run-terminal-retention'
import {
  getTuiAgentDetectCommands,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { buildHeadlessAutomationWorktreeCreateArgs } from './headless-workspace-create'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import { agentHookServer } from '../agent-hooks/server'
import {
  recordAutomationChatOwnership,
  recordAutomationProviderSessionOwnership
} from './chat-ownership'
import {
  lowerLocalAutomationProcessPriority,
  scheduleLocalAutomationPriorityFollowups
} from './local-automation-process-priority'
import { findReusableRunTerminal } from './headless-run-terminal-reuse'
import { ScheduledLocalAutomationDeferredError } from './local-schedule-gate'

const MAX_REMEMBERED_LAUNCHES = 256

export function createRuntimeAutomationService(input: {
  store: Store
  runtime: OrcaRuntimeService
  claudeUsage?: ClaudeUsageStore
  codexUsage?: CodexUsageStore
  /** A server process: it executes remote_host_service-owned schedules and dispatches headlessly. */
  headless: boolean
  /** Desktop runs can use background dispatch without claiming remote-host schedules. */
  dispatchHeadlessly?: boolean
  localScheduleReady?: () => boolean
}): AutomationService {
  const { store, runtime, claudeUsage, codexUsage } = input
  // The handle each headless launch returned, so its watcher never depends on a pane-key lookup.
  const launchedHandles = new Map<string, string>()
  const reusedPaneRuns = new Map<string, string>()
  const observer = createRuntimeAutomationRunTerminalObserver(runtime, {
    getAgentStatusRowsForPane: (paneKey) => runtime.getAgentStatusRowsForPane(paneKey),
    agentCommandsForRun: (run) =>
      automationAgentCommands(
        store.listAutomations().find((entry) => entry.id === run.automationId)?.agentId
      )
  })
  const service = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    terminalObserver: {
      ...observer,
      // This host's own launch handle first: it names the run's terminal without a lookup.
      resolveRunTerminal: (run) =>
        (run.terminalPaneKey ? launchedHandles.get(run.terminalPaneKey) : undefined) ??
        observer.resolveRunTerminal(run)
    },
    onAutomationsChanged: (payload) => runtime.notifyAutomationsChanged(payload),
    allowRemoteHostScheduling: input.headless,
    localScheduleReady: input.localScheduleReady,
    headlessDispatcher:
      input.headless || input.dispatchHeadlessly
        ? async ({ automation, run, target }) => {
            const requireLocalResources = (): void => {
              if (
                run.trigger === 'scheduled' &&
                automation.executionTargetType === 'local' &&
                input.localScheduleReady?.() === false
              ) {
                throw new ScheduledLocalAutomationDeferredError()
              }
            }
            requireLocalResources()
            let terminalHandle: string
            let terminalSessionId: string | null = null
            let terminalPaneKey: string | null = null
            let terminalPtyId: string | null = null
            let workspaceId: string
            let workspaceDisplayName: string | null = null
            if (automation.workspaceMode === 'new_per_run') {
              const created = await runtime.createManagedWorktree(
                buildHeadlessAutomationWorktreeCreateArgs({ automation, run, repo: target.repo })
              )
              terminalHandle = created.startupTerminal?.handle ?? ''
              terminalSessionId = created.startupTerminal?.tabId ?? null
              terminalPaneKey = created.startupTerminal?.paneKey ?? null
              terminalPtyId = created.startupTerminal?.ptyId ?? null
              workspaceId = created.worktree.id
              workspaceDisplayName = created.worktree.displayName ?? null
              if (!terminalHandle) {
                throw new Error(
                  created.warning ||
                    'Automation workspace was created, but no agent terminal started.'
                )
              }
            } else {
              if (!automation.workspaceId) {
                throw new Error('The target workspace is no longer available.')
              }
              const reusable = automation.reuseSession
                ? findReusableRunTerminal({
                    store,
                    runtime,
                    automation,
                    currentRun: run,
                    reusedPaneRuns
                  })
                : null
              if (reusable) {
                reusedPaneRuns.set(reusable.run.terminalPaneKey!, run.id)
                try {
                  const sent = await runtime.sendTerminalAgentPrompt(
                    reusable.handle,
                    automation.prompt,
                    { inputKind: 'driving', acceptQueued: true }
                  )
                  if (!sent.accepted) {
                    throw new Error('The reused automation session did not accept the prompt.')
                  }
                } catch (error) {
                  reusedPaneRuns.delete(reusable.run.terminalPaneKey!)
                  throw error
                }
                terminalHandle = reusable.handle
                terminalSessionId = reusable.run.terminalSessionId
                terminalPaneKey = reusable.run.terminalPaneKey
                terminalPtyId = reusable.run.terminalPtyId
                workspaceId = automation.workspaceId
                const worktree = await runtime.showManagedWorktree(`id:${workspaceId}`)
                workspaceDisplayName = worktree.displayName ?? null
              } else {
                const terminal = await runtime.launchAgentTerminal(`id:${automation.workspaceId}`, {
                  agent: automation.agentId,
                  prompt: automation.prompt,
                  title: run.title,
                  unlisted: true,
                  ...(automation.extraAgentArgs
                    ? { extraAgentArgs: automation.extraAgentArgs }
                    : {})
                })
                terminalHandle = terminal.handle
                terminalSessionId = terminal.tabId ?? null
                terminalPaneKey = terminal.paneKey ?? null
                terminalPtyId = terminal.ptyId ?? null
                workspaceId = terminal.worktreeId
                const worktree = await runtime.showManagedWorktree(`id:${workspaceId}`)
                workspaceDisplayName = worktree.displayName ?? null
              }
            }
            await lowerLocalAutomationProcessPriority(terminalPtyId)
            if (automation.executionTargetType === 'local' && terminalPtyId) {
              scheduleLocalAutomationPriorityFollowups(
                terminalPtyId,
                () => runtime.getTerminalPtyIdForHandle(terminalHandle) === terminalPtyId
              )
            }
            recordAutomationChatOwnership(
              store,
              { ...run, terminalSessionId, terminalPaneKey },
              agentHookServer.getProviderSessionIdentities()
            )
            if (terminalPaneKey) {
              launchedHandles.set(terminalPaneKey, terminalHandle)
              if (launchedHandles.size > MAX_REMEMBERED_LAUNCHES) {
                launchedHandles.delete(launchedHandles.keys().next().value ?? '')
              }
            }
            // No completion: the run's watcher observes it, retrying wait timeouts until it settles.
            return {
              workspaceId,
              workspaceDisplayName,
              terminalSessionId,
              terminalPaneKey,
              terminalPtyId
            }
          }
        : undefined
  })
  runtime.setAutomationService(service)
  if (input.headless || input.dispatchHeadlessly) {
    bindHeadlessRunTerminalRetention(service, store, runtime, reusedPaneRuns)
  }
  bindAutomationProviderOwnership(service, store)
  return service
}

function bindAutomationProviderOwnership(service: AutomationService, store: Store): void {
  let unsubscribe: (() => void) | null = null
  const start = service.start.bind(service)
  const stop = service.stop.bind(service)
  service.start = () => {
    start()
    unsubscribe ??= agentHookServer.subscribeProviderSessionChanges((providers) => {
      recordAutomationProviderSessionOwnership(store, providers)
    })
    recordAutomationProviderSessionOwnership(store, agentHookServer.getProviderSessionIdentities())
  }
  service.stop = () => {
    unsubscribe?.()
    unsubscribe = null
    stop()
  }
}

/** A headless host has no renderer to close finished run terminals; its service does it. */
function bindHeadlessRunTerminalRetention(
  service: AutomationService,
  store: Store,
  runtime: OrcaRuntimeService,
  reusedPaneRuns: ReadonlyMap<string, string>
): void {
  const retention = createHeadlessRunTerminalRetention({
    listRuns: () => store.listAutomationRuns(),
    terminalClaimedByAnotherRun: (run) => {
      const claimedBy = run.terminalPaneKey && reusedPaneRuns.get(run.terminalPaneKey)
      return Boolean(
        claimedBy &&
        claimedBy !== run.id &&
        store
          .listAutomationRuns(run.automationId)
          .some(
            (candidate) =>
              candidate.id === claimedBy && !isFinalAutomationRunStatus(candidate.status)
          )
      )
    },
    terminalClientUse: (run) =>
      run.terminalPtyId ? runtime.readTerminalClientUse(run.terminalPtyId) : 'unknown',
    runTerminalAlive: (run) => runOwnHandle(runtime, run) !== null,
    shellAloneAtPrompt: (run) =>
      run.terminalPtyId
        ? runtime.confirmTerminalShellAlone(run.terminalPtyId)
        : Promise.resolve(false),
    closeRunTerminal: async (run) => {
      // Only the run's own process: a restarted pane holds a new PTY a user may be working in.
      const handle = runOwnHandle(runtime, run)
      if (!handle) {
        return false
      }
      // The run's pane only: a pane a user split into the same tab is theirs.
      await runtime.closeTerminal(handle)
      return true
    },
    forgetRunTerminal: async (run) => {
      // A run still dispatched had its agent exit without a result, proven by its idle shell.
      const unfinished = run.status === 'dispatched'
      await service.markDispatchResult({
        runId: run.id,
        status: unfinished ? 'dispatch_failed' : run.status,
        error: unfinished
          ? (run.error ?? 'The agent exited without reporting completion.')
          : run.error,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null
      })
    }
  })
  service.releaseFinishedRunTerminals = () => retention.drain()
  const start = service.start.bind(service)
  const stop = service.stop.bind(service)
  service.start = () => {
    start()
    retention.start()
  }
  service.stop = () => {
    retention.stop()
    stop()
  }
}

function automationAgentCommands(agentId: string | undefined): string[] {
  if (!isTuiAgent(agentId)) {
    return []
  }
  const config = TUI_AGENT_CONFIG[agentId]
  return [...getTuiAgentDetectCommands(config), config.launchCmd]
}

/** The run's pane handle while that pane still holds the run's own PTY; null otherwise. */
function runOwnHandle(runtime: OrcaRuntimeService, run: AutomationRun): string | null {
  const handle = run.terminalPaneKey
    ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
    : null
  return handle &&
    run.terminalPtyId &&
    runtime.getTerminalPtyIdForHandle(handle) === run.terminalPtyId
    ? handle
    : null
}
