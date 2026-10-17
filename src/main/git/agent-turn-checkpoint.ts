// Per-turn git checkpoints for structured agent sessions: the worktree's files at a turn's start
// and end, saved as commits under `refs/orca/checkpoints/<session>/<turn>` so a turn's changes can
// be listed, diffed and rolled back. Pattern from T3 Code's CheckpointStore (MIT).
//
// A checkpoint never touches the user's index, working tree, HEAD or branches: it stages into a
// temporary index file (a copy of the real one, so stat data spares rehashing), then writes the
// tree and commit directly. The end commit's parent is the start commit, so `<ref>^..<ref>` is the
// turn; trailers record HEAD, the user's staged tree and whether the start was really seen.
// Plumbing only (add/write-tree/commit-tree/update-ref/diff), all Git 2.25-safe. Rollback lives
// in `agent-turn-checkpoint-rollback.ts`.

import { randomUUID } from 'node:crypto'
import { copyFile, rm, stat, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  AgentTurnCheckpointDiff,
  AgentTurnCheckpointFile,
  AgentTurnCheckpointListing
} from '../../shared/agent-turn-checkpoint-types'
import { gitExecFileAsync, isWslPath } from './runner'

export type { AgentTurnCheckpointDiff, AgentTurnCheckpointFile, AgentTurnCheckpointListing }

export const AGENT_TURN_CHECKPOINT_REF_ROOT = 'refs/orca/checkpoints'
/** Past these, a result lists the first files and says it was cut short. */
export const AGENT_TURN_CHECKPOINT_MAX_FILES = 500
export const AGENT_TURN_CHECKPOINT_MAX_PATCH_BYTES = 1024 * 1024

const HEAD_TRAILER = 'Orca-Head:'
const BASELINE_TRAILER = 'Orca-Baseline:'
const INDEX_TRAILER = 'Orca-Index:'
const ORDER_TRAILER = 'Orca-Order:'
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Orca',
  GIT_AUTHOR_EMAIL: 'orca-checkpoints@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Orca',
  GIT_COMMITTER_EMAIL: 'orca-checkpoints@users.noreply.github.com'
}
// fsmonitor and sparse rules would change what a private-index `add` sees.
const INDEX_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.sparseCheckout=false']

export async function agentTurnCheckpointGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, { cwd, ...(env ? { env } : {}) })
  return stdout
}
const git = agentTurnCheckpointGit

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim()
  } catch {
    return null
  }
}

