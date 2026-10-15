import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { ChatSidebarListItem } from './chat-sidebar-groups'

/** Reveal a working chat's folder only when it returns from the split section. */
export function useRevealWorkingChatFolders(
  items: readonly ChatSidebarListItem[],
  query: string,
  enabled: boolean
) {
  const previous = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!enabled || query.trim()) {
      previous.current = null
      return
    }
    const splitChats = new Set(
      items.flatMap((item) => (item.kind === 'heading' ? (item.splitChatIds ?? []) : []))
    )
    const state = useAppStore.getState()
    for (const item of items) {
      if (
        item.kind === 'heading' &&
        state.collapsedGroups.has(item.id) &&
        item.workingChatIds?.some((id) => previous.current?.has(id) && !splitChats.has(id))
      ) {
        state.toggleCollapsedGroup(item.id)
      }
    }
    previous.current = splitChats
  }, [items, query, enabled])
}
