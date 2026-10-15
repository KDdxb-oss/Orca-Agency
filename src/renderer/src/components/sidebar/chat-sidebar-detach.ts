import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  folderWorkspaceToWorktree,
  projectGroupIdFromRepoId
} from '../../../../shared/folder-workspace-worktree'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { setChatFolder } from './chat-sidebar-preferences'
import type { ChatSidebarRow } from './chat-sidebar-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

const pending = new Map<string, Promise<string>>()

export async function discardEmptyChatWorkspace(workspace: Worktree): Promise<void> {
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(workspace.id)
  if (
    scope?.type === 'folder' &&
    !state.unifiedTabsByWorktree[workspace.id]?.length &&
    !state.tabsByWorktree[workspace.id]?.length
  ) {
    await state.deleteFolderWorkspace(scope.folderWorkspaceId, {
      executionHostId: workspace.hostId ?? 'local'
    })
  }
}

/** A separate view of the same folder, not a new process or a copied conversation. */
export async function createSeparateChatWorkspace(
  row: ChatSidebarRow,
  options: { useSourceWhenUngrouped?: boolean } = {}
): Promise<Worktree> {
  const state = useAppStore.getState()
  const folder = row.folderWorktree ?? row.worktree
  const groupId =
    projectGroupIdFromRepoId(folder.repoId) ??
    state.repos.find((repo) => repo.id === folder.repoId)?.projectGroupId
  const group = state.projectGroups.find(
    (item) =>
      getNewWorkspaceProjectGroupHostId(item) === row.hostId &&
      (item.id === groupId ||
        (item.parentPath &&
          normalizeRuntimePathForComparison(item.parentPath) ===
            normalizeRuntimePathForComparison(folder.path)))
  )
  if (!group) {
    if (options.useSourceWhenUngrouped) {
      return row.worktree
    }
    throw new Error('This chat needs a folder before it can be moved to a separate workspace.')
  }
  const host = parseExecutionHostId(row.hostId)
  const created = await state.createFolderWorkspace(
    {
      projectGroupId: group.id,
      name: row.title,
      folderPath: folder.path,
      connectionId: host?.kind === 'ssh' ? host.targetId : null
    },
    { runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null }
  )
  if (!created) {
    throw new Error('Could not create a separate chat workspace.')
  }
  return folderWorkspaceToWorktree(created)
}

export function detachSidebarChat(row: ChatSidebarRow, activate = true): Promise<string> {
  if (!row.tabId) {
    return Promise.reject(new Error('Open this chat before moving it out of its workspace.'))
  }
  const key = JSON.stringify([row.hostId, row.tabId])
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const task = (async () => {
    const before = useAppStore.getState()
    if (row.hostId !== 'local') {
      throw new Error(
        'This host does not support moving a live chat between workspaces yet. Move its whole pane instead.'
      )
    }
    const unified = before.unifiedTabsByWorktree[row.worktree.id]?.find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === row.tabId
    )
    if (!unified) {
      throw new Error('This chat is no longer in that workspace.')
    }
    const workspace = await createSeparateChatWorkspace(row)
    const state = useAppStore.getState()
    state.ensureWorktreeRootGroup(workspace.id)
    if (!state.moveTerminalTabToWorkspace(unified.id, workspace.id)) {
      await discardEmptyChatWorkspace(workspace)
      throw new Error(
        'The chat changed while it was being moved. Its terminal has been kept intact.'
      )
    }
    if ((useAppStore.getState().unifiedTabsByWorktree[row.worktree.id]?.length ?? 0) === 0) {
      useAppStore.getState().unsplitWorkspace(row.worktree.id)
    }
    if (activate) {
      activateAndRevealWorkspace(workspace.id, {
        executionHostId: row.hostId,
        revealInSidebar: false,
        providesInitialSurface: true
      })
    }
    // Filing must not strand the already moved, running surface on an IPC failure.
    void setChatFolder(
      { ...row, worktree: workspace },
      row.folderWorktree ?? row.worktree,
      row.worktree.id
    ).catch((error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : 'Chat moved, but its folder could not be saved.'
      )
    )
    return workspace.id
  })()
  pending.set(key, task)
  void task.finally(() => pending.delete(key)).catch(() => {})
  return task
}

export function detachTerminalChat(tabId: string): void {
  const row = buildChatSidebarRows(useAppStore.getState(), [], Date.now()).find(
    (item) => item.tabId === tabId
  )
  if (!row) {
    toast.error('This terminal has no saved chat to move.')
    return
  }
  void detachSidebarChat(row).catch((error: unknown) =>
    toast.error(error instanceof Error ? error.message : 'Could not move chat.')
  )
}
