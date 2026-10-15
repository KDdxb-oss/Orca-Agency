import type { TerminalDropPane, TerminalDropSurface } from './terminal-drop-surface'

export function resolveInternalTerminalDropPane(
  manager: TerminalDropSurface,
  dropTarget: EventTarget | null | undefined,
  paneLeafId?: string
): TerminalDropPane | null {
  const panes = manager.getPanes()
  if (paneLeafId !== undefined) {
    return panes.find((pane) => pane.leafId === paneLeafId) ?? null
  }
  if (dropTarget) {
    const targetedPane = panes.find((pane) => paneContainsDropTarget(pane, dropTarget))
    if (targetedPane) {
      return targetedPane
    }
  }
  return null
}

function paneContainsDropTarget(pane: TerminalDropPane, dropTarget: EventTarget): boolean {
  return (
    typeof Node !== 'undefined' && dropTarget instanceof Node && pane.container.contains(dropTarget)
  )
}
