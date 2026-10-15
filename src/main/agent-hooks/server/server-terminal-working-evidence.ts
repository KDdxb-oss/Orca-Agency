import { createHash } from 'node:crypto'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { AGENT_WORKING_TITLE_REFRESH_AFTER_MS } from '../../../shared/agent-working-title-freshness'
import { isCancelledCodexStatus } from '../../../shared/codex-cancelled-status-recovery'
import { setCodexMainAgentTurnState } from '../../../shared/agent-hook-listener/providers/codex-state'
import { setClaudeMainAgentTurnState } from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import { INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS } from './server-constants'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerTerminalNativeIdle } from './server-terminal-native-idle'

type WorkingTitleEvidenceEvent = {
  ptyId?: string
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
  terminalHandle?: string
  payload: ParsedAgentStatusPayload
  observedTerminalHandle?: string
  confirmRestoredWorkingTitle?: true
  recoverCancelledWorkingTitle?: true
  recoverSettledWorkingTitle?: true
  settleNativeIdleTitle?: true
  restoredLaunchToken?: string
}

export abstract class AgentHookServerTerminalWorkingEvidence extends AgentHookServerTerminalNativeIdle {
  protected ingestWorkingTitleEvidence(
    event: WorkingTitleEvidenceEvent,
    paneKey: string,
    tabId: string | undefined,
    accepted: boolean
  ): void {
    if (event.settleNativeIdleTitle) {
      this.settleNativeIdleTitle({ ...event, paneKey, tabId })
      return
    }
    {
      const previous = this.state.lastStatusByPaneKey.get(paneKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      const confirmsRestored =
        event.confirmRestoredWorkingTitle === true &&
        previous?.restoredUnconfirmed === true &&
        (!previous.terminalHandle || previous.terminalHandle === event.terminalHandle) &&
        previous.payload.agentType === 'codex' &&
        (previous.connectionId ?? null) === null &&
        (event.connectionId ?? null) === null
      const recoversCancelled =
        event.recoverCancelledWorkingTitle === true &&
        previous &&
        isCancelledCodexStatus(previous.payload) &&
        !previous.restoredUnconfirmed &&
        (!previous.terminalHandle || previous.terminalHandle === event.terminalHandle) &&
        (previous.connectionId ?? null) === null &&
        (event.connectionId ?? null) === null &&
        Date.now() - previous.receivedAt > INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS
      const recoversSettled =
        event.recoverSettledWorkingTitle === true &&
        (previous?.payload.agentType === 'codex' || previous?.payload.agentType === 'claude') &&
        previous.payload.state === 'done' &&
        previous.payload.sessionBoundary !== true &&
        !previous.restoredUnconfirmed &&
        (!previous.terminalHandle || previous.terminalHandle === event.terminalHandle) &&
        (previous.connectionId ?? null) === null &&
        (event.connectionId ?? null) === null &&
        Date.now() - previous.receivedAt > INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS
      const recoversWorking = recoversCancelled || recoversSettled
      const savedLaunchTokenHash = previous?.restoredUnconfirmed
        ? (this.hydratedLaunchTokenHashByPaneKey.get(paneKey) ??
          this.persistedAuthorityCommitmentsByPaneKey.get(paneKey)?.launchTokenHash ??
          (previous.launchToken
            ? createHash('sha256').update(previous.launchToken.trim()).digest('hex')
            : undefined))
        : undefined
      const matchesSavedLaunch =
        !savedLaunchTokenHash ||
        (Boolean(event.restoredLaunchToken?.trim()) &&
          createHash('sha256').update(event.restoredLaunchToken!.trim()).digest('hex') ===
            savedLaunchTokenHash)
      // Only fresh same-terminal native output can confirm restored working state.
      if (
        !accepted ||
        !event.ptyId ||
        !event.terminalHandle ||
        !previous ||
        (previous.restoredUnconfirmed && !confirmsRestored) ||
        (confirmsRestored && Boolean(event.restoredLaunchToken?.trim()) && !matchesSavedLaunch) ||
        previous.providerSessionOnly ||
        previous.structuredHost ||
        event.payload.state !== 'working' ||
        (!recoversWorking && previous.payload.state !== 'working') ||
        (!recoversWorking &&
          previous.payload.mainAgent &&
          previous.payload.mainAgent.state !== 'working') ||
        !event.payload.agentType ||
        event.payload.agentType === 'unknown' ||
        previous.payload.agentType !== event.payload.agentType ||
        event.observedTerminalHandle !== event.terminalHandle ||
        (previous.terminalHandle && previous.terminalHandle !== event.terminalHandle) ||
        previous.tabId !== tabId ||
        previous.worktreeId !== event.worktreeId ||
        (previous.connectionId ?? null) !== (event.connectionId ?? null) ||
        (!confirmsRestored &&
          !recoversWorking &&
          Date.now() - (previous.evidenceObservedAt ?? previous.receivedAt) <=
            AGENT_WORKING_TITLE_REFRESH_AFTER_MS)
      ) {
        return
      }
      if (recoversWorking) {
        const startsNewTurn =
          previous.source !== undefined &&
          (previous.hookEventName === 'Stop' || previous.hookEventName === 'StopFailure') &&
          previous.payload.interrupted !== true &&
          previous.payload.mainAgent?.outcome !== 'cancellation'
        const turnStartedAt = startsNewTurn ? undefined : previous.turnStartedAt
        const stateStartedAt = startsNewTurn ? Date.now() : previous.stateStartedAt
        const setMainAgent =
          previous.payload.agentType === 'claude'
            ? setClaudeMainAgentTurnState
            : setCodexMainAgentTurnState
        const mainAgent = setMainAgent(this.state, paneKey, {
          state: 'working',
          stateStartedAt: turnStartedAt ?? stateStartedAt,
          model: previous.payload.model
        })
        // Why: correcting status is not a new prompt; preserve interaction clocks and resume identity.
        this.refreshTerminalStatusEvidence(
          {
            ...previous,
            turnStartedAt,
            stateStartedAt,
            source: undefined,
            hookEventName: undefined,
            payload: {
              state: 'working',
              agentType: previous.payload.agentType,
              prompt: startsNewTurn ? '' : previous.payload.prompt,
              model: previous.payload.model,
              subagents: previous.payload.subagents,
              mainAgent
            }
          },
          previous,
          true,
          'osc',
          event.terminalHandle
        )
        this.notifyStatusChangeListeners()
        return
      }
      this.refreshTerminalStatusEvidence(
        previous,
        undefined,
        true,
        confirmsRestored ? 'osc' : previous.observation?.origin,
        confirmsRestored ? event.terminalHandle : undefined,
        confirmsRestored && !(savedLaunchTokenHash && matchesSavedLaunch)
      )
    }
  }
}
