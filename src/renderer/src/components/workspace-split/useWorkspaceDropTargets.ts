import { useEffect, type RefObject, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import {
  collectWorkspaceIds,
  findWorkspaceSplitGroup,
  MAX_WORKSPACE_PANES,
  type WorkspaceSplitEdge
} from '@/lib/workspace-split-layout'
import { readWorkspaceDragData, WORKSPACE_STATUS_DRAG_TYPE } from '../sidebar/workspace-status'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { toast } from 'sonner'
import {
  WORKSPACE_PANE_POINTER_CLEAR,
  WORKSPACE_PANE_POINTER_DROP,
  WORKSPACE_PANE_POINTER_MOVE,
  readWorkspacePanePointerDetail
} from './workspace-pane-pointer-drag'
import { workspaceDropSurface } from './workspace-drop-surface'
import { workspacePaneDropTarget } from './workspace-pane-drop-target'
import type { WorkspacePanePlacement } from '@/lib/workspace-pane-placement'
import {
  workspaceTabStripDropTarget,
  workspaceForeignTabStripAtPoint,
  dropTerminalTabIntoWorkspaceStrip,
  type WorkspaceTabStripDrop
} from './workspace-tab-strip-drop'
import {
  canDropTerminalTabAtWorkspaceEdge,
  dropTerminalTabAtWorkspaceEdge
} from './workspace-tab-edge-drop'
import { captureNativeWorkspaceDragSource } from './workspace-native-drag-source'

export type WorkspaceDropHover = {
  id: string
  edge: WorkspaceSplitEdge
  wholeWindow: boolean
  placement?: WorkspacePanePlacement
  strip?: WorkspaceTabStripDrop
}

export function useWorkspaceDropTargets(
  rootRef: RefObject<HTMLDivElement | null>,
  visibleIdsKey: string,
  rendersRoot: boolean,
  setHover: Dispatch<SetStateAction<WorkspaceDropHover | null>>
): void {
  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    const ids = new Set(visibleIdsKey.split('\u0000').filter(Boolean))
    const nativeDrag = captureNativeWorkspaceDragSource()
    const dropTarget = (
      surface: HTMLElement,
      x: number,
      y: number,
      sourceId?: string,
      unifiedTabId?: string
    ) => ({
      id: surface.dataset.workspaceSurfaceId!,
      ...workspacePaneDropTarget(
        root.getBoundingClientRect(),
        surface.getBoundingClientRect(),
        x,
        y,
        ids.size +
          (sourceId &&
          (!ids.has(sourceId) ||
            (unifiedTabId && (useAppStore.getState().tabsByWorktree[sourceId]?.length ?? 0) > 1))
            ? 1
            : 0),
        Boolean(
          sourceId &&
          ids.has(sourceId) &&
          sourceId !== surface.dataset.workspaceSurfaceId &&
          (!unifiedTabId || (useAppStore.getState().tabsByWorktree[sourceId]?.length ?? 0) <= 1)
        )
      )
    })
    const surfaceAtPoint = (element: Element | null, x: number, y: number) =>
      workspaceDropSurface(root, ids, element, x, y)
    const targetSurface = (event: DragEvent): HTMLElement | null =>
      Array.from(event.dataTransfer?.types ?? []).includes(WORKSPACE_STATUS_DRAG_TYPE)
        ? surfaceAtPoint(
            event.target instanceof Element ? event.target : null,
            event.clientX,
            event.clientY
          )
        : null
    const pointerSurface = (x: number, y: number): HTMLElement | null => {
      return surfaceAtPoint(document.elementFromPoint(x, y), x, y)
    }
    const overSourceTabStrip = (sourceId: string, surface: HTMLElement, x: number, y: number) =>
      surface.dataset.workspaceSurfaceId === sourceId &&
      Boolean(document.elementFromPoint(x, y)?.closest('[data-tab-group-strip-id]'))
    const placeWorkspace = (sourceId: string, surface: HTMLElement, x: number, y: number) => {
      const targetId = surface.dataset.workspaceSurfaceId!
      const target = dropTarget(surface, x, y, sourceId)
      if (sourceId === targetId && !target.wholeWindow && !target.placement) {
        return
      }
      const state = useAppStore.getState()
      const existingGroup = findWorkspaceSplitGroup(state.workspaceSplitGroups, targetId)
      if (
        existingGroup &&
        !collectWorkspaceIds(existingGroup.layout).includes(sourceId) &&
        collectWorkspaceIds(existingGroup.layout).length >= MAX_WORKSPACE_PANES
      ) {
        toast.error(`A split can contain up to ${MAX_WORKSPACE_PANES} workspaces`)
        return
      }
      if (activateAndRevealWorkspace(sourceId, { revealInSidebar: false }) !== false) {
        if (target.placement) {
          useAppStore.getState().placeWorkspacePane(sourceId, targetId, target.placement)
        } else {
          useAppStore
            .getState()
            .placeWorkspaceAtEdge(sourceId, targetId, target.edge, target.wholeWindow)
        }
      }
    }
    const onDragOver = (event: DragEvent) => {
      const surface = targetSurface(event)
      if (!surface || !event.dataTransfer) {
        setHover(null)
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const next = dropTarget(
        surface,
        event.clientX,
        event.clientY,
        nativeDrag.sourceId() ?? readWorkspaceDragData(event.dataTransfer) ?? undefined
      )
      setHover((previous) =>
        previous?.id === next.id &&
        previous.edge === next.edge &&
        previous.wholeWindow === next.wholeWindow &&
        JSON.stringify(previous.placement) === JSON.stringify(next.placement) &&
        !previous.strip
          ? previous
          : next
      )
    }
    const onDrop = (event: DragEvent) => {
      const surface = targetSurface(event)
      setHover(null)
      if (!surface || !event.dataTransfer) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const sourceId = readWorkspaceDragData(event.dataTransfer)
      if (!sourceId) {
        return
      }
      placeWorkspace(sourceId, surface, event.clientX, event.clientY)
    }
    const onDragEnd = () => setHover(null)
    const onPointerMove = (event: Event) => {
      const detail = readWorkspacePanePointerDetail(event)
      if (!detail) {
        return
      }
      const { sourceId, x, y } = detail
      const strip = detail.unifiedTabId
        ? workspaceTabStripDropTarget(sourceId, detail.unifiedTabId, x, y)
        : null
      if (strip) {
        event.preventDefault()
        setHover({ id: strip.targetId, edge: 'top', wholeWindow: false, strip })
        return
      }
      if (detail.unifiedTabId && workspaceForeignTabStripAtPoint(sourceId, x, y)) {
        event.preventDefault()
        setHover(null)
        return
      }
      if (
        detail.unifiedTabId &&
        !canDropTerminalTabAtWorkspaceEdge(sourceId, detail.unifiedTabId)
      ) {
        setHover(null)
        return
      }
      const surface = pointerSurface(x, y)
      if (!surface || (detail.unifiedTabId && overSourceTabStrip(sourceId, surface, x, y))) {
        setHover(null)
        return
      }
      const next = dropTarget(surface, x, y, sourceId, detail.unifiedTabId)
      if (next.id === sourceId && !next.wholeWindow && !next.placement) {
        setHover(null)
        return
      }
      event.preventDefault()
      setHover((previous) =>
        previous?.id === next.id &&
        previous.edge === next.edge &&
        previous.wholeWindow === next.wholeWindow &&
        JSON.stringify(previous.placement) === JSON.stringify(next.placement) &&
        !previous.strip
          ? previous
          : next
      )
    }
    const onPointerDrop = (event: Event) => {
      const detail = readWorkspacePanePointerDetail(event)
      if (!detail) {
        return
      }
      const { sourceId, x, y } = detail
      const strip = detail.unifiedTabId
        ? workspaceTabStripDropTarget(sourceId, detail.unifiedTabId, x, y)
        : null
      if (strip && detail.unifiedTabId) {
        event.preventDefault()
        setHover(null)
        void dropTerminalTabIntoWorkspaceStrip(sourceId, detail.unifiedTabId, strip).catch(
          (error: unknown) =>
            toast.error(error instanceof Error ? error.message : 'Could not combine chats.')
        )
        return
      }
      if (detail.unifiedTabId && workspaceForeignTabStripAtPoint(sourceId, x, y)) {
        event.preventDefault()
        setHover(null)
        return
      }
      if (
        detail.unifiedTabId &&
        !canDropTerminalTabAtWorkspaceEdge(sourceId, detail.unifiedTabId)
      ) {
        setHover(null)
        return
      }
      const surface = pointerSurface(x, y)
      setHover(null)
      if (!surface || (detail.unifiedTabId && overSourceTabStrip(sourceId, surface, x, y))) {
        return
      }
      const target = dropTarget(surface, x, y, sourceId, detail.unifiedTabId)
      if (target.id === sourceId && !target.wholeWindow && !target.placement) {
        return
      }
      event.preventDefault()
      if (detail.unifiedTabId) {
        void dropTerminalTabAtWorkspaceEdge({
          sourceId,
          unifiedTabId: detail.unifiedTabId,
          targetId: target.id,
          edge: target.edge,
          wholeWindow: target.wholeWindow,
          placement: target.placement
        }).catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : 'Could not move chat.')
        )
        return
      }
      placeWorkspace(sourceId, surface, x, y)
    }
    const onPointerClear = () => setHover(null)
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('dragend', onDragEnd, true)
    document.addEventListener(WORKSPACE_PANE_POINTER_MOVE, onPointerMove)
    document.addEventListener(WORKSPACE_PANE_POINTER_DROP, onPointerDrop)
    document.addEventListener(WORKSPACE_PANE_POINTER_CLEAR, onPointerClear)
    return () => {
      nativeDrag.dispose()
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('dragend', onDragEnd, true)
      document.removeEventListener(WORKSPACE_PANE_POINTER_MOVE, onPointerMove)
      document.removeEventListener(WORKSPACE_PANE_POINTER_DROP, onPointerDrop)
      document.removeEventListener(WORKSPACE_PANE_POINTER_CLEAR, onPointerClear)
    }
  }, [visibleIdsKey, rendersRoot, rootRef, setHover])
}
