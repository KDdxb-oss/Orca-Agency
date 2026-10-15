import type { ChatSidebarSettings } from '../../../../shared/chat-sidebar-settings'
import type { ChatSidebarRow } from './chat-sidebar-types'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  chatLiveSessionSnapshot,
  chatSessionSnapshot,
  freshestChatSnapshot,
  sameChatSessionSnapshot
} from './chat-sidebar-session-snapshot'
import { refreshedChatCompletion } from './chat-sidebar-completion'
export { isChatCompleted, chatCompletionEdit } from './chat-sidebar-completion'

type RowIds = Pick<ChatSidebarRow, 'id' | 'aliases'>

/** Resident tabs beat historical copies; then a working copy; then the newest. */
export function outranksChatRow(row: ChatSidebarRow, previous: ChatSidebarRow): boolean {
  const resident = Number(Boolean(row.tabId)) - Number(Boolean(previous.tabId))
  const working = Number(row.state === 'working') - Number(previous.state === 'working')
  return (resident || working || row.timestamp - previous.timestamp) > 0
}

function storedKey(values: Record<string, unknown>, row: RowIds): string | undefined {
  return [...row.aliases, row.id].find((id) => Object.hasOwn(values, id))
}

/** Pending instance edits take precedence until they migrate to the provider session. */
export function chatPreference<T>(
  values: Record<string, T> | undefined,
  row: RowIds
): T | undefined {
  if (!values) {
    return undefined
  }
  const key = storedKey(values, row)
  return key === undefined ? undefined : values[key]
}

function scannedClaudeSessionKey(hostId: string, sessionId: string, filePath: string): string {
  return JSON.stringify([hostId, sessionId, normalizeRuntimePathForComparison(filePath)])
}

function moveAliases<T>(values: Record<string, T>, row: RowIds, target: string): boolean {
  let changed = false
  for (const alias of row.aliases) {
    if (!Object.hasOwn(values, alias)) {
      continue
    }
    if (!Object.hasOwn(values, target)) {
      values[target] = values[alias]
    } else if (JSON.stringify(values[target]) !== JSON.stringify(values[alias])) {
      // Why: a briefly missing resident row must not erase either copy's explicit edits.
      continue
    }
    delete values[alias]
    changed = true
  }
  return changed
}

