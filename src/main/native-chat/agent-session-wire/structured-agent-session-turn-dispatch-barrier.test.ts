// The turn-dispatch barrier runs before a send that opens a turn reaches the provider, holds that
// send until it settles, and never runs for a steer into a running turn.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

async function runningTurn(turnId: string, clientMessageId: string): Promise<void> {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 },
    {
      kind: 'turn',
      turnId,
      state: 'running',
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(clientMessageId)
    },
    {
      fence: rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

describe('turn dispatch barrier', () => {
  it('holds a turn-opening send until it settles, and skips a steer', async () => {
    rig = await createQueuedMessageTestRig()
    let release: () => void = () => {}
    const barrier = vi.fn(
      (_sessionId: string) =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    rig.host.turnDispatchBarrier = barrier

    // Handed over (its pending row written), then held at the barrier.
    const id = await rig.workingSend()
    await eventually(() => expect(barrier).toHaveBeenCalledWith(HOST_TEST_SESSION))
    // Give the held dispatch every chance to slip past.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rig.dispatch).not.toHaveBeenCalled()
    release()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))

    await rig.settleAccepted(id, 'sent')
    await runningTurn('turn-1', id)
    const steer = rig.send('and this too')
    await steer.result
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
    expect(barrier).toHaveBeenCalledTimes(1)
  })

  it('sends anyway when the barrier fails', async () => {
    rig = await createQueuedMessageTestRig()
    rig.host.turnDispatchBarrier = async () => {
      throw new Error('snapshot broke')
    }
    await rig.workingSend()
    await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  })
})
