import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultResumePlacement } from '../right-sidebar/ai-vault-session-launch-actions'
import { createSeparateChatWorkspace, discardEmptyChatWorkspace } from './chat-sidebar-detach'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatResumeSession } from './chat-sidebar-resume'
import { chatSessionKey, type ChatSidebarRow } from './chat-sidebar-types'

type ResumeChat = (
  session: AiVaultSession,
  workspaceId?: string,
  placement?: AiVaultResumePlacement
) => void
const opening = new Set<string>()

export function activateResidentSidebarChat(row: ChatSidebarRow): void {
  if (
    activateAndRevealWorkspace(row.worktree.id, {
      executionHostId: row.hostId,
      revealInSidebar: false,
      providesInitialSurface: true
    }) === false
  ) {
    return
  }
  if (
    row.tabId &&
    !activateStructuredAgentSessionTab({ worktreeId: row.worktree.id, tabId: row.tabId })
  ) {
    activateTabAndFocusPane(
      row.tabId,
      row.paneKey ? (parsePaneKey(row.paneKey)?.leafId ?? null) : null
    )
  }
}

/** History is a conversation, not an instruction to restore a closed layout slot. */
export async function openSavedSidebarChat(row: ChatSidebarRow, resume: ResumeChat): Promise<void> {
  const session = chatResumeSession(row)
  if (!session) {
    return
  }
  const findLive = () =>
    buildChatSidebarRows(useAppStore.getState(), [session], Date.now()).find(
      (item) =>
        item.tabId &&
        item.hostId === row.hostId &&
        item.sessionKey ===
          chatSessionKey(session.executionHostId, session.agent, session.sessionId)
    )
  const live = findLive()
  if (live) {
    activateResidentSidebarChat(live)
    return
  }
  if (opening.has(row.id)) {
    return
  }
  opening.add(row.id)
  try {
    if (session.structuredSession) {
      resume(session, undefined, { onSettled: () => opening.delete(row.id) })
      return
    }
    const workspace = await createSeparateChatWorkspace(row, { useSourceWhenUngrouped: true })
    const createdWorkspace = workspace.id !== row.worktree.id
    const currentLive = findLive()
    if (currentLive) {
      activateResidentSidebarChat(currentLive)
      if (createdWorkspace) {
        await discardEmptyChatWorkspace(workspace)
      }
      opening.delete(row.id)
      return
    }
    resume(session, workspace.id, {
      onSettled: (outcome) => {
        opening.delete(row.id)
        if (createdWorkspace && outcome === 'not-created') {
          void discardEmptyChatWorkspace(workspace).catch(() => {})
        }
      }
    })
  } catch (error) {
    opening.delete(row.id)
    toast.error(error instanceof Error ? error.message : 'Could not reopen chat.')
  }
}
