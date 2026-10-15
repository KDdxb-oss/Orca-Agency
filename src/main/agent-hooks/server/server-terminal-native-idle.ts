import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  resolveClaudePaneStatus,
  setClaudeMainAgentTurnState
} from '../../../shared/agent-hook-listener/providers/claude-roster-state'
import { setCodexMainAgentTurnState } from '../../../shared/agent-hook-listener/providers/codex-state'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerTerminalNativeIdle extends AgentHookServerIngestNormalization {
  protected settleNativeIdleTitle(event: {
    ptyId?: string
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId?: string | null
    terminalHandle?: string
    observedTerminalHandle?: string
    payload: ParsedAgentStatusPayload
  }): void {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The server's canonical row map contains statuses enriched at its sole publication boundary.
    const previous = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const agent = previous?.payload.agentType
    if (
      this.getAgentStatusDisposition(paneKey) !== 'accept' ||
      !event.ptyId ||
      !event.terminalHandle ||
      event.observedTerminalHandle !== event.terminalHandle ||
      !previous ||
      previous.restoredUnconfirmed ||
      previous.providerSessionOnly ||
      previous.structuredHost ||
      (agent !== 'claude' && agent !== 'codex') ||
      event.payload.agentType !== agent ||
      event.payload.state !== 'done' ||
      previous.payload.state !== 'working' ||
      previous.payload.mainAgent?.state !== 'working' ||
      previous.payload.workingMode !== undefined ||
      previous.payload.subagents?.some((child) => child.state !== 'idle') ||
      (agent !== 'claude' && this.state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)) ||
      this.state.claudeActiveSessionCronPaneKeys.has(paneKey) ||
      previous.tabId !== event.tabId ||
      previous.worktreeId !== event.worktreeId ||
      (previous.connectionId ?? null) !== null ||
      (event.connectionId ?? null) !== null ||
      (previous.terminalHandle && previous.terminalHandle !== event.terminalHandle)
    ) {
      return
    }
    const mainAgent =
      agent === 'claude'
        ? setClaudeMainAgentTurnState(this.state, paneKey, { state: 'done' })
        : setCodexMainAgentTurnState(this.state, paneKey, { state: 'done' })
    // Native idle ends only the lead's turn. Keep positively reported shell work alive.
    const resolved =
      agent === 'claude'
        ? resolveClaudePaneStatus(this.state, paneKey, mainAgent)
        : { stateName: 'done' as const, workingMode: undefined }
    // Native idle repairs display state without inventing a prompt or a success verdict.
    this.refreshTerminalStatusEvidence(
      {
        ...previous,
        source: undefined,
        hookEventName: undefined,
        payload: {
          ...previous.payload,
          state: resolved.stateName,
          workingMode: resolved.workingMode,
          mainAgent
        }
      },
      previous,
      true,
      'osc',
      event.terminalHandle
    )
    this.notifyStatusChangeListeners()
  }
}
