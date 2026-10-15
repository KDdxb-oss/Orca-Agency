import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatPreference } from './chat-sidebar-identity'
import type { ChatSidebarState } from './chat-sidebar-types'
import type { ChatSidebarSettings } from '../../../../shared/chat-sidebar-settings'

/** A later tab-bar rename replaces the saved sidebar name of its sole conversation. */
export function chatSidebarTabRename(
  state: ChatSidebarState,
  tabId: string,
  title: string | null,
  current: ChatSidebarSettings
): Partial<ChatSidebarSettings> | null {
  const rows = buildChatSidebarRows(state, [], Date.now(), undefined, true).filter(
    (row) => row.tabId === tabId
  )
  if (rows.length !== 1 || !chatPreference(current.titles, rows[0])) {
    return null
  }
  const row = rows[0]
  const titles = { ...current.titles }
  for (const id of [row.id, ...row.aliases]) {
    delete titles[id]
  }
  if (title?.trim()) {
    titles[row.id] = title.trim()
  }
  return { titles }
}
