import { describe, expect, it } from 'vitest'
import { workspacePaneDropTarget } from './workspace-pane-drop-target'

describe('pane swap and quadrant drop previews', () => {
  const root = { left: 0, top: 0, right: 1200, bottom: 800 }
  it('offers a whole-slot swap in an occupied quadrant center', () => {
    const pane = { left: 600, top: 0, right: 1200, bottom: 400 }
    expect(workspacePaneDropTarget(root, pane, 900, 200, 4, true).placement).toEqual({
      kind: 'swap'
    })
    expect(workspacePaneDropTarget(root, pane, 900, 200, 4, false).placement).toBeUndefined()
    expect(workspacePaneDropTarget(root, pane, 610, 200, 4, true).placement).toBeUndefined()
  })
  it('shows a full bottom-right quadrant when leaving three tall columns', () => {
    const pane = { left: 900, top: 0, right: 1200, bottom: 800 }
    expect(workspacePaneDropTarget(root, pane, 1100, 700, 4, true).placement).toEqual({
      kind: 'quadrant',
      quadrant: 'bottom-right'
    })
  })
  it.each([3, 4])('retains local top splits on tall columns with %i panes', (count) => {
    const pane = { left: 600, top: 0, right: 1200, bottom: 800 }
    expect(workspacePaneDropTarget(root, pane, 900, 100, count, true)).toEqual({
      edge: 'top',
      wholeWindow: false
    })
  })
  it('retains a local left split on the top of a two-row layout', () => {
    const pane = { left: 0, top: 0, right: 1200, bottom: 400 }
    expect(workspacePaneDropTarget(root, pane, 100, 200, 3, false)).toEqual({
      edge: 'left',
      wholeWindow: false
    })
  })
  it.each([
    [100, 100, 'top-left'],
    [1100, 100, 'top-right'],
    [100, 700, 'bottom-left'],
    [1100, 700, 'bottom-right']
  ] as const)('reaches a quadrant at window corner %i,%i', (x, y, quadrant) => {
    expect(workspacePaneDropTarget(root, root, x, y, 4, true).placement).toEqual({
      kind: 'quadrant',
      quadrant
    })
  })
  it('keeps whole-width and whole-height halves reachable at edge midpoints', () => {
    const pane = { ...root, left: 600 }
    expect(workspacePaneDropTarget(root, pane, 1190, 400, 4, true)).toEqual({
      edge: 'right',
      wholeWindow: true
    })
    expect(workspacePaneDropTarget(root, pane, 600, 790, 4, true)).toEqual({
      edge: 'bottom',
      wholeWindow: true
    })
  })
})
