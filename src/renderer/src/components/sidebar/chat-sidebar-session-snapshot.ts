import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type {
  ChatSidebarSessionEntry,
  ChatSidebarSessionSnapshot
} from '../../../../shared/chat-sidebar-settings'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { isAiVaultTitleAgent } from '../../../../shared/ai-vault-session-title'
import { isClaudeTranscriptInProjectBucket } from '../../../../shared/claude-project-path'
import {
  chatSessionKey,
  chatSessionTime,
  type ChatLiveSession,
  type ChatSidebarRow
} from './chat-sidebar-types'

export function chatSessionMap(
  sessions: readonly AiVaultSession[],
  remembered: ReadonlySet<AiVaultSession>
): Map<string, AiVaultSession> {
  const result = new Map<string, AiVaultSession>()
  for (const session of [...sessions, ...remembered]) {
    const key = chatSessionKey(session.executionHostId, session.agent, session.sessionId)
    const previous = result.get(key)
    // Why: provider renames from a fresh scan beat a remembered title for the same file.
    if (previous?.filePath === session.filePath && remembered.has(session)) {
      continue
    }
    // Why: a moved Claude session retains its original file; scan order must not choose that stale copy.
    if (
      !previous ||
      (chatSessionTime(session) - chatSessionTime(previous) ||
        (Date.parse(session.modifiedAt) || 0) - (Date.parse(previous.modifiedAt) || 0)) > 0
    ) {
      result.set(key, session)
    }
  }
  return result
}

// Why: live activity refreshes a remembered chat's time at most once a minute, not per hook ping.
const LIVE_SNAPSHOT_REFRESH_MS = 60_000

const SNAPSHOT_FIELDS = [
  'executionHostId',
  'executionHostPlatform',
  'agent',
  'sessionId',
  'title',
  'cwd',
  'filePath',
  'codexHome',
  'createdAt',
  'updatedAt',
  'modifiedAt',
  'isHeadless',
  'lastHumanTurnAt',
  'resumeCommand'
] as const

export function chatSessionSnapshot(session: AiVaultSession): ChatSidebarSessionSnapshot {
  return {
    executionHostId: session.executionHostId,
    ...(session.executionHostPlatform
      ? { executionHostPlatform: session.executionHostPlatform }
      : {}),
    agent: session.agent,
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    filePath: session.filePath,
    codexHome: session.codexHome,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    modifiedAt: session.modifiedAt,
    ...(session.agent === 'claude' && session.isHeadless !== undefined
      ? { isHeadless: session.isHeadless }
      : {}),
    ...(session.lastHumanTurnAt ? { lastHumanTurnAt: session.lastHumanTurnAt } : {}),
    ...(session.executionHostId !== LOCAL_EXECUTION_HOST_ID && session.resumeCommand
      ? { resumeCommand: session.resumeCommand }
      : {})
  }
}

export function sameChatSessionSnapshot(
  a: ChatSidebarSessionSnapshot | undefined,
  b: ChatSidebarSessionSnapshot
): boolean {
  return (
    a !== undefined && SNAPSHOT_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null))
  )
}

/** Closed chats remembered in settings, for keys the live scan did not return. */
export function chatSnapshotSessions(
  entries: Record<string, ChatSidebarSessionEntry> | undefined,
  scannedKeys: ReadonlySet<string>
): AiVaultSession[] {
  return Object.entries(entries ?? {}).flatMap(([key, entry]) => {
    const snapshot = entry.snapshot
    if (
      !snapshot ||
      scannedKeys.has(key) ||
      chatSessionKey(snapshot.executionHostId, snapshot.agent, snapshot.sessionId) !== key
    ) {
      return []
    }
    return [
      {
        ...snapshot,
        id: `${snapshot.executionHostId}:${snapshot.agent}:${snapshot.sessionId}:${snapshot.filePath}`,
        branch: null,
        model: null,
        messageCount: 0,
        totalTokens: 0,
        previewMessages: [],
        queuedMessageCount: 0,
        subagentTranscriptCount: 0,
        resumeCommand: snapshot.resumeCommand ?? '',
        subagent: null
      }
    ]
  })
}

