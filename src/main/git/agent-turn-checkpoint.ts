// Per-turn git checkpoints for structured agent sessions: the worktree's files at a turn's start
// and end, saved as commits under `refs/orca/checkpoints/<session>/<turn>` so a turn's changes can
// be listed, diffed and rolled back. Pattern from T3 Code's CheckpointStore (MIT).
//
// A checkpoint never touches the user's index, working tree, HEAD or branches: it stages into a
// temporary index file (a copy of the real one, so stat data spares rehashing), then writes the
// tree and commit directly. The end commit's parent is the start commit, so `<ref>^..<ref>` is the
// turn. Plumbing only (read-tree/add/write-tree/commit-tree/update-ref/diff), all Git 2.25-safe.

import { randomUUID } from 'node:crypto'
import { copyFile, rm, stat, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  AgentTurnCheckpointDiff,
  AgentTurnCheckpointFile,
  AgentTurnCheckpointListing,
  AgentTurnCheckpointRollback
} from '../../shared/agent-turn-checkpoint-types'
import { gitExecFileAsync } from './runner'

export type {
  AgentTurnCheckpointDiff,
  AgentTurnCheckpointFile,
  AgentTurnCheckpointListing,
  AgentTurnCheckpointRollback
}

export const AGENT_TURN_CHECKPOINT_REF_ROOT = 'refs/orca/checkpoints'
/** Past these, a result lists the first files and says it was cut short. */
export const AGENT_TURN_CHECKPOINT_MAX_FILES = 500
export const AGENT_TURN_CHECKPOINT_MAX_PATCH_BYTES = 1024 * 1024

const HEAD_TRAILER = 'Orca-Head:'
const RESTORE_BATCH = 200
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Orca',
  GIT_AUTHOR_EMAIL: 'orca-checkpoints@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Orca',
  GIT_COMMITTER_EMAIL: 'orca-checkpoints@users.noreply.github.com'
}
// fsmonitor and sparse rules would change what a private-index `add` sees.
const INDEX_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.sparseCheckout=false']

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, { cwd, ...(env ? { env } : {}) })
  return stdout
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim()
  } catch {
    return null
  }
}

/** The repository top level, or null for a folder that is not in a git repository. */
export async function agentTurnCheckpointRoot(cwd: string): Promise<string | null> {
  return gitOrNull(cwd, ['rev-parse', '--show-toplevel'])
}

/** A ref component git accepts for any provider's session or turn id. */
function refSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+|\.lock$/g, '_')
  return cleaned.length > 0 ? cleaned : '_'
}

export function agentTurnCheckpointRef(sessionId: string, turnId: string): string {
  return `${AGENT_TURN_CHECKPOINT_REF_ROOT}/${refSegment(sessionId)}/${refSegment(turnId)}`
}

/** The worktree's files as a tree, staged through a private copy of the index. */
async function snapshotTree(root: string): Promise<string> {
  const indexPath = resolve(
    root,
    await git(root, ['rev-parse', '--git-path', 'index']).then((out) => out.trim())
  )
  const tempIndex = join(resolve(indexPath, '..'), `orca-checkpoint-index-${randomUUID()}`)
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex }
  try {
    const source = await stat(indexPath).catch(() => null)
    // No index yet (a fresh repository) stages from empty.
    if (source) {
      await copyFile(indexPath, tempIndex)
      // Git trusts an entry's stat data only when the file is older than the index; a copy's fresh
      // mtime would make a same-size edit from the index's own second read as unchanged.
      const seconds = Math.floor((source.mtimeMs - 1) / 1000)
      await utimes(tempIndex, source.atime, seconds)
    }
    await git(root, [...INDEX_CONFIG, 'add', '-A', '--', '.'], env)
    return (await git(root, ['write-tree'], env)).trim()
  } finally {
    await rm(tempIndex, { force: true })
    await rm(`${tempIndex}.lock`, { force: true })
  }
}

async function headCommit(root: string): Promise<string | null> {
  return gitOrNull(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
}

async function commitTree(
  root: string,
  tree: string,
  parent: string | null,
  message: string
): Promise<string> {
  const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]
  return (await git(root, args, { ...process.env, ...COMMIT_IDENTITY })).trim()
}

/** The worktree as a turn found it; null outside a git repository. Pass it to the end capture. */
export async function captureAgentTurnBaseline(cwd: string): Promise<string | null> {
  const root = await agentTurnCheckpointRoot(cwd)
  if (!root) {
    return null
  }
  const head = await headCommit(root)
  return commitTree(root, await snapshotTree(root), head, 'orca turn start')
}

/** Saves the turn's end state under its ref; null outside a git repository. Without a baseline
 *  (the turn's start went unseen) the turn is measured from HEAD. */
export async function captureAgentTurnCheckpoint(input: {
  cwd: string
  sessionId: string
  turnId: string
  baseline: string | null
}): Promise<string | null> {
  const root = await agentTurnCheckpointRoot(input.cwd)
  if (!root) {
    return null
  }
  const head = await headCommit(root)
  const parent = input.baseline ?? head
  const message = `orca turn ${input.turnId}\n\n${HEAD_TRAILER} ${head ?? 'none'}`
  const commit = await commitTree(root, await snapshotTree(root), parent, message)
  await git(root, ['update-ref', agentTurnCheckpointRef(input.sessionId, input.turnId), commit])
  return commit
}

/** The session's checkpoints, oldest first; empty outside a git repository. */
export async function listAgentTurnCheckpoints(
  cwd: string,
  sessionId: string
): Promise<AgentTurnCheckpointListing[]> {
  const root = await agentTurnCheckpointRoot(cwd)
  if (!root) {
    return []
  }
  const prefix = `${AGENT_TURN_CHECKPOINT_REF_ROOT}/${refSegment(sessionId)}/`
  const out = await git(root, [
    'for-each-ref',
    '--sort=committerdate',
    '--format=%(refname)%00%(objectname)',
    prefix
  ])
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [ref, commit] = line.split('\0')
      return ref && commit ? [{ turnId: ref.slice(prefix.length), ref, commit }] : []
    })
}

