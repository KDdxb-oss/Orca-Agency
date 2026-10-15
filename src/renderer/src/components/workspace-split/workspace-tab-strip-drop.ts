import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { buildChatSidebarRows } from '../sidebar/chat-sidebar-rows'
import { setChatFolder } from '../sidebar/chat-sidebar-preferences'

export type WorkspaceTabStripDrop = {
  targetId: string
  groupId: string
  index: number
  left: number
  top: number
  height: number
}

export function workspaceForeignTabStripAtPoint(sourceId: string, x: number, y: number): boolean {
  const strip = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>('[data-tab-group-strip-id][data-worktree-id]')
  return Boolean(strip && strip.dataset.worktreeId !== sourceId)
}

export function workspaceTabStripDropTarget(
  sourceId: string,
  tabId: string,
  x: number,
  y: number
): WorkspaceTabStripDrop | null {
  const strip = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>('[data-tab-group-strip-id][data-worktree-id]')
  if (!strip || strip.dataset.worktreeId === sourceId) {
    return null
  }
  const targetId = strip.dataset.worktreeId!
  const groupId = strip.dataset.tabGroupStripId!
  const state = useAppStore.getState()
  const source = state.getKnownWorktreeById(sourceId, 'local')
  const destination = state.getKnownWorktreeById(targetId, 'local')
  const tab = state.unifiedTabsByWorktree[sourceId]?.find((item) => item.id === tabId)
  const group = state.groupsByWorktree[targetId]?.find((item) => item.id === groupId)
  if (
    !source ||
    !destination ||
    !group ||
    getConnectionIdFromState(state, sourceId) !== null ||
    getConnectionIdFromState(state, targetId) !== null ||
    tab?.contentType !== 'terminal' ||
    (tab.executionHostId && tab.executionHostId !== 'local') ||
    normalizeRuntimePathForComparison(source.path) !==
      normalizeRuntimePathForComparison(destination.path)
  ) {
    return null
  }
  const bounds = strip.getBoundingClientRect()
  const tabs = [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')]
    .map((node) => {
      const id = state.unifiedTabsByWorktree[targetId]?.find(
        (item) => item.id === node.dataset.tabId || item.entityId === node.dataset.tabId
      )?.id
      return { node, rect: node.getBoundingClientRect(), index: group.tabOrder.indexOf(id ?? '') }
    })
    .filter((item) => item.index >= 0 && item.rect.width > 0)
  const next = tabs.find((item) => x < item.rect.left + item.rect.width / 2)
  const last = tabs.at(-1)
  return {
    targetId,
    groupId,
    index: next?.index ?? group.tabOrder.length,
    left: next?.rect.left ?? last?.rect.right ?? bounds.left,
    top: bounds.top,
    height: bounds.height
  }
}

export async function dropTerminalTabIntoWorkspaceStrip(
  sourceId: string,
  tabId: string,
  target: WorkspaceTabStripDrop
): Promise<void> {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[sourceId]?.find((item) => item.id === tabId)
  const row = buildChatSidebarRows(state, [], Date.now()).find(
    (item) => item.tabId === tab?.entityId
  )
  if (!state.moveTerminalTabToWorkspace(tabId, target.targetId, target)) {
    throw new Error('The destination changed. Your chat has been kept intact.')
  }
  if (!useAppStore.getState().unifiedTabsByWorktree[sourceId]?.length) {
    useAppStore.getState().unsplitWorkspace(sourceId)
  }
  activateAndRevealWorkspace(target.targetId, {
    revealInSidebar: false,
    providesInitialSurface: true
  })
  if (row) {
    const worktree = useAppStore.getState().getKnownWorktreeById(target.targetId, 'local')
    if (worktree) {
      await setChatFolder({ ...row, worktree }, row.folderWorktree ?? row.worktree, sourceId)
    }
  }
}
