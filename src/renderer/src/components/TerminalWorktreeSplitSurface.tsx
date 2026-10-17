import React from 'react'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { ActivityTerminalPortalTarget } from './activity/activity-terminal-portal'
import {
  useBrowserGuestPaintRetention,
  useWorktreeBrowserPageIds
} from './browser-pane/host-guest/browser-guest-paint-retention'
import {
  shouldKeepHiddenWorktreeSurfacePaintable,
  shouldMountRetainedBrowserOverlay
} from './browser-pane/host-guest/browser-worktree-surface-paintability'
import TabGroupSplitLayout from './tab-group/TabGroupSplitLayout'
import TerminalPaneOverlayLayer from './terminal-pane/TerminalPaneOverlayLayer'
import { RetainedBrowserPaneOverlayLayer } from './browser-pane/assemble-chrome/BrowserPaneOverlayLayer'
import EmulatorPaneOverlayLayer from './emulator-pane/EmulatorPaneOverlayLayer'
import StructuredAgentSessionPaneOverlayLayer from './native-chat/StructuredAgentSessionPaneOverlayLayer'
import AiVaultSessionDropLayer from './tab-group/AiVaultSessionDropLayer'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import type { WorkspaceSplitEdge } from '@/lib/workspace-split-layout'
import { useAppStore } from '@/store'
import { WorkspacePaneCloseButton } from './workspace-split/WorkspacePaneCloseButton'
import type { WorkspacePaneRect } from './workspace-split/WorkspaceSplitLayoutSlots'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  isFocused = isVisible,
  paneRect,
  isMultiPane = false,
  reserveLeftWindowChrome = true,
  reserveRightWindowChrome = true,
  hoverEdge,
  hoverSwap,
  shouldMeasureHiddenWorktree,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode | null
  focusedGroupId?: string
  isVisible: boolean
  isFocused?: boolean
  paneRect?: WorkspacePaneRect
  isMultiPane?: boolean
  reserveLeftWindowChrome?: boolean
  reserveRightWindowChrome?: boolean
  hoverEdge?: WorkspaceSplitEdge | null
  hoverSwap?: boolean
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    shouldMeasureHiddenWorktree,
    needsBrowserGuestPaint
  })
  const isPaintVisible = isVisible && (!isMultiPane || paneRect !== undefined)

  return (
    <div
      className={
        isPaintVisible
          ? 'absolute inset-0 flex'
          : shouldKeepPaintable
            ? 'absolute inset-0 flex opacity-0 pointer-events-none'
            : 'absolute inset-0 hidden'
      }
      style={
        isMultiPane && paneRect
          ? {
              top: paneRect.top,
              left: paneRect.left,
              width: paneRect.width,
              height: paneRect.height,
              right: 'auto',
              bottom: 'auto'
            }
          : undefined
      }
      data-workspace-surface-id={worktreeId}
      inert={!isPaintVisible}
      aria-hidden={!isPaintVisible}
      onPointerDownCapture={() => {
        if (isPaintVisible && useAppStore.getState().activeWorktreeId !== worktreeId) {
          activateAndRevealWorkspace(worktreeId, { revealInSidebar: false })
        }
      }}
    >
      {hoverSwap ? (
        <div
          data-workspace-drop-swap="true"
          className="pointer-events-none absolute inset-0 z-50 border-2 border-primary bg-primary/15"
        />
      ) : null}
      {hoverEdge ? (
        <div
          data-workspace-drop-edge={hoverEdge}
          className={`pointer-events-none absolute z-50 border-2 border-primary bg-primary/15 ${
            hoverEdge === 'left'
              ? 'inset-y-0 left-0 w-1/2'
              : hoverEdge === 'right'
                ? 'inset-y-0 right-0 w-1/2'
                : hoverEdge === 'top'
                  ? 'inset-x-0 top-0 h-1/2'
                  : 'inset-x-0 bottom-0 h-1/2'
          }`}
        />
      ) : null}
      {layout ? (
        <TabGroupSplitLayout
          layout={layout}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isVisible}
          isWorktreeFocused={isFocused}
          reserveLeftWindowChrome={reserveLeftWindowChrome}
          reserveRightWindowChrome={reserveRightWindowChrome}
        />
      ) : isVisible ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground"
          data-workspace-empty-pane={worktreeId}
        >
          <span>{worktreePath.split(/[\\/]/).findLast(Boolean) ?? worktreePath}</span>
          <WorkspacePaneCloseButton worktreeId={worktreeId} />
          <button
            type="button"
            className="rounded border border-border bg-card px-3 py-1.5 text-foreground hover:bg-accent"
            onClick={() => useAppStore.getState().createTab(worktreeId)}
          >
            New terminal
          </button>
        </div>
      ) : null}
      <TerminalPaneOverlayLayer
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isWorktreeActive={isVisible}
        isWorktreeFocused={isFocused}
        coldParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={isForceParked}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
      />
      <RetainedBrowserPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible}
        mountEligible={shouldMountRetainedBrowserOverlay({
          isWorktreeVisible: isVisible,
          hasDeferredBackgroundMounts: backgroundMountTabIds !== null,
          needsBrowserGuestPaint
        })}
      />
      {isVisible || backgroundMountTabIds === null ? (
        <EmulatorPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isVisible} />
      ) : null}
      <StructuredAgentSessionPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible}
      />
      <AiVaultSessionDropLayer worktreeId={worktreeId} enabled={isVisible} />
    </div>
  )
})
