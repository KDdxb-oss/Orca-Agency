import {
  AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT,
  type AiVaultSessionTitlesArgs,
  type AiVaultSessionTitlesResult
} from '../../../../shared/ai-vault-session-title'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type {
  ChatSidebarSettings,
  ChatSidebarSessionSnapshot
} from '../../../../shared/chat-sidebar-settings'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../../shared/wsl-paths'

type PendingClaudeSnapshot = { key: string; snapshot: ChatSidebarSessionSnapshot }

function transcriptKey(hostId: string, sessionId: string, filePath: string): string {
  return JSON.stringify([hostId, sessionId, normalizeRuntimePathForComparison(filePath)])
}

export async function classifyUnscannedClaudeHistory(args: {
  sessions: ChatSidebarSettings['sessions']
  scannedSessions: readonly AiVaultSession[]
  resolveTitles: (request: AiVaultSessionTitlesArgs) => Promise<AiVaultSessionTitlesResult>
  update: (patch: (current: ChatSidebarSettings) => Partial<ChatSidebarSettings> | null) => unknown
  signal: AbortSignal
  attemptedEmpty?: Set<string>
}): Promise<void> {
  const scanned = new Set(
    args.scannedSessions
      .filter((session) => session.agent === 'claude')
      .map((session) => transcriptKey(session.executionHostId, session.sessionId, session.filePath))
  )
  const byHost = new Map<ExecutionHostId, PendingClaudeSnapshot[]>()
  for (const [key, entry] of Object.entries(args.sessions ?? {})) {
    const snapshot = entry.snapshot
    if (
      snapshot?.agent !== 'claude' ||
      snapshot.isHeadless !== undefined ||
      args.attemptedEmpty?.has(
        transcriptKey(snapshot.executionHostId, snapshot.sessionId, snapshot.filePath)
      ) ||
      scanned.has(transcriptKey(snapshot.executionHostId, snapshot.sessionId, snapshot.filePath))
    ) {
      continue
    }
    const host = byHost.get(snapshot.executionHostId) ?? []
    host.push({ key, snapshot })
    byHost.set(snapshot.executionHostId, host)
  }

  const hosts = [...byHost].sort(
    ([a], [b]) => Number(b === LOCAL_EXECUTION_HOST_ID) - Number(a === LOCAL_EXECUTION_HOST_ID)
  )
  for (const [hostId, pending] of hosts) {
    const pathById = new Map<string, string>()
    const conflictingIds = new Set<string>()
    for (const { snapshot } of pending) {
      const path = normalizeRuntimePathForComparison(snapshot.filePath)
      const previous = pathById.get(snapshot.sessionId)
      if (previous && previous !== path) {
        conflictingIds.add(snapshot.sessionId)
      }
      pathById.set(snapshot.sessionId, path)
    }
    const unambiguous = pending.filter(({ snapshot }) => !conflictingIds.has(snapshot.sessionId))
    for (
      let start = 0;
      start < unambiguous.length;
      start += AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT
    ) {
      if (args.signal.aborted) {
        return
      }
      const batch = unambiguous.slice(start, start + AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)
      let result: AiVaultSessionTitlesResult
      try {
        result = await args.resolveTitles({
          executionHostScope: hostId,
          requests: batch.map(({ snapshot }) => ({
            agent: 'claude',
            sessionId: snapshot.sessionId,
            transcriptPath: snapshot.filePath
          }))
        })
      } catch {
        continue
      }
      const byId = new Map(
        result.titles
          .filter((title) => title.agent === 'claude' && title.isHeadless !== undefined)
          .map((title) => [title.sessionId, title.isHeadless])
      )
      const classified = new Map<string, { transcript: string; isHeadless: boolean }>()
      for (const { key, snapshot } of batch) {
        const isHeadless = byId.get(snapshot.sessionId)
        const transcript = transcriptKey(
          snapshot.executionHostId,
          snapshot.sessionId,
          snapshot.filePath
        )
        if (isHeadless === undefined) {
          // WSL and fully empty remote results may mean the host was unavailable.
          if (
            !isWslUncPath(snapshot.filePath) &&
            (hostId === LOCAL_EXECUTION_HOST_ID || result.titles.length > 0)
          ) {
            args.attemptedEmpty?.add(transcript)
          }
          continue
        }
        classified.set(key, { transcript, isHeadless })
      }
      if (args.signal.aborted || classified.size === 0) {
        continue
      }
      await args.update((current) => {
        const sessions = { ...current.sessions }
        let changed = false
        for (const [key, classification] of classified) {
          const entry = sessions[key]
          const snapshot = entry?.snapshot
          if (
            snapshot?.agent !== 'claude' ||
            snapshot.isHeadless !== undefined ||
            transcriptKey(snapshot.executionHostId, snapshot.sessionId, snapshot.filePath) !==
              classification.transcript
          ) {
            continue
          }
          sessions[key] = {
            ...entry,
            snapshot: { ...snapshot, isHeadless: classification.isHeadless }
          }
          changed = true
        }
        return changed ? { sessions } : null
      })
    }
  }
}
