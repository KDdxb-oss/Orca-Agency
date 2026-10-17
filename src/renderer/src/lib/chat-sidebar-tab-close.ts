import type { AppState } from '@/store/types'
import type { ChatSidebarSettings } from '../../../shared/chat-sidebar-settings'
import { updateChatSidebarSettings } from './chat-sidebar-settings-update'
import { buildChatSidebarRows } from '@/components/sidebar/chat-sidebar-rows'
import {
  chatSidebarPreferencePatch,
  isChatCompleted
} from '@/components/sidebar/chat-sidebar-identity'
import type { ChatSidebarRow } from '@/components/sidebar/chat-sidebar-types'

export function closedChatSidebarPatch(
  closing: readonly ChatSidebarRow[],
  remaining: readonly ChatSidebarRow[],
  current: ChatSidebarSettings,
  now: number
): Partial<ChatSidebarSettings> {
  const patch = chatSidebarPreferencePatch(closing, current, now) ?? {}
  const completed = { ...current.completed, ...patch.completed }
  const folderAssignments = { ...current.folderAssignments, ...patch.folderAssignments }
  for (const row of closing) {
    // Why: closing one duplicate must not mark another still-open copy of that chat done.
    if (
      remaining.some(
        (other) => other.tabId && row.sessionKey && other.sessionKey === row.sessionKey
      )
    ) {
      continue
    }
    const id = row.sessionKey ?? row.id
    const previous = completed[id]
    // Why: closing a tab must not replace an explicit Mark done choice with automatic completion.
    if (!previous || previous.closedTabId || !isChatCompleted(row, previous)) {
      completed[id] = {
        at: now,
        activityAt: row.timestamp,
        done: true,
        ...(row.tabId ? { closedTabId: row.tabId } : {})
      }
    }
    if (row.folderWorktree) {
      folderAssignments[id] = { worktreeId: row.folderWorktree.id, executionHostId: row.hostId }
    }
  }
  return { ...patch, completed, folderAssignments }
}

/** Capture before retirement erases provider metadata; persist only after the close succeeds. */
export function captureClosedChatTabCompletion(
  get: () => AppState,
  tabId: string
): (() => void) | undefined {
  const closing = buildChatSidebarRows(get(), [], Date.now(), undefined, true).filter(
    (row) => row.tabId === tabId
  )
  if (!closing.length) {
    return
  }
  return () => {
    const now = Date.now()
    void updateChatSidebarSettings(get, (current) =>
      closedChatSidebarPatch(
        closing,
        buildChatSidebarRows(get(), [], now, undefined, true),
        current,
        now
      )
    ).catch((error: unknown) => console.error('Could not save closed chat status', error))
  }
}
