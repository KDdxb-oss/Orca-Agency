// A replayed Codex turn in a git worktree saves its checkpoint ref at the turn's end, and the
// checkpoint holds exactly what the agent changed during the turn.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAgentTurnCheckpointDiff } from '../git/agent-turn-checkpoint'
import { openCodexReplay } from './structured-codex-replay-test-support'
import type { ProviderReplay } from './structured-provider-replay-test-support'

let replay: ProviderReplay | null = null
let workspace: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'orca-turn-checkpoint-workspace-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(workspace, 'README.md'), 'hello\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
})

afterEach(async () => {
  await replay?.dispose()
  replay = null
  rmSync(workspace, { recursive: true, force: true })
})

describe('structured turn checkpoints', () => {
  it("saves the turn's changes under refs/orca/checkpoints at the turn's end", async () => {
    // Already there when the turn starts: not the agent's.
    writeFileSync(join(workspace, 'before.txt'), 'the user\n')
    const opened = await openCodexReplay('codex-tool-call.ndjson', {
      workspace,
      turnCheckpoints: true
    })
    replay = opened
    let edited = false

    await opened.play({
      afterFrame: () => {
        if (edited || opened.dispatches() === 0) {
          return
        }
        edited = true
        // The provider's first frame after it took the turn: its start snapshot already exists.
        writeFileSync(join(workspace, 'agent.ts'), 'export const done = true\n')
      }
    })

    const refs = (): string => git('for-each-ref', '--format=%(refname)', 'refs/orca/checkpoints')
    await vi.waitFor(() => expect(refs()).toMatch(/^refs\/orca\/checkpoints\/[^/]+\/[^/]+$/))
    expect(edited).toBe(true)
    const diff = await readAgentTurnCheckpointDiff({ cwd: workspace, sessionId: opened.sessionId })
    expect(diff?.files).toEqual([{ path: 'agent.ts', added: 1, removed: 0 }])
    expect(diff?.rollbackable).toBe(true)
    // The user's own index and worktree are as they left them.
    expect(git('status', '--porcelain').split('\n').sort()).toEqual([
      '?? agent.ts',
      '?? before.txt'
    ])
  })

  it('saves nothing, and fails nothing, in a folder outside git', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-turn-checkpoint-folder-'))
    try {
      const opened = await openCodexReplay('codex-tool-call.ndjson', {
        workspace: folder,
        turnCheckpoints: true
      })
      replay = opened
      await opened.play()
      await expect(
        readAgentTurnCheckpointDiff({ cwd: folder, sessionId: opened.sessionId })
      ).resolves.toBeNull()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
