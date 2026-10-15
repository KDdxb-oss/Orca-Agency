import type { WorkspaceSplitEdge } from '@/lib/workspace-split-layout'
import { cn } from '@/lib/utils'
import type { WorkspaceQuadrant } from '@/lib/workspace-pane-placement'

export function WorkspaceDropPreview({
  edge,
  quadrant
}: {
  edge?: WorkspaceSplitEdge
  quadrant?: WorkspaceQuadrant
}) {
  return (
    <div
      data-workspace-window-drop={edge}
      data-workspace-quadrant-drop={quadrant}
      className={cn(
        'pointer-events-none absolute z-50 border-2 border-primary bg-primary/15',
        edge === 'left' && 'inset-y-0 left-0 w-1/2',
        edge === 'right' && 'inset-y-0 right-0 w-1/2',
        edge === 'top' && 'inset-x-0 top-0 h-1/2',
        edge === 'bottom' && 'inset-x-0 bottom-0 h-1/2',
        quadrant && 'w-1/2 h-1/2',
        quadrant?.startsWith('top') && 'top-0',
        quadrant?.startsWith('bottom') && 'bottom-0',
        quadrant?.endsWith('left') && 'left-0',
        quadrant?.endsWith('right') && 'right-0'
      )}
    />
  )
}
