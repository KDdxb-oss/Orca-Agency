// Saves a git checkpoint for every structured-session turn (see `agent-turn-checkpoint.ts`). The
// turn's start is captured by the host's turn-dispatch barrier, so the provider gets the message
// only after the snapshot exists; a steer or an approval opens no turn and keeps the baseline. The
// end is captured on the turn's completion, in the same per-session lane, so the next turn's start
// waits for it. A start this process never saw (a restart mid-turn), failed to capture, or an end
// the next turn outwaited leaves the turn measured from HEAD and marked not rollbackable.

import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { captureAgentTurnBaseline, captureAgentTurnCheckpoint } from '../git/agent-turn-checkpoint'
import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'

/** How long a turn waits for its start snapshot before running without a verified one. */
export const STRUCTURED_TURN_BASELINE_WAIT_MS = 10_000

/** The folder a session's agent works in: a floating chat's pin, else its workspace's path. Null
 *  for an agent inside WSL, whose files only the distro sees (no checkpoints, as outside git). */
export async function structuredAgentSessionDirectory(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<string | null> {
  const record = host.deps.store.getRecord(sessionId)
  if (!record || record.location.wslDistro) {
    return null
  }
  return (
    agentSessionPinnedLaunchDirectory(record) ??
    (await host.deps.resolveWorkspacePath?.(record.location.workspaceId)) ??
    null
  )
}

type SessionCheckpoints = {
  /** The start of the turn the latest turn-opening send began; consumed by that turn's end. */
  baseline?: Promise<string | null>
  /** The latest turn this host saw complete, and when its checkpoint is written. `overlapped` is
   *  set when the next turn proceeded before that write, so it may hold the next turn's edits. */
  completed?: { turnId: string; saved: Promise<void>; overlapped: boolean }
}

const installed = new WeakMap<StructuredAgentSessionHost, Map<string, SessionCheckpoints>>()

/** Once per host, for as long as it lives: the host's teardown drops its subscribers with it. */
export function installStructuredAgentTurnCheckpoints(
  host: StructuredAgentSessionHost,
  logger: StructuredAgentSessionLogger
): void {
  // Test rigs stub the host installer and hand back no host.
  if (typeof host !== 'object' || host === null || installed.has(host)) {
    return
  }
  const sessions = new Map<string, SessionCheckpoints>()
  installed.set(host, sessions)
  const sessionState = (sessionId: string): SessionCheckpoints => {
    const existing = sessions.get(sessionId)
    if (existing) {
      return existing
    }
    const created: SessionCheckpoints = {}
    sessions.set(sessionId, created)
    return created
  }
  // One git sequence per session at a time, so a turn's end never races its own or the next start.
  const lanes = new Map<string, Promise<unknown>>()
  const inLane = <T>(sessionId: string, run: () => Promise<T>): Promise<T> => {
    const next = (lanes.get(sessionId) ?? Promise.resolve()).then(run, run)
    lanes.set(
      sessionId,
      next.catch(() => undefined)
    )
    return next
  }
  const failed = (sessionId: string, error: unknown): null => {
    logger.warn('turn checkpoint failed', { scope: 'turn-checkpoint', sessionId, error })
    return null
  }

  host.turnDispatchBarrier = async (sessionId) => {
    const state = sessionState(sessionId)
    // The feed holds a completion back while queued work remains, so that turn and this one end as
    // one completion: keep the earlier start and record them as one checkpoint.
    if (state.baseline) {
      return
    }
    const baseline = inLane(sessionId, async () => {
      const cwd = await structuredAgentSessionDirectory(host, sessionId)
      return cwd ? captureAgentTurnBaseline(cwd) : null
    }).catch((error: unknown) => failed(sessionId, error))
    state.baseline = baseline
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = await Promise.race([
      baseline.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), STRUCTURED_TURN_BASELINE_WAIT_MS)
      })
    ])
    clearTimeout(timer)
    // A start captured after the provider began may hold the agent's first edits, and a previous
    // end still being captured may hold them too.
    if (late) {
      if (state.completed) {
        state.completed.overlapped = true
      }
      if (state.baseline === baseline) {
        state.baseline = Promise.resolve(null)
      }
      failed(sessionId, new Error('turn start snapshot timed out'))
    }
  }
  host.subscribeTurnCompletions({
    id: 'turn-checkpoints',
    emit: (event) => {
      if (event.type !== 'completion') {
        return
      }
      const { sessionId, turnId } = event.completion
      const state = sessionState(sessionId)
      const baseline = state.baseline ?? Promise.resolve(null)
      state.baseline = undefined
      const completed = { turnId, saved: Promise.resolve(), overlapped: false }
      completed.saved = inLane(sessionId, async () => {
        const cwd = await structuredAgentSessionDirectory(host, sessionId)
        if (cwd) {
          await captureAgentTurnCheckpoint({
            cwd,
            sessionId,
            turnId,
            baseline: await baseline,
            overlapped: () => completed.overlapped
          })
        }
      }).catch((error: unknown) => {
        failed(sessionId, error)
      })
      state.completed = completed
    }
  })
}

/** The session's latest completed turn, once its checkpoint is written; undefined when this host
 *  saw none complete (it restarted since), so a reader falls back to the newest saved one. */
export async function settledStructuredAgentTurnCheckpoint(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<string | undefined> {
  const completed = installed.get(host)?.get(sessionId)?.completed
  if (!completed) {
    return undefined
  }
  await completed.saved
  return completed.turnId
}
