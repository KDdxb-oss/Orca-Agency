import { collectWorkspaceIds, type WorkspaceSplitGroup } from '@/lib/workspace-split-layout'
import { compareChatSidebarRows } from './chat-sidebar-rows'
import { chatHasWorkingTurn, type ChatSidebarRow } from './chat-sidebar-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type FocusedChatWorkspace = {
  worktreeId: string | null
  hostId: ExecutionHostId | null
}

export type ChatWorkspaceGroup = {
  id: string
  members: ChatSidebarRow[]
  paneSplitId?: string
}

/** Keep split windows together; do not infer links from shared folders or host-ambiguous IDs. */
export function chatSidebarSplitGroups(
  groups: ChatWorkspaceGroup[],
  splits: readonly WorkspaceSplitGroup[],
  groupBy: 'recent' | 'status' | 'folder',
  focused?: FocusedChatWorkspace
) {
  const hosts = new Map<string, Set<string>>()
  for (const group of groups) {
    const row = group.members[0]
    if (!row.tabId) {
      continue
    }
    const known = hosts.get(row.worktree.id) ?? new Set<string>()
    known.add(row.hostId)
    hosts.set(row.worktree.id, known)
  }
  const links = new Map<string, { id: string; order: number }>()
  for (const split of splits) {
    const ids = collectWorkspaceIds(split.layout).filter((id) => hosts.get(id)?.size === 1)
    if (ids.length < 2) {
      continue
    }
    ids.forEach((id, order) => links.set(id, { id: split.id, order }))
  }
  const sets = new Map<string, { splitId?: string; groups: ChatWorkspaceGroup[] }>()
  for (const group of groups) {
    const row = group.members[0]
    const link = row.tabId ? links.get(row.worktree.id) : undefined
    const splitId = link?.id ?? group.paneSplitId
    const key = splitId
      ? JSON.stringify([splitId, groupBy === 'status' ? row.completed : null])
      : group.id
    const set = sets.get(key) ?? { splitId, groups: [] }
    set.groups.push(group)
    sets.set(key, set)
  }
  return [...sets.values()]
    .map((set) => {
      if (set.splitId) {
        set.groups.sort(
          (a, b) =>
            (links.get(a.members[0].worktree.id)?.order ?? 0) -
            (links.get(b.members[0].worktree.id)?.order ?? 0)
        )
      }
      const members = set.groups.flatMap((group) => group.members)
      const latest = [...members].sort(compareChatSidebarRows)[0]
      const folders = [...new Set(members.map((row) => row.folder))]
      const section =
        groupBy === 'folder'
          ? folders.length === 1
            ? folders[0]
            : 'Split workspaces'
          : members.every((row) => row.completed)
            ? 'Done'
            : 'In progress'
      const focusedWorking =
        chatHasWorkingTurn(latest) &&
        !members.every((row) => row.completed) &&
        members.some(
          (row) =>
            row.tabId && row.worktree.id === focused?.worktreeId && row.hostId === focused.hostId
        )
      return {
        ...set,
        splitId: set.groups.length > 1 ? set.splitId : undefined,
        latest,
        section,
        focusedWorking
      }
    })
    .sort(
      (a, b) =>
        Number(b.focusedWorking) - Number(a.focusedWorking) ||
        compareChatSidebarRows(a.latest, b.latest)
    )
}
