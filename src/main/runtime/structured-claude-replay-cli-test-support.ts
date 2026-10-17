// The Claude half of the provider replay's fake child: a stand-in CLI that answers the Agent SDK's
// control requests and, once Orca's user message arrives, writes the recorded stream-json frames.

import type { spawnProcess } from '../../shared/child-process/run-process'
import { replayChildSpawn, replayUntil } from './structured-provider-replay-child-test-support'

/** What the fake CLI answers each control request with; `{}` for any other subtype. */
const CONTROL_ANSWERS: Record<string, unknown> = {
  initialize: {
    commands: [],
    models: [
      { value: 'sonnet', displayName: 'Sonnet' },
      { value: 'opus', displayName: 'Opus' }
    ]
  },
  get_settings: { effective: { effortLevel: 'high' } }
}

/** Rewrites the recorded provider session id to the one this run launched, so the adapter's
 *  ownership check reads the frames as its own. */
function withSessionId(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => withSessionId(entry, from, to))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withSessionId(entry, from, to)])
    )
  }
  return value === from ? to : value
}

export type ClaudeReplayCli = {
  spawnImpl: typeof spawnProcess
  /** Call once per message the connection hands over; each frame waits for its own. */
  delivered: () => void
  /** User messages that reached the CLI's stdin. */
  dispatches: () => number
  /** Settles once every recorded frame has been handed over. */
  playing: () => Promise<void>
}

export function createClaudeReplayCli(input: {
  frames: readonly Record<string, unknown>[]
  providerSessionId: string
  prompt: string
  afterFrame: (index: number, total: number) => void | Promise<void>
}): ClaudeReplayCli {
  const { frames, providerSessionId, prompt } = input
  const recordedId = (key: string): string | undefined =>
    frames.map((frame) => frame[key]).find((id): id is string => typeof id === 'string')
  const recordedSessionId = recordedId('session_id')
  // The CLI replays Orca's own send back (--replay-user-messages); a recorder that sent
  // without it left no echo, and its command uuid was its own.
  const recordedCommand = recordedId('command_uuid')
  let dispatches = 0
  let delivered = 0
  let playing: Promise<void> = Promise.resolve()
  const spawnImpl = replayChildSpawn((frame, write) => {
    if (frame.type === 'control_request') {
      const request: unknown = frame.request
      const subtype =
        typeof request === 'object' && request !== null && 'subtype' in request
          ? String(request.subtype)
          : ''
      write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: frame.request_id,
          response: CONTROL_ANSWERS[subtype] ?? {}
        }
      })
      return
    }
    if (frame.type !== 'user' || ++dispatches > 1) {
      return
    }
    const sentUuid = String(frame.uuid)
    const echo = {
      type: 'user',
      parent_tool_use_id: null,
      session_id: providerSessionId,
      uuid: sentUuid,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] }
    }
    playing = (async () => {
      for (const [index, recorded] of [echo, ...frames].entries()) {
        let replayed: unknown = recordedSessionId
          ? withSessionId(recorded, recordedSessionId, providerSessionId)
          : recorded
        if (recordedCommand) {
          replayed = withSessionId(replayed, recordedCommand, sentUuid)
        }
        const target = delivered + 1
        write(replayed)
        await replayUntil(() => delivered >= target)
        await input.afterFrame(index, frames.length + 1)
      }
    })()
  })
  return {
    spawnImpl,
    delivered: () => {
      delivered += 1
    },
    dispatches: () => dispatches,
    playing: () => playing
  }
}
