import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureNativeWorkspaceDragSource } from './workspace-native-drag-source'
import { WORKSPACE_STATUS_DRAG_TYPE } from '../sidebar/workspace-status-drag-data'

afterEach(() => vi.unstubAllGlobals())
describe('native workspace source capture', () => {
  it('keeps dragstart identity while Chromium protects dragover data, then clears it', () => {
    const document = new EventTarget()
    vi.stubGlobal('document', document)
    let readable = true
    const getData = vi.fn(() => (readable ? 'source-workspace' : ''))
    const tracking = captureNativeWorkspaceDragSource()
    const start = new Event('dragstart')
    Object.defineProperty(start, 'dataTransfer', {
      value: { types: [WORKSPACE_STATUS_DRAG_TYPE], getData }
    })
    document.dispatchEvent(start)
    readable = false
    expect(getData()).toBe('')
    expect(tracking.sourceId()).toBe('source-workspace')
    document.dispatchEvent(new Event('dragend'))
    expect(tracking.sourceId()).toBeNull()
    tracking.dispose()
    readable = true
    document.dispatchEvent(start)
    expect(tracking.sourceId()).toBeNull()
  })
})
