import { z } from 'zod'
import { OptionsParams } from './structured-agent-session-params'

/** A turn's git checkpoint (`agentSession.turnCheckpoint*`): the latest turn when none is named. */
const CheckpointTurnId = z.string().min(1).max(512)
export const TurnCheckpointDiffParams = OptionsParams.extend({
  turnId: CheckpointTurnId.optional()
}).strict()
export const TurnCheckpointFileParams = OptionsParams.extend({
  turnId: CheckpointTurnId,
  path: z.string().min(1).max(4096),
  oldPath: z.string().min(1).max(4096).optional()
}).strict()
export const TurnCheckpointRollbackParams = OptionsParams.extend({
  turnId: CheckpointTurnId
}).strict()
