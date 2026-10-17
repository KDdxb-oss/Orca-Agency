import {
  folderWorkspaceToWorktree,
  projectGroupIdFromRepoId
} from '../../../../shared/folder-workspace-worktree'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ChatSidebarState } from './chat-sidebar-types'
import { basename } from '@/lib/path'

export function chatSidebarWorktrees(
  state: Pick<ChatSidebarState, 'worktreesByRepo' | 'folderWorkspaces'>
): Worktree[] {
  return [
    ...new Map(
      [
        ...Object.values(state.worktreesByRepo)
          .flat()
          .filter((worktree) => worktree.automationProvenance?.kind !== 'created-by-automation'),
        ...state.folderWorkspaces.map(folderWorkspaceToWorktree)
      ].map((worktree) => [worktree.id, worktree])
    ).values()
  ]
}

export function chatFolderLabel(
  state: Pick<ChatSidebarState, 'repos' | 'projectGroups'>,
  worktree: Worktree
): string {
  const repo = state.repos.find((item) => item.id === worktree.repoId)
  const groupId = repo?.projectGroupId ?? projectGroupIdFromRepoId(worktree.repoId)
  const group = state.projectGroups.find((item) => item.id === groupId)
  return (
    (group?.parentPath ? basename(group.parentPath) || group.parentPath : group?.name) ??
    repo?.displayName ??
    worktree.path.split(/[\\/]/).findLast(Boolean) ??
    'Folder'
  )
}
