import type { AgentMainAgentStatus, AgentStatusState } from './agent-status-types'

/** A cancellation is provisional when the same Codex process continues emitting native Working. */
export function isCancelledCodexStatus(row: {
  agentType?: string
  state: AgentStatusState
  interrupted?: boolean
  mainAgent?: AgentMainAgentStatus
}): boolean {
  return (
    row.agentType === 'codex' &&
    row.state === 'done' &&
    (row.mainAgent ? row.mainAgent.outcome === 'cancellation' : row.interrupted === true)
  )
}
