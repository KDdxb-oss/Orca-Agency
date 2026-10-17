// `agentSession.turnCheckpoint*` — a structured session's per-turn git checkpoints: which files a
// turn changed, each file's two sides, and rolling the worktree back to before the turn. Run on the
// execution host, where the session's worktree is. A folder outside git has none, never an error.
// A diff with no turn named is the turn this host last saw complete, read once its capture is done.

import {
  listAgentTurnCheckpoints,
  readAgentTurnCheckpointDiff,
  readAgentTurnCheckpointFile
} from '../../../git/agent-turn-checkpoint'
import { rollbackAgentTurnCheckpoint } from '../../../git/agent-turn-checkpoint-rollback'
import {
  settledStructuredAgentTurnCheckpoint,
  structuredAgentSessionDirectory
} from '../../structured-agent-session-turn-checkpoints'
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
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      const cwd = await structuredAgentSessionDirectory(host, params.sessionId)
      if (!cwd) {
        return { diff: null }
      }
      // A turn that just completed may still be writing its checkpoint; with no turn named, read
      // that turn by id, never whichever older one is newest so far.
      const completed = await settledStructuredAgentTurnCheckpoint(host, params.sessionId)
      const turnId = params.turnId ?? completed
      return {
        diff: await readAgentTurnCheckpointDiff({ cwd, ...params, ...(turnId ? { turnId } : {}) })
      }
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
