import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { buildChatSidebarRows, chatSidebarWorktrees } from '../sidebar/chat-sidebar-rows'
import { detachSidebarChat } from '../sidebar/chat-sidebar-detach'
import type { WorkspacePanePlacement } from '@/lib/workspace-pane-placement'
import {
  collectWorkspaceIds,
  findWorkspaceSplitGroup,
  MAX_WORKSPACE_PANES,
  type WorkspaceSplitEdge
} from '@/lib/workspace-split-layout'

export function canDropTerminalTabAtWorkspaceEdge(sourceId: string, unifiedTabId: string): boolean {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[sourceId]?.find((item) => item.id === unifiedTabId)
  if (!tab || tab.contentType !== 'terminal') {
    return false
  }
  return (
    (state.tabsByWorktree[sourceId]?.length ?? 0) <= 1 ||
    buildChatSidebarRows(state, [], Date.now()).some(
      (row) => row.tabId === tab.entityId && row.hostId === 'local'
    )
  )
}

/** Different folders share panes, never a tab group. A multi-chat source moves just the dragged chat. */
export async function dropTerminalTabAtWorkspaceEdge(args: {
  sourceId: string
  unifiedTabId: string
  targetId: string
  edge: WorkspaceSplitEdge
  wholeWindow: boolean
  placement?: WorkspacePanePlacement
}): Promise<void> {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[args.sourceId]?.find(
    (item) => item.id === args.unifiedTabId
  )
  if (
    !tab ||
    tab.contentType !== 'terminal' ||
    !canDropTerminalTabAtWorkspaceEdge(args.sourceId, args.unifiedTabId)
  ) {
    throw new Error('This chat is no longer in its source pane.')
  }
  const targetExists = () =>
    chatSidebarWorktrees(useAppStore.getState()).some(
      (item) => item.id === args.targetId && !item.isArchived
    )
  if (!targetExists()) {
    throw new Error('The destination workspace was closed.')
  }
  const split = findWorkspaceSplitGroup(state.workspaceSplitGroups, args.targetId)
  const detaching = (state.tabsByWorktree[args.sourceId]?.length ?? 0) > 1
  if (
    split &&
    (detaching || !collectWorkspaceIds(split.layout).includes(args.sourceId)) &&
    collectWorkspaceIds(split.layout).length >= MAX_WORKSPACE_PANES
  ) {
    throw new Error(`A split can contain up to ${MAX_WORKSPACE_PANES} workspaces`)
  }
  let sourceId = args.sourceId
  if (detaching) {
    const row = buildChatSidebarRows(state, [], Date.now()).find(
      (item) => item.tabId === tab.entityId
    )
    if (!row) {
      throw new Error('This terminal has no chat to move.')
    }
    sourceId = await detachSidebarChat(row, false)
  }
  if (!targetExists()) {
    throw new Error('The destination workspace was closed. Your chat remains separate.')
  }
  const currentSplit = findWorkspaceSplitGroup(
    useAppStore.getState().workspaceSplitGroups,
    args.targetId
  )
  if (
    currentSplit &&
    !collectWorkspaceIds(currentSplit.layout).includes(sourceId) &&
    collectWorkspaceIds(currentSplit.layout).length >= MAX_WORKSPACE_PANES
  ) {
    throw new Error(
      `A split can contain up to ${MAX_WORKSPACE_PANES} workspaces. Your chat remains separate.`
    )
  }
  if (
    activateAndRevealWorkspace(sourceId, {
      executionHostId: tab.executionHostId ?? 'local',
      revealInSidebar: false,
      providesInitialSurface: true
    }) !== false
  ) {
    if (args.placement) {
      useAppStore.getState().placeWorkspacePane(sourceId, args.targetId, args.placement)
    } else {
      useAppStore
        .getState()
        .placeWorkspaceAtEdge(sourceId, args.targetId, args.edge, args.wholeWindow)
    }
  }
}