/** Persists what rows learned since the last write: session registry, identity moves and title-only turns. */
export function chatSidebarPreferencePatch(
  rows: readonly ChatSidebarRow[],
  current: ChatSidebarSettings,
  now: number,
  /** Background recording without history: only rows that can snapshot themselves. */
  options: { liveOnly?: boolean; scannedSessions?: readonly AiVaultSession[] } = {}
): Partial<ChatSidebarSettings> | null {
  const sessions = { ...current.sessions }
  const recordedSessions = new Set<string>()
  const titles = { ...current.titles }
  const completed = { ...current.completed }
  const folderAssignments = { ...current.folderAssignments }
  const workspaceFolderAssignments = { ...current.workspaceFolderAssignments }
  let foldersChanged = false
  let workspaceFoldersChanged = false
  let titlesChanged = false
  let completedChanged = false
  const automationChats = new Set(current.automationChats ?? [])
  let automationChanged = false
  const hidden = new Set(current.hidden ?? [])
  let hiddenChanged = false
  const ordered = [...rows].sort(
    (a, b) => Number(a.id !== a.sessionKey) - Number(b.id !== b.sessionKey)
  )
  const scannedClaude = new Map<string, AiVaultSession>()
  for (const session of options.scannedSessions ?? []) {
    if (session.agent === 'claude') {
      scannedClaude.set(
        scannedClaudeSessionKey(session.executionHostId, session.sessionId, session.filePath),
        session
      )
    }
  }
  for (const [key, stored] of Object.entries(sessions)) {
    const proof = stored.resumeLauncher
    const snapshot = stored.snapshot
    const scanned =
      snapshot?.agent === 'claude'
        ? scannedClaude.get(
            scannedClaudeSessionKey(snapshot.executionHostId, snapshot.sessionId, snapshot.filePath)
          )
        : undefined
    if (scanned && snapshot && snapshot.isHeadless !== scanned.isHeadless) {
      const updatedSnapshot = { ...snapshot }
      if (scanned.isHeadless === true) {
        updatedSnapshot.isHeadless = true
      } else {
        delete updatedSnapshot.isHeadless
      }
      sessions[key] = { ...stored, snapshot: updatedSnapshot }
    }
    if (
      !proof ||
      !snapshot ||
      proof.agent !== 'claude' ||
      typeof proof.sessionId !== 'string' ||
      typeof proof.transcriptPath !== 'string'
    ) {
      continue
    }
    const scannedLauncher = scannedClaude.get(
      scannedClaudeSessionKey(snapshot.executionHostId, proof.sessionId, proof.transcriptPath)
    )
    if (
      scannedLauncher &&
      (isAiVaultSessionResumableContent(scannedLauncher) ||
        scannedLauncher.resumedSessionIdPrefix !== proof.targetSessionIdPrefix)
    ) {
      sessions[key] = { ...sessions[key], resumeLauncher: undefined }
    }
  }
  // A launcher that now has its own conversation, or points to a different background
  // target, revokes the earlier proof before a later no-scan close or cold restore.
  for (const row of ordered) {
    if (!row.tabId || !row.paneKey) {
      continue
    }
    for (const [key, stored] of Object.entries(sessions)) {
      const proof = stored.resumeLauncher
      if (
        !proof ||
        proof.tabId !== row.tabId ||
        proof.paneKey !== row.paneKey ||
        stored.worktreeId !== row.worktree.id ||
        key === row.sessionKey
      ) {
        continue
      }
      const sourceHasConversation =
        row.session?.agent === 'claude' &&
        row.session.sessionId === proof.sessionId &&
        normalizeRuntimePathForComparison(row.session.filePath) ===
          normalizeRuntimePathForComparison(proof.transcriptPath) &&
        isAiVaultSessionResumableContent(row.session)
      const newerProof = row.resumeLauncher?.sessionId === proof.sessionId
      if (sourceHasConversation || newerProof) {
        sessions[key] = { ...stored, resumeLauncher: undefined }
      }
    }
  }
  for (const row of ordered) {
    if (row.tabId && !row.automated) {
      for (const id of [row.id, ...row.aliases, ...(row.sessionKey ? [row.sessionKey] : [])]) {
        hiddenChanged = hidden.delete(id) || hiddenChanged
      }
    }
    // Older closed chats may only have their workspace's folder; retain it on the chat now.
    if (!row.tabId && row.folderWorktree && !chatPreference(folderAssignments, row)) {
      folderAssignments[row.id] = {
        worktreeId: row.folderWorktree.id,
        executionHostId: row.hostId
      }
      foldersChanged = true
    }
    if (row.tabId && row.folderWorktree) {
      const workspaceKey = JSON.stringify([row.hostId, row.worktree.id])
      const assigned = workspaceFolderAssignments[workspaceKey] ?? {
        worktreeId: row.folderWorktree.id,
        executionHostId: row.hostId
      }
      if (
        assigned.worktreeId === row.folderWorktree.id &&
        JSON.stringify(folderAssignments[row.id]) !== JSON.stringify(assigned)
      ) {
        folderAssignments[row.id] = assigned
        foldersChanged = true
      }
      if (!workspaceFolderAssignments[workspaceKey]) {
        workspaceFolderAssignments[workspaceKey] = {
          worktreeId: row.folderWorktree.id,
          executionHostId: row.hostId
        }
        workspaceFoldersChanged = true
      }
    }
    if (row.automated) {
      for (const id of [row.id, ...row.aliases]) {
        if (!automationChats.has(id)) {
          automationChats.add(id)
          automationChanged = true
        }
      }
    }
    if (options.liveOnly && !chatLiveSessionSnapshot(row, now)) {
      continue
    }
    if (row.sessionKey) {
      const stored = sessions[row.sessionKey]
      const createdAt = stored?.createdAt ?? row.createdAt
      const canonical = row.id === row.sessionKey
      const worktreeId = canonical || !stored ? row.worktree.id : stored.worktreeId
      const ownsWorkspaceName = canonical
        ? row.ownsWorkspaceName ||
          (stored?.worktreeId === row.worktree.id && stored.ownsWorkspaceName === true)
        : stored?.ownsWorkspaceName === true
      const resumeLauncher =
        row.resumeLauncher ??
        (stored?.worktreeId === worktreeId ? stored.resumeLauncher : undefined)
      const rowSnapshot = row.session ? chatSessionSnapshot(row.session) : stored?.snapshot
      const classifiedSnapshot =
        rowSnapshot?.agent === 'claude' &&
        rowSnapshot.isHeadless === undefined &&
        stored?.snapshot?.agent === 'claude' &&
        stored?.snapshot?.isHeadless !== undefined &&
        scannedClaudeSessionKey(
          rowSnapshot.executionHostId,
          rowSnapshot.sessionId,
          rowSnapshot.filePath
        ) ===
          scannedClaudeSessionKey(
            stored.snapshot.executionHostId,
            stored.snapshot.sessionId,
            stored.snapshot.filePath
          )
          ? { ...rowSnapshot, isHeadless: stored.snapshot.isHeadless }
          : rowSnapshot
      const snapshot = freshestChatSnapshot(
        freshestChatSnapshot(
          classifiedSnapshot,
          recordedSessions.has(row.sessionKey) ? (stored?.snapshot ?? null) : null,
          false
        ),
        chatLiveSessionSnapshot(row, now),
        // Why: working rows carry their turn start and done rows their finish; both are real events.
        row.state !== 'working' && row.state !== 'done'
      )
      recordedSessions.add(row.sessionKey)
      if (
        stored?.worktreeId !== worktreeId ||
        stored?.createdAt !== createdAt ||
        (stored.ownsWorkspaceName === true) !== ownsWorkspaceName ||
        JSON.stringify(stored?.resumeLauncher) !== JSON.stringify(resumeLauncher) ||
        (snapshot !== undefined && !sameChatSessionSnapshot(stored.snapshot, snapshot))
      ) {
        sessions[row.sessionKey] = {
          worktreeId,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(ownsWorkspaceName ? { ownsWorkspaceName: true } : {}),
          ...(snapshot ? { snapshot } : {}),
          ...(resumeLauncher ? { resumeLauncher } : {})
        }
      }
      titlesChanged = moveAliases(titles, row, row.id) || titlesChanged
      completedChanged = moveAliases(completed, row, row.id) || completedChanged
      foldersChanged = moveAliases(folderAssignments, row, row.id) || foldersChanged
    }
    const key = storedKey(completed, row)
    const completion = key === undefined ? undefined : completed[key]
    if (!key || !completion) {
      continue
    }
    const refreshed = refreshedChatCompletion(row, completion, now)
    if (refreshed) {
      completed[key] = refreshed
      completedChanged = true
    }
  }
  // Why: merging several resident copies can change an intermediate snapshot without changing the final registry.
  const sessionsChanged = JSON.stringify(sessions) !== JSON.stringify(current.sessions ?? {})
  if (
    !sessionsChanged &&
    !titlesChanged &&
    !completedChanged &&
    !foldersChanged &&
    !workspaceFoldersChanged &&
    !automationChanged &&
    !hiddenChanged
  ) {
    return null
  }
  return {
    ...(hiddenChanged ? { hidden: [...hidden] } : {}),
    ...(automationChanged ? { automationChats: [...automationChats] } : {}),
    ...(sessionsChanged ? { sessions } : {}),
    ...(titlesChanged ? { titles } : {}),
    ...(foldersChanged ? { folderAssignments } : {}),
    ...(workspaceFoldersChanged ? { workspaceFolderAssignments } : {}),
    ...(completedChanged ? { completed } : {})
  }
}
