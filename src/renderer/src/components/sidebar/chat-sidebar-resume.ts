import type { AiVaultResumeSession } from '../../../../shared/ai-vault-resume-preparation'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { isClaudeTranscriptInProjectBucket } from '../../../../shared/claude-project-path'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ChatSidebarRow } from './chat-sidebar-types'

/**
 * The session to resume from the chat list: a chat filed under another workspace starts in that
 * workspace's folder, on its own host. Only this list does it; AI Vault resumes where the chat ran.
 */
export function chatResumeSession(
  row: Pick<ChatSidebarRow, 'session' | 'hostId' | 'worktree' | 'folderWorktree'>
): AiVaultResumeSession | null {
  const session = row.session
  const target = (row.folderWorktree ?? row.worktree).path.trim()
  if (!session || !target || session.executionHostId !== row.hostId) {
    return session
  }
  if (session.agent === 'claude' && session.executionHostId === 'local') {
    // Why: local WSL transcripts live in Linux's Claude store, outside Windows folder preparation.
    if (
      isWslUncPath(session.filePath) ||
      isWslUncPath(target) ||
      (navigator.userAgent.includes('Windows') && session.executionHostPlatform === 'linux')
    ) {
      return session
    }
    // Why: even an unchanged path may now be a junction to a differently named project bucket.
    const cwd =
      row.folderWorktree || isClaudeTranscriptInProjectBucket(session.filePath, target)
        ? target
        : session.cwd || target
    return { ...session, resumeCwd: cwd }
  }
  if (
    // Why: a chat recorded in this workspace or a subfolder keeps the exact folder it ran in.
    !row.folderWorktree &&
    session.cwd &&
    isPathInsideOrEqual(target, session.cwd)
  ) {
    return session
  }
  // Why: Claude finds transcripts by launch folder; moving the folder without the transcript finds nothing.
  if (session.agent === 'claude' && !isClaudeTranscriptInProjectBucket(session.filePath, target)) {
    return row.folderWorktree ? { ...session, resumeCwd: target } : session
  }
  // Why: a host-built resume command embeds the old folder, so the local builder must run instead.
  return { ...session, cwd: target, resumeCommand: '' }
}