/** The repository top level, or null for a folder that is not in a git repository. */
export async function agentTurnCheckpointRoot(cwd: string): Promise<string | null> {
  // shortcut: a WSL worktree gets no checkpoints, as a non-git folder; its git, files and private
  // index live in the distro, so supporting it means routing every step through the guest.
  if (isWslPath(cwd)) {
    return null
  }
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

/** Runs `run` against a private copy of the user's index, which it may rewrite freely. */
async function withIndexCopy<T>(
  root: string,
  run: (env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const indexPath = resolve(
    root,
    await git(root, ['rev-parse', '--git-path', 'index']).then((out) => out.trim())
  )
  const tempIndex = join(resolve(indexPath, '..'), `orca-checkpoint-index-${randomUUID()}`)
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
    return await run({ ...process.env, GIT_INDEX_FILE: tempIndex })
  } finally {
    await rm(tempIndex, { force: true })
    await rm(`${tempIndex}.lock`, { force: true })
  }
}

/** The worktree's files as a tree, staged through a private copy of the index. */
export async function snapshotAgentTurnWorktree(root: string): Promise<string> {
  return withIndexCopy(root, async (env) => {
    await git(root, [...INDEX_CONFIG, 'add', '-A', '--', '.'], env)
    return (await git(root, ['write-tree'], env)).trim()
  })
}

/** What the user has staged, as a tree; null while the index holds conflicts. */
export async function agentTurnCheckpointIndexTree(root: string): Promise<string | null> {
  return withIndexCopy(root, (env) => git(root, ['write-tree'], env)).then(
    (out) => out.trim(),
    () => null
  )
}

export async function agentTurnCheckpointHead(root: string): Promise<string | null> {
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

/** What a checkpoint commit recorded at the turn's end; `none` reads as null. */
export type AgentTurnCheckpointTrailers = {
  head: string | null
  /** The turn's verified start; null when it went unseen or failed, so the parent is HEAD. */
  baseline: string | null
  index: string | null
  order: number
}

export function parseAgentTurnCheckpointTrailers(message: string): AgentTurnCheckpointTrailers {
  const lines = message.split('\n')
  const value = (trailer: string): string | null => {
    const found = lines
      .find((line) => line.startsWith(trailer))
      ?.slice(trailer.length)
      .trim()
    return found && found !== 'none' ? found : null
  }
  return {
    head: value(HEAD_TRAILER),
    baseline: value(BASELINE_TRAILER),
    index: value(INDEX_TRAILER),
    order: Number(value(ORDER_TRAILER) ?? 0) || 0
  }
}

let lastOrder = 0
// Commit dates have one-second resolution; turns finishing within a second still list in order.
function nextOrder(): number {
  lastOrder = Math.max(Date.now(), lastOrder + 1)
  return lastOrder
}

/** The worktree as a turn found it; null outside a git repository. Pass it to the end capture. */
export async function captureAgentTurnBaseline(cwd: string): Promise<string | null> {
  const root = await agentTurnCheckpointRoot(cwd)
  if (!root) {
    return null
  }
  const head = await agentTurnCheckpointHead(root)
  return commitTree(root, await snapshotAgentTurnWorktree(root), head, 'orca turn start')
}

/** Saves the turn's end state under its ref; null outside a git repository. Without a baseline
 *  (the turn's start went unseen or its capture failed) the turn is measured from HEAD and marked
 *  so rollback refuses it: HEAD would count the user's earlier uncommitted work as the turn's. */
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
  const head = await agentTurnCheckpointHead(root)
  const parent = input.baseline ?? head
  // An unborn branch and no baseline leave nothing to measure the turn against.
  if (!parent) {
    return null
  }
  const tree = await snapshotAgentTurnWorktree(root)
  const message = [
    `orca turn ${input.turnId}`,
    '',
    `${HEAD_TRAILER} ${head ?? 'none'}`,
    `${BASELINE_TRAILER} ${input.baseline ?? 'none'}`,
    `${INDEX_TRAILER} ${(await agentTurnCheckpointIndexTree(root)) ?? 'none'}`,
    `${ORDER_TRAILER} ${nextOrder()}`
  ].join('\n')
  const commit = await commitTree(root, tree, parent, message)
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
  // A commit message never holds NUL, so each ref is three NUL-ended fields.
  const tokens = (
    await git(root, [
      'for-each-ref',
      '--sort=committerdate',
      '--format=%(refname)%00%(objectname)%00%(contents)%00',
      prefix
    ])
  ).split('\0')
  const entries: { order: number; listing: AgentTurnCheckpointListing }[] = []
  for (let index = 0; index + 2 < tokens.length; index += 3) {
    const ref = (tokens[index] ?? '').trimStart()
    const commit = tokens[index + 1]
    if (ref.startsWith(prefix) && commit) {
      const order = parseAgentTurnCheckpointTrailers(tokens[index + 2] ?? '').order
      entries.push({ order, listing: { turnId: ref.slice(prefix.length), ref, commit } })
    }
  }
  return entries.sort((a, b) => a.order - b.order).map((entry) => entry.listing)
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

export async function resolveAgentTurnCheckpointRef(
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
  const target = root
    ? await resolveAgentTurnCheckpointRef(root, input.sessionId, input.turnId)
    : null
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
    commit: (await git(root, ['rev-parse', target.ref])).trim(),
    rollbackable:
      parseAgentTurnCheckpointTrailers(await git(root, ['log', '-1', '--format=%B', target.ref]))
        .baseline !== null,
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
  const target = root
    ? await resolveAgentTurnCheckpointRef(root, input.sessionId, input.turnId)
    : null
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