/** A hook-reported Claude or Codex session that carries its transcript path. */
export function chatLiveSession(
  agent: string | undefined,
  providerSession: AgentProviderSessionMetadata | undefined,
  title: string
): ChatLiveSession | null {
  const transcriptPath = providerSession?.transcriptPath?.trim()
  return isAiVaultTitleAgent(agent) && providerSession?.id && transcriptPath
    ? { agent, sessionId: providerSession.id, transcriptPath, title }
    : null
}

/** Codex writes rollouts to `<CODEX_HOME>/sessions/YYYY/MM/DD/`, so only that exact layout names its home. */
export function codexHomeFromTranscript(transcriptPath: string): string | null {
  return (
    /^(.+)[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^\\/]+$/.exec(transcriptPath)?.[1] ??
    null
  )
}

/**
 * What a live chat needs to resume after its tab closes, from authoritative hook data only:
 * Codex's home is where its rollout lives; Claude's folder must be the bucket its transcript is in.
 */
export function chatLiveSessionSnapshot(
  row: Pick<
    ChatSidebarRow,
    'hostId' | 'worktree' | 'folderWorktree' | 'timestamp' | 'liveSession' | 'sessionKey'
  >,
  now: number
): ChatSidebarSessionSnapshot | null {
  const live = row.liveSession
  if (!live || chatSessionKey(row.hostId, live.agent, live.sessionId) !== row.sessionKey) {
    return null
  }
  // A tab can move to another pane without moving the project that owns its conversation.
  const sessionFolder = row.folderWorktree ?? row.worktree
  const codexHome = live.agent === 'codex' ? codexHomeFromTranscript(live.transcriptPath) : null
  if (
    (live.agent === 'codex' && !codexHome) ||
    (live.agent === 'claude' &&
      !isClaudeTranscriptInProjectBucket(live.transcriptPath, sessionFolder.path))
  ) {
    return null
  }
  const at = new Date(row.timestamp > 0 ? row.timestamp : now).toISOString()
  return {
    executionHostId: row.hostId,
    agent: live.agent,
    sessionId: live.sessionId,
    title: live.title,
    cwd: sessionFolder.path,
    filePath: live.transcriptPath,
    codexHome,
    createdAt: null,
    updatedAt: at,
    modifiedAt: at
  }
}

/**
 * Keeps the richer scanned or stored snapshot, moving its time forward for newer live activity.
 * Turn starts and finishes always land; only continuously moving evidence time is throttled.
 */
export function freshestChatSnapshot(
  base: ChatSidebarSessionSnapshot | undefined,
  live: ChatSidebarSessionSnapshot | null,
  throttle: boolean
): ChatSidebarSessionSnapshot | undefined {
  if (!base || !live) {
    return base ?? live ?? undefined
  }
  const baseAt = Date.parse(base.updatedAt ?? base.modifiedAt)
  const liveAt = Date.parse(live.updatedAt ?? live.modifiedAt)
  // Why: the hook's verified transcript path is authoritative even within the activity throttle.
  const relocated =
    base.filePath !== live.filePath &&
    base.executionHostId === live.executionHostId &&
    base.agent === live.agent &&
    base.sessionId === live.sessionId
  if (relocated) {
    return {
      ...base,
      cwd: live.cwd,
      filePath: live.filePath,
      title: live.title,
      updatedAt: liveAt > baseAt ? live.updatedAt : base.updatedAt,
      modifiedAt: liveAt > baseAt ? live.modifiedAt : base.modifiedAt
    }
  }
  return Number.isFinite(baseAt) && liveAt <= baseAt + (throttle ? LIVE_SNAPSHOT_REFRESH_MS : 0)
    ? base
    : { ...base, title: live.title, updatedAt: live.updatedAt, modifiedAt: live.modifiedAt }
}
