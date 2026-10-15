import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { updateChatSidebar } from './chat-sidebar-preferences'
import type { ChatSidebarListItem } from './chat-sidebar-groups'

export function useChatSidebarSectionToggle() {
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  return useCallback(
    (heading: Extract<ChatSidebarListItem, { kind: 'heading' }>) => {
      const folder = heading.doneFolder
      if (folder === undefined) {
        toggleCollapsedGroup(heading.id)
        return
      }
      if (useAppStore.getState().collapsedGroups.has(heading.id)) {
        toggleCollapsedGroup(heading.id)
      }
      void updateChatSidebar((current) => ({
        expandedDoneFolders: heading.collapsed
          ? [...new Set([...(current.expandedDoneFolders ?? []), folder])]
          : (current.expandedDoneFolders ?? []).filter((label) => label !== folder)
      }))
    },
    [toggleCollapsedGroup]
  )
}
