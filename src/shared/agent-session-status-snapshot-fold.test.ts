import { expect, it } from 'vitest'
import type { AgentSessionStatusSummary } from './agent-session-wire'
import {
  admitAgentSessionStatusEvent,
  foldAgentSessionStatusEvent,
  revokeAgentSessionStatusLive
} from './agent-session-status-snapshot-fold'

const summary: AgentSessionStatusSummary = {
  sessionId: 'a',
  workspaceId: 'folder',
  agent: 'codex',
  status: 'idle',
  latestPrompt: 'Continue',
  updatedAt: 1
}

it.each(['queued', 'starting', 'continued', 'refused', 'unconfirmed', 'skipped'] as const)(
  'folds %s progress and revokes it on contact loss, even without a provider child',
  (phase) => {
    const snapshot = foldAgentSessionStatusEvent(new Map(), {
      type: 'snapshot',
      sessions: [{ ...summary, restartResume: { phase } }]
    })
    expect(snapshot.get('a')?.restartResume?.phase).toBe(phase)
    const disconnected = revokeAgentSessionStatusLive(snapshot)
    expect(disconnected.get('a')).toEqual(summary)
    expect(revokeAgentSessionStatusLive(disconnected)).toBe(disconnected)
  }
)

it('a clearing frame removes progress rather than merging the previous optional field', () => {
  const snapshot = new Map([['a', { ...summary, restartResume: { phase: 'continued' as const } }]])
  expect(
    foldAgentSessionStatusEvent(snapshot, { type: 'status', session: summary }).get('a')
  ).toEqual(summary)
})

it('admits only frames past the last one applied from the same feed epoch', () => {
  const at = (sequence: number, epoch = 'e1') => ({ epoch, sequence })
  const status = (sequence: number, epoch = 'e1') =>
    ({ type: 'status', session: summary, ...at(sequence, epoch) }) as const
  const opened = admitAgentSessionStatusEvent(null, {
    type: 'snapshot',
    sessions: [summary],
    ...at(4)
  })
  expect(opened).toEqual({ admitted: true, cursor: at(4) })
  expect(admitAgentSessionStatusEvent(opened.cursor, status(4)).admitted).toBe(false)
  expect(admitAgentSessionStatusEvent(opened.cursor, status(5))).toEqual({
    admitted: true,
    cursor: at(5)
  })
  // A reconnect's snapshot at the same position restores what losing contact revoked.
  expect(
    admitAgentSessionStatusEvent(at(5), { type: 'snapshot', sessions: [], ...at(5) }).admitted
  ).toBe(true)
  expect(
    admitAgentSessionStatusEvent(at(5), { type: 'snapshot', sessions: [], ...at(3) }).admitted
  ).toBe(false)
  // A restarted host counts from zero in a new epoch; an older host sends no position.
  expect(admitAgentSessionStatusEvent(at(5), status(1, 'e2'))).toEqual({
    admitted: true,
    cursor: at(1, 'e2')
  })
  expect(admitAgentSessionStatusEvent(at(5), { type: 'status', session: summary })).toEqual({
    admitted: true,
    cursor: at(5)
  })
})
