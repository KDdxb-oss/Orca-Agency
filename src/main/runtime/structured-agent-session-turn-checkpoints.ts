// Saves a git checkpoint at every structured-session turn's end (see `agent-turn-checkpoint.ts`).
// The turn's start is the session going working, which the status feed publishes from the pending
// send, before the provider has touched a file. A start this process never saw (a restart mid-turn)
// is measured from HEAD instead.

import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { captureAgentTurnBaseline, captureAgentTurnCheckpoint } from '../git/agent-turn-checkpoint'
import { agentSessionPinnedLaunchDirectory } from './agent-session-record-launch-directory'

/** The folder a session's agent works in: a floating chat's pin, else its workspace's path. */
export async function structuredAgentSessionDirectory(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<string | null> {
  const record = host.deps.store.getRecord(sessionId)
  if (!record) {
    return null
  }
  return (
    agentSessionPinnedLaunchDirectory(record) ??
    (await host.deps.resolveWorkspacePath?.(record.location.workspaceId)) ??
    null
  )
}

const installed = new WeakSet<StructuredAgentSessionHost>()

/** Once per host, for as long as it lives: the host's teardown drops its subscribers with it. */
export function installStructuredAgentTurnCheckpoints(
  host: StructuredAgentSessionHost,
  logger: StructuredAgentSessionLogger
): void {
  if (installed.has(host)) {
    return
  }
  installed.add(host)
  const working = new Set<string>()
  const baselines = new Map<string, Promise<string | null>>()
  // One git sequence per session at a time, so a turn's end never races its own start.
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

  host.subscribeStatus({
    id: 'turn-checkpoints',
    emit: (event) => {
      if (event.type === 'snapshot') {
        for (const session of event.sessions) {
          if (session.status === 'working') {
            working.add(session.sessionId)
          }
        }
        return
      }
      if (event.type !== 'status') {
        return
      }
      const { sessionId, status } = event.session
      if (status !== 'working') {
        working.delete(sessionId)
        return
      }
      if (working.has(sessionId)) {
        return
      }
      working.add(sessionId)
      baselines.set(
        sessionId,
        inLane(sessionId, async () => {
          const cwd = await structuredAgentSessionDirectory(host, sessionId)
          return cwd ? captureAgentTurnBaseline(cwd) : null
        }).catch((error: unknown) => failed(sessionId, error))
      )
    }
  })
  host.subscribeTurnCompletions({
    id: 'turn-checkpoints',
    emit: (event) => {
      if (event.type !== 'completion') {
        return
      }
      const { sessionId, turnId } = event.completion
      const baseline = baselines.get(sessionId) ?? Promise.resolve(null)
      baselines.delete(sessionId)
      void inLane(sessionId, async () => {
        const cwd = await structuredAgentSessionDirectory(host, sessionId)
        if (cwd) {
          await captureAgentTurnCheckpoint({ cwd, sessionId, turnId, baseline: await baseline })
        }
      }).catch((error: unknown) => failed(sessionId, error))
    }
  })
}
