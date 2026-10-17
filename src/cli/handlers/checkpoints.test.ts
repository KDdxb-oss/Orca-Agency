import { describe, expect, it } from 'vitest'
import type { AgentTurnCheckpointDiff } from '../../shared/agent-turn-checkpoint-types'
import { formatDiff } from './checkpoints'

const diff: AgentTurnCheckpointDiff = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  ref: 'refs/orca/checkpoints/session-1/turn-1',
  commit: 'abc123',
  files: [{ path: 'a.ts', added: 1, removed: 0 }],
  fileCount: 1,
  added: 1,
  removed: 0,
  truncated: false
}

describe('checkpoint diff format', () => {
  it('says the start was not saved only when the host says so', () => {
    expect(formatDiff({ diff: { ...diff, rollbackable: false } })).toContain('start not saved')
    expect(formatDiff({ diff: { ...diff, rollbackable: true } })).not.toContain('start not saved')
    // An older host omits the field: unknown, not a missing start.
    expect(formatDiff({ diff })).not.toContain('start not saved')
  })
})
