import type { DragEvent } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  AI_VAULT_SESSION_DRAG_START_EVENT,
  writeAiVaultSessionDragData,
  type AiVaultSessionDropPlacement
} from '@/lib/ai-vault-session-drag'
import { buildAiVaultResumeStartupForWorktree } from '@/lib/ai-vault-resume-command'
import {
  collectWorkspaceIds,
  findWorkspaceSplitGroup,
  MAX_WORKSPACE_PANES
} from '@/lib/workspace-split-layout'
import { chatResumeSession } from './chat-sidebar-resume'
import { buildChatSidebarRows, chatSidebarWorktrees } from './chat-sidebar-rows'
import { chatSessionKey } from './chat-sidebar-types'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import type { ChatSidebarRow } from './chat-sidebar-types'
import type { useAiVaultSessionLaunchActions } from '../right-sidebar/ai-vault-session-launch-actions'
import { createSeparateChatWorkspace, discardEmptyChatWorkspace } from './chat-sidebar-detach'
import { dropTerminalTabAtWorkspaceEdge } from '../workspace-split/workspace-tab-edge-drop'

type Resume = ReturnType<typeof useAiVaultSessionLaunchActions>['handleResume']

export function startSavedChatDrag(event: DragEvent, row: ChatSidebarRow, resume: Resume): void {
  const session = chatResumeSession(row)
  if (!session) {
    event.preventDefault()
    return
  }
  const sourceId = (row.folderWorktree ?? row.worktree).id
  try {
    const startup = session.structuredSession
      ? { command: '' }
      : buildAiVaultResumeStartupForWorktree({
          state: useAppStore.getState(),
          worktreeId: sourceId,
          session
        })
    writeAiVaultSessionDragData(
      event.dataTransfer,
      {
        agent: session.agent,
        sidebarChat: true,
        sessionId: session.sessionId,
        title: row.title.trim() || session.sessionId,
        structuredSession: session.structuredSession,
        sessionExecutionHostId: session.executionHostId,
        ...startup
      },
      (target) => {
        void resumeSavedChatAtDrop(row, target, resume).catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : 'Could not move chat.')
        )
      }
    )
    window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_START_EVENT))
  } catch (error) {
    event.preventDefault()
    toast.error(error instanceof Error ? error.message : 'Could not drag this saved chat.')
  }
}

export async function resumeSavedChatAtDrop(
  row: ChatSidebarRow,
  target: AiVaultSessionDropPlacement,
  resume: Resume
): Promise<void> {
  const session = chatResumeSession(row)
  if (!session) {
    return
  }
  let sourceId = session.structuredSession?.workspaceId ?? row.worktree.id
  const state = useAppStore.getState()
  const destinationExists = (): boolean => {
    const current = useAppStore.getState()
    const workspaces = chatSidebarWorktrees(current)
    return (
      workspaces.some((w) => w.id === target.worktreeId && !w.isArchived) &&
      Boolean(current.groupsByWorktree[target.worktreeId]?.some((g) => g.id === target.groupId))
    )
  }
  if (!destinationExists()) {
    toast.error('The destination pane was closed. Drop the chat onto an open pane.')
    return
  }
  const split = findWorkspaceSplitGroup(state.workspaceSplitGroups, target.worktreeId)
  const ids = split ? collectWorkspaceIds(split.layout) : []
  if (
    sourceId !== target.worktreeId &&
    !ids.includes(sourceId) &&
    ids.length >= MAX_WORKSPACE_PANES
  ) {
    toast.error(`A split can contain up to ${MAX_WORKSPACE_PANES} workspaces`)
    return
  }
  const edge =
    target.splitDirection === 'up'
      ? 'top'
      : target.splitDirection === 'down'
        ? 'bottom'
        : (target.splitDirection ?? 'right')
  const placeWorkspace = (): void => {
    if (destinationExists()) {
      useAppStore.getState().placeWorkspaceAtEdge(sourceId, target.worktreeId, edge)
    }
  }
  const moveExisting = (): boolean => {
    const current = useAppStore.getState()
    // Why: the agent's reported fork identity takes precedence over an older tab title link.
    const live = buildChatSidebarRows(current, [session], Date.now(), undefined, true).find(
      (item) =>
        item.tabId &&
        item.hostId === row.hostId &&
        item.sessionKey ===
          chatSessionKey(session.executionHostId, session.agent, session.sessionId)
    )
    sourceId = live?.worktree.id ?? sourceId
    const unified = current.unifiedTabsByWorktree[sourceId]?.find((tab) =>
      session.structuredSession
        ? tab.contentType === 'agent-session' &&
          tab.entityId === session.structuredSession.sessionId
        : tab.contentType === 'terminal' && tab.entityId === live?.tabId
    )
    if (!unified) {
      return false
    }
    if (sourceId === target.worktreeId) {
      current.dropUnifiedTab(unified.id, {
        groupId: target.groupId,
        splitDirection: target.splitDirection
      })
    } else {
      if (unified.contentType === 'terminal') {
        void dropTerminalTabAtWorkspaceEdge({
          sourceId,
          unifiedTabId: unified.id,
          targetId: target.worktreeId,
          edge,
          wholeWindow: false
        }).catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : 'Could not move chat.')
        )
      } else {
        current.activateTab(unified.id, { worktreeId: sourceId })
        placeWorkspace()
      }
    }
    return true
  }
  if (moveExisting()) {
    return
  }
  if (session.structuredSession) {
    void activateAiVaultStructuredSession(session)
      .then(() => {
        if (destinationExists()) {
          moveExisting()
        }
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'Could not reopen this chat.')
      )
    return
  }
  if (ids.length >= MAX_WORKSPACE_PANES) {
    toast.error(`A split can contain up to ${MAX_WORKSPACE_PANES} workspaces`)
    return
  }
  const workspace = await createSeparateChatWorkspace(row, { useSourceWhenUngrouped: true })
  const createdWorkspace = workspace.id !== row.worktree.id
  if (!destinationExists() || moveExisting()) {
    if (createdWorkspace) {
      await discardEmptyChatWorkspace(workspace)
    }
    return
  }
  sourceId = workspace.id
  // Why: a sidebar drag arranges its own workspace, never files the chat under another project.
  resume(session, sourceId, {
    onResumed: placeWorkspace,
    validateDestination: destinationExists,
    onSettled: (outcome) => {
      if (createdWorkspace && outcome === 'not-created') {
        void discardEmptyChatWorkspace(workspace).catch(() => {})
      }
    }
  })
}
