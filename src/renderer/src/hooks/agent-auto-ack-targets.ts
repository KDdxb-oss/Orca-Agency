import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isStructuredTab } from '@/components/native-chat/structured-agent-session-tabs'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { SessionGridFilter } from '../../../shared/session-grid-types'
import {
  selectFloatingWorkspacePanelVisible,
  type FloatingWorkspacePanelVisibilityState
} from '@/store/floating-workspace-panel-selector'

export type AutoAckTabTarget = {
  tabId: string
  worktreeId: string | null
  /** Which adapter owns `tabId`: a terminal tab id, or a structured chat's unified tab id. */
  surfaceKind: 'terminal' | 'structured'
  viewOrigin?: 'session-grid'
}

export type AutoAckTargetState = FloatingWorkspacePanelVisibilityState & {
  activeView: string
  activeWorktreeId: string | null
  activeSessionGridWorktreeId?: string | null
  activeSessionGridTabId: string | null
  sessionsGridFilter: SessionGridFilter
  sessionsGridHiddenTabIds: readonly string[]
  tabsByWorktree: Record<string, TerminalTab[]>
  getActiveTab: (worktreeId: string) => Tab | null
}

function sessionGridSelectionOnTheBoard(
  state: AutoAckTargetState,
  tabId: string
): AutoAckTabTarget | null {
  if (state.sessionsGridHiddenTabIds.includes(tabId)) {
    return null
  }
  let worktreeId = state.activeSessionGridWorktreeId
  if (worktreeId == null) {
    const owners = Object.keys(state.tabsByWorktree).filter((id) =>
      state.tabsByWorktree[id].some((tab) => tab.id === tabId)
    )
    if (owners.length !== 1) {
      return null
    }
    worktreeId = owners[0]
  }
  if (!worktreeId || !state.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
    return null
  }
  const filter = state.sessionsGridFilter
  if (
    filter !== 'all' &&
    (state.tabsByWorktree[filter]?.length ?? 0) > 0 &&
    worktreeId !== filter
  ) {
    return null
  }
  return { tabId, worktreeId, surfaceKind: 'terminal', viewOrigin: 'session-grid' }
}

/**
 * The one surface a workspace has on screen right now.
 *
 * Why the unified tab wins: a visible chat replaces the terminal in its group, but the
 * workspace's terminal tab id keeps naming the terminal that was there before — acknowledging
 * that id would clear a hidden terminal's unread.
 */
function resolveWorkspaceAutoAckTarget(
  state: AutoAckTargetState,
  worktreeId: string
): AutoAckTabTarget | null {
  const activeTab = state.getActiveTab(worktreeId)
  if (activeTab && isStructuredTab(activeTab)) {
    return { tabId: activeTab.id, worktreeId, surfaceKind: 'structured' }
  }
  return activeTab?.contentType === 'terminal'
    ? { tabId: activeTab.entityId, worktreeId, surfaceKind: 'terminal' }
    : null
}

/**
 * Surfaces whose visible content counts as "seen" right now, each paired with the worktree that
 * owns it.
 *
 * Why the floating workspace is gated on panel visibility rather than `activeView`: the panel is an
 * overlay that sits above every view and stays mounted while closed, and its active tab never
 * becomes the global `activeTabId` — so neither the view nor the tab id can stand in for "on screen".
 */
export function resolveAutoAckTabTargets(
  state: AutoAckTargetState,
  options?: { floatingPanelVisible: boolean }
): AutoAckTabTarget[] {
  const targets: AutoAckTabTarget[] = []
  if (options?.floatingPanelVisible ?? selectFloatingWorkspacePanelVisible(state)) {
    const floating = resolveWorkspaceAutoAckTarget(state, FLOATING_TERMINAL_WORKTREE_ID)
    // The floating pane is on top when two worktrees claim the same tab ID.
    if (floating) {
      targets.push(floating)
    }
  }
  if (state.activeView === 'terminal') {
    const active = state.activeWorktreeId
      ? resolveWorkspaceAutoAckTarget(state, state.activeWorktreeId)
      : null
    if (active && !targets.some((target) => target.tabId === active.tabId)) {
      targets.push(active)
    }
  }
  if (state.activeView === 'sessions' && state.activeSessionGridTabId) {
    const gridTarget = sessionGridSelectionOnTheBoard(state, state.activeSessionGridTabId)
    if (gridTarget && !targets.some((target) => target.tabId === gridTarget.tabId)) {
      targets.push(gridTarget)
    }
  }
  return targets
}

/**
 * Whether a tab of either kind is on a visible surface — the one "did the user see it" rule.
 * Attention dispatch and auto-ack both read it, so a surface the user is watching neither earns
 * an unread marker nor has one to clear.
 */
export function isTabOnVisibleSurface(
  state: AutoAckTargetState,
  worktreeId: string,
  tabId: string,
  surfaceKind: AutoAckTabTarget['surfaceKind']
): boolean {
  return resolveAutoAckTabTargets(state).some(
    (target) =>
      target.surfaceKind === surfaceKind &&
      target.tabId === tabId &&
      target.worktreeId === worktreeId
  )
}
