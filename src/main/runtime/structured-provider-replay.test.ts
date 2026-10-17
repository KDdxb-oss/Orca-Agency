// Recorded Claude and Codex sessions replayed through the shipped host, adapters and journal,
// asserting the agent status a sidebar row shows from the first prompt to the turn's end.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openClaudeReplay,
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

async function playToCompletion(opened: ProviderReplay): Promise<void> {
  replay = opened
  await opened.play()
  await vi.waitFor(() => expect(replayedAgentState(opened.statuses.at(-1)!)).toBe('done'))
}

describe.each([
  ['claude-tool-call.ndjson', openClaudeReplay, 'command output fixture complete'],
  ['codex-tool-call.ndjson', openCodexReplay, 'command output fixture complete'],
  ['codex-subagent.ndjson', openCodexReplay, 'Hello.']
] as const)('replaying %s', (fixture, open, finalMessage) => {
  it('works, then ends done with the final assistant message', async () => {
    await playToCompletion(await open(fixture))

    expect(replayedStateSequence(replay!.statuses)).toEqual(['working', 'done'])
    expect(replay!.statuses.at(-1)?.lastAssistantMessage).toBe(finalMessage)
  })
})

describe('replaying claude-subagent.ndjson', () => {
  it('works, then ends done with the root agent summary', async () => {
    await playToCompletion(await openClaudeReplay('claude-subagent.ndjson'))

    expect(replayedStateSequence(replay!.statuses)).toEqual(['working', 'done'])
    expect(replay!.statuses.at(-1)?.lastAssistantMessage).toMatch(
      /^Both subagents completed in parallel!/
    )
  })
})
