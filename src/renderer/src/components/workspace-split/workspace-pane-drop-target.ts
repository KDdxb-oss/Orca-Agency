import type { WorkspacePanePlacement, WorkspaceQuadrant } from '@/lib/workspace-pane-placement'
import { workspaceDropTarget } from './workspace-drop-target'

type Bounds = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>

export function workspacePaneDropTarget(
  root: Bounds,
  pane: Bounds,
  x: number,
  y: number,
  paneCount: number,
  canSwap: boolean
): ReturnType<typeof workspaceDropTarget> & { placement?: WorkspacePanePlacement } {
  const target = workspaceDropTarget(root, pane, x, y, paneCount > 1)
  const localX = (x - pane.left) / Math.max(1, pane.right - pane.left)
  const localY = (y - pane.top) / Math.max(1, pane.bottom - pane.top)
  const rootX = (x - root.left) / Math.max(1, root.right - root.left)
  const rootY = (y - root.top) / Math.max(1, root.bottom - root.top)
  const spansRoot =
    (Math.abs(pane.top - root.top) <= 1 && Math.abs(pane.bottom - root.bottom) <= 1) ||
    (Math.abs(pane.left - root.left) <= 1 && Math.abs(pane.right - root.right) <= 1)
  if (
    paneCount >= 3 &&
    spansRoot &&
    (rootX <= 0.15 || rootX >= 0.85) &&
    (rootY <= 0.15 || rootY >= 0.85) &&
    !target.wholeWindow
  ) {
    const quadrant: WorkspaceQuadrant =
      rootY < 0.5
        ? rootX < 0.5
          ? 'top-left'
          : 'top-right'
        : rootX < 0.5
          ? 'bottom-left'
          : 'bottom-right'
    return { ...target, wholeWindow: false, placement: { kind: 'quadrant', quadrant } }
  }
  if (canSwap && localX > 0.25 && localX < 0.75 && localY > 0.25 && localY < 0.75) {
    return { ...target, wholeWindow: false, placement: { kind: 'swap' } }
  }
  return target
}