/** `git diff --numstat -z` records: `a\tb\tpath\0`, or `a\tb\t\0old\0new\0` for a rename. */
export function parseNumstatZ(out: string): AgentTurnCheckpointFile[] {
  const tokens = out.split('\0')
  const files: AgentTurnCheckpointFile[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) {
      continue
    }
    const [added = '', removed = '', path = ''] = token.split('\t')
    const counts = {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed)
    }
    if (path.length > 0) {
      files.push({ path, ...counts })
      continue
    }
    const oldPath = tokens[index + 1]
    const newPath = tokens[index + 2]
    index += 2
    if (oldPath && newPath) {
      files.push({ path: newPath, oldPath, ...counts })
    }
  }
  return files
}

async function resolveTurnRef(
  root: string,
  sessionId: string,
  turnId: string | undefined
): Promise<{ turnId: string; ref: string } | null> {
  if (turnId !== undefined) {
    const ref = agentTurnCheckpointRef(sessionId, turnId)
    return (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', ref]))
      ? { turnId, ref }
      : null
  }
  const latest = (await listAgentTurnCheckpoints(root, sessionId)).at(-1)
  return latest ? { turnId: latest.turnId, ref: latest.ref } : null
}

/** One turn's changed files with line counts, the latest turn when none is named; null when the
 *  folder is not a git repository or the turn saved no checkpoint. */
export async function readAgentTurnCheckpointDiff(input: {
  cwd: string
  sessionId: string
  turnId?: string
}): Promise<AgentTurnCheckpointDiff | null> {
  const root = await agentTurnCheckpointRoot(input.cwd)
  const target = root ? await resolveTurnRef(root, input.sessionId, input.turnId) : null
  if (!root || !target) {
    return null
  }
  const range = [`${target.ref}^`, target.ref]
  const all = parseNumstatZ(await git(root, ['diff', '--numstat', '-z', '-M', ...range]))
  let oversized = false
  if (all.length <= AGENT_TURN_CHECKPOINT_MAX_FILES) {
    try {
      await gitExecFileAsync(['diff', '--no-color', '--no-ext-diff', ...range], {
        cwd: root,
        maxBuffer: AGENT_TURN_CHECKPOINT_MAX_PATCH_BYTES
      })
    } catch {
      // The numstat over the same range just succeeded, so this read failed on its size cap.
      oversized = true
    }
  }
  return {
    sessionId: input.sessionId,
    turnId: target.turnId,
    ref: target.ref,
    files: all.slice(0, AGENT_TURN_CHECKPOINT_MAX_FILES),
    fileCount: all.length,
    added: all.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: all.reduce((sum, file) => sum + (file.removed ?? 0), 0),
    truncated: oversized || all.length > AGENT_TURN_CHECKPOINT_MAX_FILES
  }
}

/** A file's content before and after the turn; empty when it did not exist on that side. */
export async function readAgentTurnCheckpointFile(input: {
  cwd: string
  sessionId: string
  turnId: string
  path: string
  oldPath?: string
}): Promise<{ original: string; modified: string } | null> {
  const root = await agentTurnCheckpointRoot(input.cwd)
  const target = root ? await resolveTurnRef(root, input.sessionId, input.turnId) : null
  if (!root || !target) {
    return null
  }
  // Untrimmed: a file's trailing newline is part of its diff.
  const show = (spec: string): Promise<string> => git(root, ['show', spec]).catch(() => '')
  return {
    original: await show(`${target.ref}^:${input.oldPath ?? input.path}`),
    modified: await show(`${target.ref}:${input.path}`)
  }
}

/** Puts the worktree's files back to how the turn found them. Refuses, changing nothing, when
 *  anything changed after the turn ended or the turn moved HEAD: those are the user's to keep. */
export async function rollbackAgentTurnCheckpoint(input: {
  cwd: string
  sessionId: string
  turnId: string
}): Promise<AgentTurnCheckpointRollback> {
  const root = await agentTurnCheckpointRoot(input.cwd)
  const target = root ? await resolveTurnRef(root, input.sessionId, input.turnId) : null
  if (!root || !target) {
    return { ok: false, reason: 'no-checkpoint', message: 'This turn saved no checkpoint.' }
  }
  const recordedHead = (await git(root, ['log', '-1', '--format=%B', target.ref]))
    .split('\n')
    .find((line) => line.startsWith(HEAD_TRAILER))
    ?.slice(HEAD_TRAILER.length)
    .trim()
  if (recordedHead !== ((await headCommit(root)) ?? 'none')) {
    return {
      ok: false,
      reason: 'head-moved',
      message: 'The branch moved since this turn ended. Undo its commits with git instead.'
    }
  }
  const turnTree = (await git(root, ['rev-parse', `${target.ref}^{tree}`])).trim()
  if ((await snapshotTree(root)) !== turnTree) {
    return {
      ok: false,
      reason: 'changed-since-turn',
      message: 'Files changed after this turn ended. Commit or discard them, then roll back.'
    }
  }
  const changes = (
    await git(root, ['diff', '--name-status', '-z', '--no-renames', `${target.ref}^`, target.ref])
  ).split('\0')
  const restore: string[] = []
  const remove: string[] = []
  for (let index = 0; index + 1 < changes.length; index += 2) {
    const status = changes[index]
    const path = changes[index + 1]
    if (status && path) {
      ;(status === 'A' ? remove : restore).push(path)
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
