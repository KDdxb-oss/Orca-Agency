// A client's mirror of the host's status feed: the latest summary per session. The desktop and
// the phone fold the stream with these, so they agree on what a frame changes and on what losing
// contact takes away.

import type { AgentSessionStatusEvent, AgentSessionStatusSummary } from './agent-session-wire'

export type AgentSessionStatusSnapshot = ReadonlyMap<string, AgentSessionStatusSummary>

/** The mirror after one frame; `end` leaves it as it is. A snapshot merges over what is held: a
 *  restarted host restores its readable sessions asynchronously, so its first snapshot can be
 *  empty, and dropping those rows would flicker every one to no status. */
export function foldAgentSessionStatusEvent(
  snapshot: AgentSessionStatusSnapshot,
  event: AgentSessionStatusEvent
): AgentSessionStatusSnapshot {
  if (event.type === 'snapshot') {
    const next = new Map(snapshot)
    for (const session of event.sessions) {
      next.set(session.sessionId, session)
    }
    return next
  }
  if (event.type === 'status') {
    const next = new Map(snapshot)
    next.set(event.session.sessionId, event.session)
    return next
  }
  return snapshot
}

export type AgentSessionStatusFeedCursor = { epoch: string; sequence: number } | null

/** Whether a frame is newer than the last one applied from the same host feed, and the cursor
 *  after it. A snapshot at N restates everything up to N, so only frames past it apply: a frame
 *  delivered twice, or one the snapshot already covers, is dropped. A frame with no position (an
 *  older host) or from another epoch (a restarted host) always applies. */
export function admitAgentSessionStatusEvent(
  cursor: AgentSessionStatusFeedCursor,
  event: AgentSessionStatusEvent
): { admitted: boolean; cursor: AgentSessionStatusFeedCursor } {
  if (event.type === 'end' || event.epoch === undefined || event.sequence === undefined) {
    return { admitted: true, cursor }
  }
  const next = { epoch: event.epoch, sequence: event.sequence }
  if (cursor === null || cursor.epoch !== event.epoch) {
    return { admitted: true, cursor: next }
  }
  const admitted =
    event.type === 'snapshot' ? event.sequence >= cursor.sequence : event.sequence > cursor.sequence
  return admitted ? { admitted, cursor: next } : { admitted, cursor }
}

/** With contact lost, what only a live host vouches for goes: its execution, and a Stop it was
 *  ending. The rest is kept, since losing contact is never exit. `snapshot` itself if unchanged. */
export function revokeAgentSessionStatusLive(
  snapshot: AgentSessionStatusSnapshot
): AgentSessionStatusSnapshot {
  let next: Map<string, AgentSessionStatusSummary> | null = null
  for (const [sessionId, summary] of snapshot) {
    if (!summary.hostExecutionOwned && !summary.stopping && !summary.restartResume) {
      continue
    }
    next ??= new Map(snapshot)
    const {
      hostExecutionOwned: _owned,
      hostExecutionPhase: _phase,
      stopping: _stopping,
      restartResume: _restartResume,
      ...retained
    } = summary
    next.set(sessionId, retained)
  }
  return next ?? snapshot
}
