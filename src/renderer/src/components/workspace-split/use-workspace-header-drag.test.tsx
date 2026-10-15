// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { isWorkspaceHeaderDragTarget, useWorkspaceHeaderDrag } from './use-workspace-header-drag'

const drag = vi.hoisted(() => ({
  move: vi.fn(),
  drop: vi.fn(),
  clear: vi.fn(),
  release: vi.fn()
}))

vi.mock('./workspace-pane-pointer-drag', () => ({
  dispatchWorkspacePanePointerMove: drag.move,
  dispatchWorkspacePanePointerDrop: drag.drop,
  dispatchWorkspacePanePointerClear: drag.clear
}))
vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: () => drag.release
}))

function Header() {
  const onPointerDown = useWorkspaceHeaderDrag('source')
  return (
    <div data-testid="header" onPointerDown={onPointerDown}>
      <span>Drag surface</span>
      <button type="button">Excluded button</button>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mountedHeader(): HTMLElement {
  render(<Header />)
  const header = screen.getByTestId('header')
  Object.defineProperties(header, {
    hasPointerCapture: { value: () => false },
    setPointerCapture: { value: vi.fn() },
    releasePointerCapture: { value: vi.fn() }
  })
  return header
}

describe('workspace header pointer drag', () => {
  it('starts only past the threshold and drops into the selected pane', () => {
    const header = mountedHeader()
    fireEvent.pointerDown(header.querySelector('span')!, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 10
    })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 13, clientY: 13 })
    expect(drag.move).not.toHaveBeenCalled()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 20, clientY: 10 })
    expect(drag.move).toHaveBeenCalledWith({ sourceId: 'source', x: 20, y: 10 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 25, clientY: 20 })
    expect(drag.drop).toHaveBeenCalledWith({ sourceId: 'source', x: 25, y: 20 })
    expect(drag.release).toHaveBeenCalledOnce()
  })

  it('excludes controls and clears on Escape or lost pointer capture', () => {
    const header = mountedHeader()
    expect(isWorkspaceHeaderDragTarget(header.querySelector('button'))).toBe(false)
    fireEvent.pointerDown(screen.getByRole('button'), { button: 0, pointerId: 8 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 30, clientY: 30 })
    expect(drag.move).not.toHaveBeenCalled()
    fireEvent.pointerDown(header.querySelector('span')!, {
      button: 0,
      pointerId: 9,
      clientX: 0,
      clientY: 0
    })
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 9, clientY: 0 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 20, clientY: 0 })
    expect(drag.drop).not.toHaveBeenCalled()
    fireEvent.pointerDown(header.querySelector('span')!, {
      button: 0,
      pointerId: 10,
      clientX: 0,
      clientY: 0
    })
    fireEvent(header, new Event('lostpointercapture'))
    fireEvent.pointerMove(window, { pointerId: 10, clientX: 20, clientY: 0 })
    expect(drag.move).toHaveBeenCalledTimes(1)
  })
})
