// Only the root run's completion marks an agent done. Replayed from recordings where a subagent
// finishes first: at that frame the subagent's own row reads done while the parent still reads
// working, and the parent reads done only once the root itself completes.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { HOST_TEST_LOCATION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  openClaudeReplay,
  readReplayTranscript,
  replayedAgentState,
  replayedStateSequence,
  type ProviderReplay
} from './structured-provider-replay-test-support'
import { openCodexReplay } from './structured-codex-replay-test-support'

let replay: ProviderReplay | null = null

afterEach(async () => {
  await replay?.dispose()
  replay = null
})

type Inbound = Record<string, unknown>

/** The 0-based index, among the frames a replay hands over, of the last child completion. */
function lastChildCompletion(
  fixture: string,
  isChildCompletion: (frame: Inbound, rootThreadId: string | undefined) => boolean,
  handedOver: (frame: Inbound) => boolean
): number {
  const frames = readReplayTranscript(fixture).flatMap((entry) =>
    entry.type === 'emit_inbound' && handedOver(entry.frame) ? [entry.frame] : []
  )
  const rootThreadId = (
    frames.find((frame) => frame.method === 'turn/started')?.params as
      | { threadId?: string }
      | undefined
  )?.threadId
  return frames.findLastIndex((frame) => isChildCompletion(frame, rootThreadId))
}

describe.each([
  [
    'claude-subagent.ndjson',
    openClaudeReplay,
    (frame: Inbound) => frame.subtype === 'task_notification' && frame.status === 'completed',
    // Claude's replay hands over every inbound frame, after Orca's own send echo at index 0.
    (_frame: Inbound) => true,
    1
  ],
  [
    'codex-subagent.ndjson',
    openCodexReplay,
    (frame: Inbound, root: string | undefined) =>
      frame.method === 'turn/completed' &&
      (frame.params as { threadId?: string }).threadId !== root,
    (frame: Inbound) => typeof frame.method === 'string',
    0
  ]
] as const)('replaying %s', (fixture, open, isChildCompletion, handedOver, offset) => {
  it('keeps the parent working when its subagent finishes, and done only at root completion', async () => {
    const childDoneAt = lastChildCompletion(fixture, isChildCompletion, handedOver) + offset
    expect(childDoneAt).toBeGreaterThanOrEqual(offset)
    const opened = await open(fixture)
    replay = opened
    let atChildCompletion: AgentSessionStatusSummary | undefined
    let childStates: string[] = []
    const subject = makeStructuredAgentStatusSubject(HOST_TEST_LOCATION, opened.sessionId)

    await opened.play({
      afterFrame: (index) => {
        if (index === childDoneAt) {
          atChildCompletion = opened.statuses.at(-1)
          childStates = opened.statusStore
            .getStructuredChildWorkViews(subject)
            .map((child) => child.state)
        }
      }
    })
    await vi.waitFor(() => expect(replayedAgentState(opened.statuses.at(-1)!)).toBe('done'))

    expect(atChildCompletion && replayedAgentState(atChildCompletion)).toBe('working')
    // The children's own rows read done, in the store the sidebar's child rows come from.
    expect(childStates.length).toBeGreaterThan(0)
    expect(childStates.every((state) => state === 'done')).toBe(true)
    // Never done before the end: a subagent's finish did not close the turn early.
    expect(replayedStateSequence(opened.statuses)).toEqual(['working', 'done'])
  })
})
