// A renderer that reloads mid-run resumes from the host's snapshot sequence: replayed through the
// shipped host, its folded status ends equal to an uninterrupted subscriber's, with every
// duplicated or already-covered frame dropped. A retried send is one effect.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../shared/agent-session-wire'
import {
  admitAgentSessionStatusEvent,
  foldAgentSessionStatusEvent,
  type AgentSessionStatusFeedCursor,
  type AgentSessionStatusSnapshot
} from '../../shared/agent-session-status-snapshot-fold'
import {
  openClaudeReplay,
  replayedAgentState,
  type ProviderReplay
} from './structured-provider-replay-test-support'
import { openCodexReplay } from './structured-codex-replay-test-support'

let replay: ProviderReplay | null = null

afterEach(async () => {
  await replay?.dispose()
  replay = null
})

/** A renderer's mirror: frames admitted by feed position, then folded. */
function mirror() {
  let snapshot: AgentSessionStatusSnapshot = new Map()
  let cursor: AgentSessionStatusFeedCursor = null
  let admitted = 0
  return {
    apply: (event: AgentSessionStatusEvent): void => {
      const admission = admitAgentSessionStatusEvent(cursor, event)
      cursor = admission.cursor
      if (admission.admitted) {
        admitted += event.type === 'status' ? 1 : 0
        snapshot = foldAgentSessionStatusEvent(snapshot, event)
      }
    },
    read: (sessionId: string) => snapshot.get(sessionId),
    admitted: () => admitted
  }
}

describe.each([
  ['claude-tool-call.ndjson', openClaudeReplay],
  ['codex-tool-call.ndjson', openCodexReplay]
] as const)('a renderer reloading mid-%s', (fixture, open) => {
  it('ends with the same status as one that never left, and no frame applied twice', async () => {
    const opened = await open(fixture)
    replay = opened
    const uninterrupted = mirror()
    opened.host.subscribeStatus({ id: 'uninterrupted', emit: uninterrupted.apply })
    const reloaded = mirror()
    const reloadedFrames: AgentSessionStatusEvent[] = []
    let subscribed = false

    await opened.play({
      afterFrame: (index, total) => {
        if (subscribed || index < Math.floor(total / 2)) {
          return
        }
        subscribed = true
        opened.host.subscribeStatus({
          id: 'reloaded',
          emit: (event) => {
            reloadedFrames.push(event)
            // A transport that redelivers: every frame twice.
            reloaded.apply(event)
            reloaded.apply(event)
          }
        })
      }
    })
    await vi.waitFor(() =>
      expect(replayedAgentState(uninterrupted.read(opened.sessionId)!)).toBe('done')
    )

    expect(subscribed).toBe(true)
    expect(reloadedFrames[0]?.type).toBe('snapshot')
    // The resumed mirror saw the run's middle, not just its end.
    expect(reloadedFrames.filter((event) => event.type === 'status').length).toBeGreaterThan(0)
    expect(reloaded.read(opened.sessionId)).toEqual(uninterrupted.read(opened.sessionId))
    // Each status frame applied once; a snapshot restating the same position may re-apply, since
    // a reconnect's snapshot is what restores what losing contact revoked.
    expect(reloaded.admitted()).toBe(reloadedFrames.filter((e) => e.type === 'status').length)

    // The snapshot a slow reconnect could deliver late, behind newer frames, changes nothing.
    const before = reloaded.read(opened.sessionId)
    reloaded.apply(reloadedFrames[0]!)
    expect(reloaded.read(opened.sessionId)).toBe(before)
  })

  it('takes a retried send as one effect', async () => {
    const opened = await open(fixture)
    replay = opened
    await opened.play()

    await expect(opened.resend()).resolves.toBe(true)
    expect(opened.dispatches()).toBe(1)
  })
})
