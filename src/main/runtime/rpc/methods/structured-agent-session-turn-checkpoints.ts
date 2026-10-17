// `agentSession.turnCheckpoint*` — a structured session's per-turn git checkpoints: which files a
// turn changed, each file's two sides, and rolling the worktree back to before the turn. Run on the
// execution host, where the session's worktree is. A folder outside git has none, never an error.

import {
  listAgentTurnCheckpoints,
  readAgentTurnCheckpointDiff,
  readAgentTurnCheckpointFile,
  rollbackAgentTurnCheckpoint
} from '../../../git/agent-turn-checkpoint'
import { structuredAgentSessionDirectory } from '../../structured-agent-session-turn-checkpoints'
import { OptionsParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import {
  TurnCheckpointDiffParams,
  TurnCheckpointFileParams,
  TurnCheckpointRollbackParams
} from '../../../../shared/rpc-contract/structured-agent-session-turn-checkpoint-params'
import { defineMethod, type RpcContext } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'

async function sessionDirectory(ctx: RpcContext, sessionId: string): Promise<string | null> {
  return structuredAgentSessionDirectory(
    await requireInstalledStructuredHost(ctx, sessionId),
    sessionId
  )
}

export const STRUCTURED_AGENT_SESSION_TURN_CHECKPOINT_METHODS = [
  defineMethod({
    name: 'agentSession.turnCheckpoints',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const cwd = await sessionDirectory(ctx, params.sessionId)
      return { checkpoints: cwd ? await listAgentTurnCheckpoints(cwd, params.sessionId) : [] }
    }
  }),
  defineMethod({
    name: 'agentSession.turnCheckpointDiff',
    permission: 'workspace',
    params: TurnCheckpointDiffParams,
    handler: async (params, ctx) => {
      const cwd = await sessionDirectory(ctx, params.sessionId)
      return { diff: cwd ? await readAgentTurnCheckpointDiff({ cwd, ...params }) : null }
    }
  }),
  defineMethod({
    name: 'agentSession.turnCheckpointFile',
    permission: 'workspace',
    params: TurnCheckpointFileParams,
    handler: async (params, ctx) => {
      const cwd = await sessionDirectory(ctx, params.sessionId)
      return { file: cwd ? await readAgentTurnCheckpointFile({ cwd, ...params }) : null }
    }
  }),
  defineMethod({
    name: 'agentSession.rollbackTurnCheckpoint',
    permission: 'workspace',
    params: TurnCheckpointRollbackParams,
    handler: async (params, ctx) => {
      const cwd = await sessionDirectory(ctx, params.sessionId)
      return cwd
        ? rollbackAgentTurnCheckpoint({ cwd, ...params })
        : {
            ok: false as const,
            reason: 'no-checkpoint' as const,
            message: 'This session has no folder to roll back.'
          }
    }
  })
]
