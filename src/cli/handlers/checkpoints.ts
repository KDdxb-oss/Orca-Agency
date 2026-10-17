import type {
  AgentTurnCheckpointDiff,
  AgentTurnCheckpointListing,
  AgentTurnCheckpointRollback
} from '../../shared/agent-turn-checkpoint-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'

function count(value: number | null): string {
  return value === null ? 'bin' : String(value)
}

function formatDiff({ diff }: { diff: AgentTurnCheckpointDiff | null }): string {
  if (!diff) {
    return 'No checkpoint for that turn.'
  }
  return [
    `turn: ${diff.turnId}`,
    `files: ${diff.fileCount} (+${diff.added} -${diff.removed})${diff.truncated ? ' (truncated)' : ''}`,
    ...(diff.rollbackable ? [] : ['start not saved: measured from HEAD, rollback unavailable']),
    ...diff.files.map(
      (file) =>
        `+${count(file.added)} -${count(file.removed)}\t${file.oldPath ? `${file.oldPath} -> ` : ''}${file.path}`
    )
  ].join('\n')
}

export const CHECKPOINT_HANDLERS: Record<string, CommandHandler> = {
  'checkpoint list': async ({ client, flags, json }) => {
    const result = await client.call<{ checkpoints: AgentTurnCheckpointListing[] }>(
      'agentSession.turnCheckpoints',
      { sessionId: getRequiredStringFlag(flags, 'session') }
    )
    printResult(result, json, ({ checkpoints }) =>
      checkpoints.length > 0
        ? checkpoints.map((entry) => `${entry.turnId}\t${entry.commit}`).join('\n')
        : 'No checkpoints.'
    )
  },
  'checkpoint diff': async ({ client, flags, json }) => {
    const turnId = getOptionalStringFlag(flags, 'turn')
    const result = await client.call<{ diff: AgentTurnCheckpointDiff | null }>(
      'agentSession.turnCheckpointDiff',
      { sessionId: getRequiredStringFlag(flags, 'session'), ...(turnId ? { turnId } : {}) }
    )
    printResult(result, json, formatDiff)
  },
  'checkpoint rollback': async ({ client, flags, json }) => {
    const result = await client.call<AgentTurnCheckpointRollback>(
      'agentSession.rollbackTurnCheckpoint',
      {
        sessionId: getRequiredStringFlag(flags, 'session'),
        turnId: getRequiredStringFlag(flags, 'turn')
      }
    )
    printResult(result, json, (rollback) =>
      rollback.ok ? `Restored ${rollback.restored} files.` : `Refused: ${rollback.message}`
    )
  }
}
