import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import { selectParkedEquivalentMountTabIds } from './terminal/startup-terminal-tab-hold'
import type { TerminalController } from './use-terminal-controller'
import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  useWorkspaceDropTargets,
  type WorkspaceDropHover
} from './workspace-split/useWorkspaceDropTargets'
import { collectWorkspaceIds } from '@/lib/workspace-split-layout'
import {
  WorkspaceSplitLayoutSlots,
  type WorkspacePaneRect
} from './workspace-split/WorkspaceSplitLayoutSlots'
import { WorkspaceDropPreview } from './workspace-split/WorkspaceDropPreview'
import { workspaceTouchesWindowEdge } from './workspace-split/workspace-window-edges'

export function TerminalSplitWorkspaceSurfaces({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const {
    activationDeferredMountTabIdsByWorktreeRef,
    activeGroupIdByWorktree,
    activeView,
    activityTerminalPortals,
    anyMountedWorktreeHasLayout,
    backgroundMountTabIdsByWorktreeRef,
    effectiveActiveLayout,
    effectiveParkedTerminalWorktreeIds,
    forceParkedTerminalWorktreeIds,
    getEffectiveLayoutForWorktree,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    visibleWorkspaceSplitGroup,
    startupTerminalTabHold,
    workspaceSurfaces
  } = controller
  const rootRef = useRef<HTMLDivElement>(null)
  const [paneRects, setPaneRects] = useState<Map<string, WorkspacePaneRect>>(() => new Map())
  const [hover, setHover] = useState<WorkspaceDropHover | null>(null)
  const onRatioChange = useCallback(
    (path: readonly ('first' | 'second')[], ratio: number) => {
      if (visibleWorkspaceSplitGroup) {
        useAppStore.getState().setWorkspaceSplitRatio(visibleWorkspaceSplitGroup.id, path, ratio)
      }
    },
    [visibleWorkspaceSplitGroup]
  )
  // Why: this and TerminalSurface are both strict ancestors of every browser <webview>, so a
  // remote controller needs each to drop `hidden` — the per-worktree surface hatch below cannot
  // override an ancestor that stopped compositing.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  const mountedSurfaces = workspaceSurfaces.filter((workspace) =>
    mountedWorktreeIdsRef.current.has(workspace.id)
  )
  const group =
    activeView === 'terminal' &&
    visibleWorkspaceSplitGroup &&
    collectWorkspaceIds(visibleWorkspaceSplitGroup.layout).every((id) =>
      mountedSurfaces.some((workspace) => workspace.id === id)
    )
      ? visibleWorkspaceSplitGroup
      : null
  const visibleIds =
    activeView === 'terminal'
      ? group
        ? collectWorkspaceIds(group.layout)
        : renderedActiveWorktreeId
          ? [renderedActiveWorktreeId]
          : []
      : []
  const visibleIdsKey = visibleIds.join('\u0000')
  // Why: the root below mounts only once a layout exists. Keying the listener effect on
  // it re-attaches drop handling when the root appears after the visible ids settled.
  const rendersRoot = anyMountedWorktreeHasLayout || group !== null
  useWorkspaceDropTargets(rootRef, visibleIdsKey, rendersRoot, setHover)
  if (!rendersRoot) {
    return null
  }
  const renderSurface = (workspace: (typeof workspaceSurfaces)[number], isVisible: boolean) => {
    const layout = getEffectiveLayoutForWorktree(workspace.id)
    const shouldMeasureHiddenWorktree =
      !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
    const shouldColdParkTerminalPanes =
      !isVisible &&
      !shouldMeasureHiddenWorktree &&
      effectiveParkedTerminalWorktreeIds.has(workspace.id)
    return (
      <WorktreeSplitSurface
        key={`tab-groups-${workspace.id}`}
        worktreeId={workspace.id}
        worktreePath={workspace.path}
        layout={layout ?? null}
        focusedGroupId={activeGroupIdByWorktree[workspace.id]}
        isVisible={isVisible}
        isFocused={isVisible && workspace.id === renderedActiveWorktreeId}
        isMultiPane={group !== null && isVisible}
        reserveLeftWindowChrome={
          !group ||
          (workspaceTouchesWindowEdge(group.layout, workspace.id, 'top') &&
            workspaceTouchesWindowEdge(group.layout, workspace.id, 'left'))
        }
        reserveRightWindowChrome={
          !group ||
          (workspaceTouchesWindowEdge(group.layout, workspace.id, 'top') &&
            workspaceTouchesWindowEdge(group.layout, workspace.id, 'right'))
        }
        hoverEdge={
          hover?.id === workspace.id && !hover.wholeWindow && !hover.placement && !hover.strip
            ? hover.edge
            : null
        }
        hoverSwap={hover?.id === workspace.id && hover.placement?.kind === 'swap'}
        paneRect={group && isVisible ? paneRects.get(workspace.id) : undefined}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={forceParkedTerminalWorktreeIds.has(workspace.id)}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null}
        activationDeferredMountTabIds={selectParkedEquivalentMountTabIds(
          activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id),
          startupTerminalTabHold,
          workspace.id
        )}
      />
    )
  }
  return (
    <div
      ref={rootRef}
      data-workspace-split-root="true"
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${
        effectiveActiveLayout || group
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
    >
      {group ? (
        <WorkspaceSplitLayoutSlots
          layout={group.layout}
          onRectsChange={setPaneRects}
          onRatioChange={onRatioChange}
        />
      ) : null}
      {mountedSurfaces.map((workspace) =>
        renderSurface(
          workspace,
          activeView === 'terminal' &&
            (group
              ? collectWorkspaceIds(group.layout).includes(workspace.id)
              : workspace.id === renderedActiveWorktreeId)
        )
      )}
      {hover?.wholeWindow ? <WorkspaceDropPreview edge={hover.edge} /> : null}
      {hover?.placement?.kind === 'quadrant' ? (
        <WorkspaceDropPreview quadrant={hover.placement.quadrant} />
      ) : null}
      {hover?.strip ? (
        <div
          data-workspace-tab-insertion={hover.strip.index}
          className="pointer-events-none fixed z-50 border-l-2 border-primary"
          style={{ left: hover.strip.left, top: hover.strip.top, height: hover.strip.height }}
        >
          <span className="absolute -left-1.5 -top-1 text-xs text-primary">▼</span>
        </div>
      ) : null}
    </div>
  )
}
