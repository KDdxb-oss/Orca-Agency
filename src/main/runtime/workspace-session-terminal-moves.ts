import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { collectLayoutLeafIdsInOrder } from '../persistence/restoring-sessions/terminal-layout-normalization'
import { indexPersistedPtySurfaceBindings } from './runtime-worktree-binding-index'
import { hasPersistedTerminalMoveEvidence } from './persisted-terminal-move-evidence'
import { restoreRejectedWorkspaceTerminalMoves } from './workspace-session-rejected-terminal-moves'

function uniqueTabs(session: WorkspaceSessionState): Map<string, TerminalTab> {
  const tabs = new Map<string, TerminalTab>()
  const duplicates = new Set<string>()
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree)) {
    for (const tab of rows) {
      if (tab.worktreeId !== worktreeId || tabs.has(tab.id) || duplicates.has(tab.id)) {
        tabs.delete(tab.id)
        duplicates.add(tab.id)
      } else {
        tabs.set(tab.id, tab)
      }
    }
  }
  return tabs
}

/** Accept only a whole-tab local move that retains every host-issued process incarnation. */
export function admitLocalWorkspaceTerminalMoves(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined
): { session: WorkspaceSessionState; prior: WorkspaceSessionState | undefined } {
  if (!prior) {
    return { session: incoming, prior }
  }
  const currentTabs = uniqueTabs(prior)
  const incomingTabs = uniqueTabs(incoming)
  const incomingOwners = new Map<string, Set<string>>()
  for (const [worktreeId, tabs] of Object.entries(incoming.tabsByWorktree)) {
    for (const tab of tabs) {
      const owners = incomingOwners.get(tab.id) ?? new Set<string>()
      owners.add(worktreeId)
      incomingOwners.set(tab.id, owners)
    }
  }
  let incomingSurfaces: ReturnType<typeof indexPersistedPtySurfaceBindings> | undefined
  let admitted = prior
  const rejected = new Map<string, TerminalTab>()
  for (const [tabId, current] of currentTabs) {
    const proposedOwners = incomingOwners.get(tabId)
    if (proposedOwners && [...proposedOwners].some((id) => id !== current.worktreeId)) {
      rejected.set(tabId, current)
    }
    const candidate = incomingTabs.get(tabId)
    if (
      !candidate ||
      !Number.isSafeInteger(candidate.workspaceMoveRevision) ||
      candidate.workspaceMoveRevision === undefined ||
      candidate.workspaceMoveRevision <= (current.workspaceMoveRevision ?? 0) ||
      !Object.hasOwn(incoming.tabsByWorktree, current.worktreeId) ||
      !(incoming.tabsByWorktree[candidate.worktreeId] ?? []).includes(candidate) ||
      current.ptyId !== candidate.ptyId ||
      getPtyExecutionHost(current.ptyId) !== null ||
      getPtyExecutionHost(prior.remoteSessionIdsByTabId?.[tabId]) !== null ||
      getPtyExecutionHost(incoming.remoteSessionIdsByTabId?.[tabId]) !== null ||
      !candidate.relocatedFromWorktreeIds?.includes(current.worktreeId)
    ) {
      continue
    }
    const admittedTab = {
      ...current,
      worktreeId: candidate.worktreeId,
      workspaceMoveRevision: candidate.workspaceMoveRevision,
      relocatedFromWorktreeIds: candidate.relocatedFromWorktreeIds
    }
    if (candidate.worktreeId === current.worktreeId) {
      admitted = {
        ...admitted,
        tabsByWorktree: {
          ...admitted.tabsByWorktree,
          [current.worktreeId]: admitted.tabsByWorktree[current.worktreeId].map((tab) =>
            tab.id === tabId ? admittedTab : tab
          )
        }
      }
      continue
    }
    incomingSurfaces ??= indexPersistedPtySurfaceBindings({
      ...incoming,
      terminalPtyIncarnationsByPaneKey: {
        ...prior.terminalPtyIncarnationsByPaneKey,
        ...incoming.terminalPtyIncarnationsByPaneKey
      }
    })
    const surfaces = incomingSurfaces
    const layout = prior.terminalLayoutsByTabId?.[tabId]
    const incomingLayout = incoming.terminalLayoutsByTabId?.[tabId]
    const leaves = collectLayoutLeafIdsInOrder(layout?.root)
    const nextLeaves = collectLayoutLeafIdsInOrder(incomingLayout?.root)
    if (
      leaves.length === 0 ||
      new Set(leaves).size !== leaves.length ||
      leaves.length !== nextLeaves.length ||
      !leaves.every((leafId) => nextLeaves.includes(leafId)) ||
      !leaves.every((leafId) => {
        const ptyId = layout?.ptyIdsByLeafId?.[leafId]
        const incarnationId = prior.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`]
        const surface = ptyId ? surfaces.get(ptyId) : undefined
        if (!ptyId) {
          return incomingLayout?.ptyIdsByLeafId?.[leafId] === undefined
        }
        return (
          Boolean(ptyId && incarnationId) &&
          getPtyExecutionHost(ptyId) === null &&
          incomingLayout?.ptyIdsByLeafId?.[leafId] === ptyId &&
          surface?.worktreeId === candidate.worktreeId &&
          surface?.paneKey === `${tabId}:${leafId}` &&
          hasPersistedTerminalMoveEvidence(surface, incarnationId, current.worktreeId, null)
        )
      })
    ) {
      continue
    }
    rejected.delete(tabId)
    // Moving a tab must not fence unrelated future tab or pane creation.
    admitted = {
      ...admitted,
      tabsByWorktree: {
        ...admitted.tabsByWorktree,
        [current.worktreeId]: admitted.tabsByWorktree[current.worktreeId].filter(
          (tab) => tab.id !== tabId
        ),
        [candidate.worktreeId]: [
          ...(admitted.tabsByWorktree[candidate.worktreeId] ?? []),
          admittedTab
        ]
      }
    }
  }
  const corrected = restoreRejectedWorkspaceTerminalMoves(incoming, prior, rejected)
  const owners = uniqueTabs(admitted)
  return {
    prior: admitted,
    session: {
      ...corrected,
      tabsByWorktree: Object.fromEntries(
        Object.entries(corrected.tabsByWorktree).map(([worktreeId, tabs]) => [
          worktreeId,
          tabs.map((tab) => {
            const owner = owners.get(tab.id)
            return owner?.workspaceMoveRevision !== undefined && owner.worktreeId === worktreeId
              ? {
                  ...tab,
                  workspaceMoveRevision: owner.workspaceMoveRevision,
                  relocatedFromWorktreeIds: owner.relocatedFromWorktreeIds
                }
              : tab
          })
        ])
      )
    }
  }
}
