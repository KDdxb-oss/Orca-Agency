import {
  readWorkspaceDragData,
  WORKSPACE_STATUS_DRAG_TYPE
} from '../sidebar/workspace-status-drag-data'

/** Chromium protects getData during dragover; dragstart still exposes the source. */
export function captureNativeWorkspaceDragSource() {
  let source: string | null = null
  const start = (event: DragEvent) => {
    source = event.dataTransfer?.types.includes(WORKSPACE_STATUS_DRAG_TYPE)
      ? readWorkspaceDragData(event.dataTransfer)
      : null
  }
  const clear = () => {
    source = null
  }
  document.addEventListener('dragstart', start)
  document.addEventListener('dragend', clear)
  return {
    sourceId: () => source,
    dispose: () => {
      document.removeEventListener('dragstart', start)
      document.removeEventListener('dragend', clear)
      clear()
    }
  }
}
