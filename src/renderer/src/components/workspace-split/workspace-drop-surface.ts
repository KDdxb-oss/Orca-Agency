import { workspaceDropTarget } from './workspace-drop-target'

/** Only visible panes and outer divider endpoints can receive a workspace. */
export function workspaceDropSurface(
  root: HTMLElement,
  ids: ReadonlySet<string>,
  element: Element | null,
  x: number,
  y: number
): HTMLElement | null {
  const surface = element?.closest<HTMLElement>('[data-workspace-surface-id]')
  if (surface && root.contains(surface) && ids.has(surface.dataset.workspaceSurfaceId ?? '')) {
    return surface
  }
  const bounds = root.getBoundingClientRect()
  if (
    !element ||
    !root.contains(element) ||
    !workspaceDropTarget(bounds, bounds, x, y, ids.size > 1).wholeWindow
  ) {
    return null
  }
  let nearest: HTMLElement | null = null
  let distance = Infinity
  for (const candidate of root.querySelectorAll<HTMLElement>('[data-workspace-surface-id]')) {
    const rect = candidate.getBoundingClientRect()
    if (
      !ids.has(candidate.dataset.workspaceSurfaceId ?? '') ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue
    }
    const next =
      Math.max(rect.left - x, 0, x - rect.right) + Math.max(rect.top - y, 0, y - rect.bottom)
    if (next < distance) {
      nearest = candidate
      distance = next
    }
  }
  return nearest
}
