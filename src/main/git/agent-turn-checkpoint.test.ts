import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_TURN_CHECKPOINT_MAX_FILES,
  captureAgentTurnBaseline,
  captureAgentTurnCheckpoint,
  listAgentTurnCheckpoints,
  parseNumstatZ,
  readAgentTurnCheckpointDiff,
  readAgentTurnCheckpointFile,
  rollbackAgentTurnCheckpoint
} from './agent-turn-checkpoint'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-turn-checkpoint-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'gone.txt'), 'bye\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

/** Runs one agent turn: baseline, the edits, then the end checkpoint. */
async function turn(turnId: string, edit: () => void): Promise<string | null> {
  const baseline = await captureAgentTurnBaseline(repo)
  edit()
  return captureAgentTurnCheckpoint({ cwd: repo, sessionId: 'session-1', turnId, baseline })
}

describe('agent turn checkpoints', () => {
  it("saves a ref per turn without touching the user's index, worktree or HEAD", async () => {
    // A user edit staged before the turn, and one left unstaged.
    writeFileSync(join(repo, 'kept.txt'), 'one\ntwo\nstaged\n')
    git('add', 'kept.txt')
    writeFileSync(join(repo, 'notes.txt'), 'mine\n')
    const statusBefore = git('status', '--porcelain')
    const headBefore = git('rev-parse', 'HEAD')
    const indexBefore = statSync(join(repo, '.git', 'index')).mtimeMs

    const commit = await turn('turn-1', () => writeFileSync(join(repo, 'new.ts'), 'a\nb\n'))

    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    expect(git('for-each-ref', '--format=%(refname)', 'refs/orca/checkpoints')).toBe(
      'refs/orca/checkpoints/session-1/turn-1'
    )
    expect(git('rev-parse', 'HEAD')).toBe(headBefore)
    expect(statSync(join(repo, '.git', 'index')).mtimeMs).toBe(indexBefore)
    expect(git('status', '--porcelain').split('\n').sort()).toEqual(
      [...statusBefore.split('\n'), '?? new.ts'].sort()
    )
  })

  it("diffs only what the turn changed, with line counts, and each file's two sides", async () => {
    writeFileSync(join(repo, 'notes.txt'), 'the user wrote this before the turn\n')
    await turn('turn-1', () => {
      writeFileSync(join(repo, 'kept.txt'), 'one\nTWO\nthree\n')
      rmSync(join(repo, 'gone.txt'))
      writeFileSync(join(repo, 'new.ts'), 'a\nb\n')
    })

    const diff = await readAgentTurnCheckpointDiff({ cwd: repo, sessionId: 'session-1' })

    expect(diff).toMatchObject({ turnId: 'turn-1', fileCount: 3, truncated: false })
    expect(diff?.files).toEqual(
      expect.arrayContaining([
        { path: 'kept.txt', added: 2, removed: 1 },
        { path: 'gone.txt', added: 0, removed: 1 },
        { path: 'new.ts', added: 2, removed: 0 }
      ])
    )
    expect(diff).toMatchObject({ added: 4, removed: 2 })
    await expect(
      readAgentTurnCheckpointFile({
        cwd: repo,
        sessionId: 'session-1',
        turnId: 'turn-1',
        path: 'kept.txt'
      })
    ).resolves.toEqual({ original: 'one\ntwo\n', modified: 'one\nTWO\nthree\n' })
  })

  it('lists turns oldest first and diffs the latest by default', async () => {
    await turn('turn-1', () => writeFileSync(join(repo, 'a.txt'), 'a\n'))
    await turn('turn-2', () => writeFileSync(join(repo, 'b.txt'), 'b\n'))

    const listed = await listAgentTurnCheckpoints(repo, 'session-1')
    expect(listed.map((entry) => entry.turnId)).toEqual(['turn-1', 'turn-2'])
    const latest = await readAgentTurnCheckpointDiff({ cwd: repo, sessionId: 'session-1' })
    expect(latest?.files.map((file) => file.path)).toEqual(['b.txt'])
  })

  it('caps a huge turn at the file limit and says so', async () => {
    await turn('turn-big', () => {
      for (let index = 0; index <= AGENT_TURN_CHECKPOINT_MAX_FILES; index += 1) {
        writeFileSync(join(repo, `f${index}.txt`), `${index}\n`)
      }
    })
    const diff = await readAgentTurnCheckpointDiff({ cwd: repo, sessionId: 'session-1' })
    expect(diff).toMatchObject({
      fileCount: AGENT_TURN_CHECKPOINT_MAX_FILES + 1,
      truncated: true
    })
    expect(diff?.files).toHaveLength(AGENT_TURN_CHECKPOINT_MAX_FILES)
  })

  it("rolls the turn's files back and leaves the user's earlier edits alone", async () => {
    writeFileSync(join(repo, 'notes.txt'), 'mine\n')
    await turn('turn-1', () => {
      writeFileSync(join(repo, 'kept.txt'), 'changed\n')
      rmSync(join(repo, 'gone.txt'))
      writeFileSync(join(repo, 'new.ts'), 'a\n')
    })

    await expect(
      rollbackAgentTurnCheckpoint({ cwd: repo, sessionId: 'session-1', turnId: 'turn-1' })
    ).resolves.toEqual({ ok: true, restored: 3 })

    expect(readFileSync(join(repo, 'kept.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(readFileSync(join(repo, 'gone.txt'), 'utf8')).toBe('bye\n')
    expect(existsSync(join(repo, 'new.ts'))).toBe(false)
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('mine\n')
  })

  it('refuses a rollback when files changed after the turn, changing nothing', async () => {
    await turn('turn-1', () => writeFileSync(join(repo, 'kept.txt'), 'agent\n'))
    writeFileSync(join(repo, 'kept.txt'), 'agent\nthen the user\n')

    await expect(
      rollbackAgentTurnCheckpoint({ cwd: repo, sessionId: 'session-1', turnId: 'turn-1' })
    ).resolves.toMatchObject({ ok: false, reason: 'changed-since-turn' })
    expect(readFileSync(join(repo, 'kept.txt'), 'utf8')).toBe('agent\nthen the user\n')
  })

  it('refuses a rollback when the branch moved since the turn', async () => {
    await turn('turn-1', () => writeFileSync(join(repo, 'kept.txt'), 'agent\n'))
    git('commit', '-q', '-am', 'user commit')

    await expect(
      rollbackAgentTurnCheckpoint({ cwd: repo, sessionId: 'session-1', turnId: 'turn-1' })
    ).resolves.toMatchObject({ ok: false, reason: 'head-moved' })
  })

  it('does nothing and reports nothing outside a git repository', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-turn-checkpoint-folder-'))
    try {
      await expect(captureAgentTurnBaseline(folder)).resolves.toBeNull()
      await expect(
        captureAgentTurnCheckpoint({ cwd: folder, sessionId: 's', turnId: 't', baseline: null })
      ).resolves.toBeNull()
      await expect(readAgentTurnCheckpointDiff({ cwd: folder, sessionId: 's' })).resolves.toBeNull()
      await expect(listAgentTurnCheckpoints(folder, 's')).resolves.toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('parses renames and binary files from numstat -z', () => {
    expect(parseNumstatZ('1\t2\ta.txt\x00-\t-\timg.png\x003\t0\t\x00old.ts\x00new.ts\x00')).toEqual(
      [
        { path: 'a.txt', added: 1, removed: 2 },
        { path: 'img.png', added: null, removed: null },
        { path: 'new.ts', oldPath: 'old.ts', added: 3, removed: 0 }
      ]
    )
  })
})
