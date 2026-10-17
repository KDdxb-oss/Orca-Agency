// The checkpoint installer against a host that exposes only its barrier and completion feed: each
// turn's start is captured before the turn proceeds, kept until that turn ends, and its end read
// by the Result once written.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionTurnCompletionSubscriber } from '../native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { readAgentTurnCheckpointDiff } from '../git/agent-turn-checkpoint'
import {
  installStructuredAgentTurnCheckpoints,
  settledStructuredAgentTurnCheckpoint,
  STRUCTURED_TURN_BASELINE_WAIT_MS
} from './structured-agent-session-turn-checkpoints'

const SESSION = 'session-1'
let workspace: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'orca-turn-checkpoint-lifecycle-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(workspace, 'README.md'), 'hello\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(workspace, { recursive: true, force: true })
})

function fakeHost(
  resolveWorkspacePath: () => Promise<string> = async () => workspace,
  options: { wslDistro?: string } = {}
) {
  const completions: StructuredAgentSessionTurnCompletionSubscriber[] = []
  const barrier: { turnDispatchBarrier: ((sessionId: string) => Promise<void>) | null } = {
    turnDispatchBarrier: null
  }
  const shape = Object.assign(barrier, {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          sessionId === SESSION
            ? { location: { workspaceId: 'workspace-1', wslDistro: options.wslDistro ?? null } }
            : null
      },
      resolveWorkspacePath
    },
    subscribeTurnCompletions: (subscriber: StructuredAgentSessionTurnCompletionSubscriber) => {
      completions.push(subscriber)
      return () => {}
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer and its readers touch only these members.
  const host = shape as unknown as StructuredAgentSessionHost
  installStructuredAgentTurnCheckpoints(host, createStructuredAgentSessionLogger())
  return {
    host,
    /** The host about to hand a turn-opening send to the provider. */
    startTurn: async () => shape.turnDispatchBarrier?.(SESSION),
    completeTurn: (turnId: string) => {
      for (const subscriber of completions) {
        subscriber.emit({
          type: 'completion',
          completion: {
            scope: {
              executionHostId: 'local',
              wslDistro: null,
              workspaceId: 'workspace-1',
              workspaceKind: 'git-worktree'
            },
            sessionId: SESSION,
            turnId,
            outcome: 'success',
            completedAt: Date.now()
          }
        })
      }
    }
  }
}

const changedPaths = async (turnId: string): Promise<string[] | undefined> =>
  (await readAgentTurnCheckpointDiff({ cwd: workspace, sessionId: SESSION, turnId }))?.files.map(
    (file) => file.path
  )

describe('structured turn checkpoint lifecycle', () => {
  it('captures the start before the turn proceeds, so an immediate edit is the turn’s', async () => {
    writeFileSync(join(workspace, 'before.txt'), 'the user\n')
    const host = fakeHost()
    await host.startTurn()
    writeFileSync(join(workspace, 'agent.ts'), 'first edit\n')
    host.completeTurn('turn-1')

    await expect(settledStructuredAgentTurnCheckpoint(host.host, SESSION)).resolves.toBe('turn-1')
    await expect(changedPaths('turn-1')).resolves.toEqual(['agent.ts'])
  })

  it('keeps consecutive turns apart: the next start waits for the previous end', async () => {
    const host = fakeHost()
    await host.startTurn()
    writeFileSync(join(workspace, 'one.txt'), '1\n')
    host.completeTurn('turn-1')
    // Not awaited between: the next turn's start queues behind turn-1's end capture.
    await host.startTurn()
    writeFileSync(join(workspace, 'two.txt'), '2\n')
    host.completeTurn('turn-2')

    await expect(settledStructuredAgentTurnCheckpoint(host.host, SESSION)).resolves.toBe('turn-2')
    await expect(changedPaths('turn-1')).resolves.toEqual(['one.txt'])
    await expect(changedPaths('turn-2')).resolves.toEqual(['two.txt'])
  })

  it('keeps one baseline across a pause: edits before and after an approval are one turn', async () => {
    const host = fakeHost()
    await host.startTurn()
    writeFileSync(join(workspace, 'before-approval.txt'), 'a\n')
    // An approval or question goes attention → working without a new turn-opening send.
    writeFileSync(join(workspace, 'after-approval.txt'), 'b\n')
    host.completeTurn('turn-1')

    await settledStructuredAgentTurnCheckpoint(host.host, SESSION)
    await expect(changedPaths('turn-1')).resolves.toEqual([
      'after-approval.txt',
      'before-approval.txt'
    ])
  })

  it('reads the turn that just completed even before its checkpoint is written', async () => {
    const host = fakeHost()
    await host.startTurn()
    writeFileSync(join(workspace, 'one.txt'), '1\n')
    host.completeTurn('turn-1')
    await settledStructuredAgentTurnCheckpoint(host.host, SESSION)
    await host.startTurn()
    writeFileSync(join(workspace, 'two.txt'), '2\n')
    host.completeTurn('turn-2')

    // Asked in the same tick as the completion: answers turn-2 once written, never turn-1.
    const turnId = await settledStructuredAgentTurnCheckpoint(host.host, SESSION)
    expect(turnId).toBe('turn-2')
    await expect(
      readAgentTurnCheckpointDiff({ cwd: workspace, sessionId: SESSION, turnId })
    ).resolves.toMatchObject({ turnId: 'turn-2', rollbackable: true })
  })

  it('marks a turn not rollbackable when its start snapshot is too slow to wait for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let releaseFolder: () => void = () => {}
    const slowFolder = new Promise<void>((resolve) => {
      releaseFolder = resolve
    })
    let calls = 0
    const host = fakeHost(async () => {
      calls += 1
      if (calls === 1) {
        await slowFolder
      }
      return workspace
    })
    const started = host.startTurn()
    await vi.advanceTimersByTimeAsync(STRUCTURED_TURN_BASELINE_WAIT_MS)
    await started
    writeFileSync(join(workspace, 'agent.ts'), 'edit\n')
    releaseFolder()
    vi.useRealTimers()
    host.completeTurn('turn-1')

    await settledStructuredAgentTurnCheckpoint(host.host, SESSION)
    await expect(
      readAgentTurnCheckpointDiff({ cwd: workspace, sessionId: SESSION, turnId: 'turn-1' })
    ).resolves.toMatchObject({ rollbackable: false })
  })

  it('marks the previous turn not rollbackable when the next one outwaits its end capture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let releaseFolder: () => void = () => {}
    const slowFolder = new Promise<void>((resolve) => {
      releaseFolder = resolve
    })
    let calls = 0
    const host = fakeHost(async () => {
      calls += 1
      // Call 2 is turn-1's end capture.
      if (calls === 2) {
        await slowFolder
      }
      return workspace
    })
    await host.startTurn()
    writeFileSync(join(workspace, 'one.txt'), '1\n')
    host.completeTurn('turn-1')
    const started = host.startTurn()
    await vi.advanceTimersByTimeAsync(STRUCTURED_TURN_BASELINE_WAIT_MS)
    await started
    // Turn 2 edits while turn-1's end is still unwritten, so that end holds this edit too.
    writeFileSync(join(workspace, 'two.txt'), '2\n')
    releaseFolder()
    vi.useRealTimers()

    await settledStructuredAgentTurnCheckpoint(host.host, SESSION)
    await expect(
      readAgentTurnCheckpointDiff({ cwd: workspace, sessionId: SESSION, turnId: 'turn-1' })
    ).resolves.toMatchObject({ rollbackable: false })
  })

  it('records turns the feed completes as one (queued sends) as one checkpoint from the first start', async () => {
    const host = fakeHost()
    await host.startTurn()
    writeFileSync(join(workspace, 'one.txt'), '1\n')
    // Turn 1 settles with a queued send, so the feed emits no completion for it.
    await host.startTurn()
    writeFileSync(join(workspace, 'two.txt'), '2\n')
    host.completeTurn('turn-2')

    await settledStructuredAgentTurnCheckpoint(host.host, SESSION)
    expect(git('for-each-ref', '--format=%(refname)', 'refs/orca').split('\n')).toHaveLength(1)
    await expect(
      readAgentTurnCheckpointDiff({ cwd: workspace, sessionId: SESSION, turnId: 'turn-2' })
    ).resolves.toMatchObject({
      rollbackable: true,
      files: [
        expect.objectContaining({ path: 'one.txt' }),
        expect.objectContaining({ path: 'two.txt' })
      ]
    })
  })

  it('saves nothing for a session whose agent runs inside WSL', async () => {
    const host = fakeHost(async () => workspace, { wslDistro: 'Ubuntu' })
    await host.startTurn()
    writeFileSync(join(workspace, 'agent.ts'), 'edit\n')
    host.completeTurn('turn-1')

    await settledStructuredAgentTurnCheckpoint(host.host, SESSION)
    expect(git('for-each-ref', 'refs/orca')).toBe('')
  })

  it('answers no turn when this host saw none complete', async () => {
    const host = fakeHost()
    await expect(settledStructuredAgentTurnCheckpoint(host.host, SESSION)).resolves.toBeUndefined()
  })

  it('ignores a stubbed installer that returns no host', () => {
    expect(() =>
      installStructuredAgentTurnCheckpoints(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the case under test is exactly a missing host.
        undefined as unknown as StructuredAgentSessionHost,
        createStructuredAgentSessionLogger()
      )
    ).not.toThrow()
  })
})
