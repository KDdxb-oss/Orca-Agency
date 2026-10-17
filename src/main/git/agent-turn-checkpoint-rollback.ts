// Rolls a structured agent turn's files back to its checkpoint's start (see `agent-turn-checkpoint.ts`).
// Every check runs before the first write, so a refusal changes nothing.

import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentTurnCheckpointRollback } from '../../shared/agent-turn-checkpoint-types'
import {
  agentTurnCheckpointGit as git,
  agentTurnCheckpointHead,
  agentTurnCheckpointIndexTree,
  agentTurnCheckpointRoot,
  parseAgentTurnCheckpointTrailers,
  resolveAgentTurnCheckpointRef,
  snapshotAgentTurnWorktree
} from './agent-turn-checkpoint'

const RESTORE_BATCH = 200

const CHANGED_SINCE_TURN: AgentTurnCheckpointRollback = {
  ok: false,
  reason: 'changed-since-turn',
  message: 'Files changed after this turn ended. Commit or discard them, then roll back.'
}

/** Puts the worktree's files back to how the turn found them. Refuses, changing nothing, when the
 *  turn's start was never saved, anything changed after the turn ended (files, staged changes, or
 *  an ignored file where the turn deleted one), or the turn moved HEAD. */
export async function rollbackAgentTurnCheckpoint(input: {
  cwd: string
  sessionId: string
  turnId: string
}): Promise<AgentTurnCheckpointRollback> {
  const root = await agentTurnCheckpointRoot(input.cwd)
  const target = root
    ? await resolveAgentTurnCheckpointRef(root, input.sessionId, input.turnId)
    : null
  if (!root || !target) {
    return { ok: false, reason: 'no-checkpoint', message: 'This turn saved no checkpoint.' }
  }
  const recorded = parseAgentTurnCheckpointTrailers(
    await git(root, ['log', '-1', '--format=%B', target.ref])
  )
  if (!recorded.baseline) {
    return {
      ok: false,
      reason: 'no-baseline',
      message:
        "This turn's starting point wasn't saved, so its changes can't be told apart from earlier ones. Undo them with git instead."
    }
  }
  if (recorded.head !== (await agentTurnCheckpointHead(root))) {
    return {
      ok: false,
      reason: 'head-moved',
      message: 'The branch moved since this turn ended. Undo its commits with git instead.'
    }
  }
  const turnTree = (await git(root, ['rev-parse', `${target.ref}^{tree}`])).trim()
  // The snapshot restages the worktree over a copy of the index, so staged-only edits need their own check.
  const indexTree = await agentTurnCheckpointIndexTree(root)
  if (
    !recorded.index ||
    indexTree !== recorded.index ||
    (await snapshotAgentTurnWorktree(root)) !== turnTree
  ) {
    return CHANGED_SINCE_TURN
  }
  const changes = (
    await git(root, ['diff', '--name-status', '-z', '--no-renames', `${target.ref}^`, target.ref])
  ).split('\0')
  const restore: string[] = []
  const recreate: string[] = []
  const remove: string[] = []
  for (let index = 0; index + 1 < changes.length; index += 2) {
    const status = changes[index]
    const path = changes[index + 1]
    if (status && path) {
      ;(status === 'A' ? remove : restore).push(path)
      if (status === 'D') {
        recreate.push(path)
      }
    }
  }
  // An ignored file made where the turn deleted one never reaches the snapshot, yet restoring would overwrite it.
  for (const path of recreate) {
    if (
      await lstat(join(root, path)).then(
        () => true,
        () => false
      )
    ) {
      return CHANGED_SINCE_TURN
    }
  }
  // Worktree only: the user's index keeps whatever they staged. Batched to stay under argv limits
  // (--pathspec-from-file needs Git 2.26).
  for (let start = 0; start < restore.length; start += RESTORE_BATCH) {
    const batch = restore.slice(start, start + RESTORE_BATCH)
    await git(root, ['restore', `--source=${target.ref}^`, '--worktree', '--', ...batch])
  }
  for (const path of remove) {
    await rm(join(root, path), { force: true })
  }
  return { ok: true, restored: restore.length + remove.length }
}
