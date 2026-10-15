import { describe, expect, it } from 'vitest'
import { placeWorkspacePane } from './workspace-pane-placement'
import {
  collectWorkspaceIds,
  placeWorkspaceAtEdge,
  setWorkspaceSplitRatio
} from './workspace-split-layout'

const grid = () => {
  let groups = placeWorkspaceAtEdge([], 'b', 'a', 'right', 'grid')
  groups = placeWorkspaceAtEdge(groups, 'c', 'a', 'bottom', 'unused')
  return placeWorkspaceAtEdge(groups, 'd', 'b', 'bottom', 'unused')
}

describe('repositioning whole workspace panes', () => {
  it('keeps the bottom half intact when a third pane moves to the top-left', () => {
    const original = placeWorkspaceAtEdge([], 'b', 'a', 'bottom', 'grid')
    const placed = placeWorkspacePane(
      original,
      'c',
      'a',
      { kind: 'quadrant', quadrant: 'top-left' },
      'unused'
    )
    expect(placed[0].layout).toMatchObject({
      direction: 'vertical',
      first: {
        direction: 'horizontal',
        first: { workspaceId: 'c' },
        second: { workspaceId: 'a' }
      },
      second: { type: 'leaf', workspaceId: 'b' }
    })
  })
  it('preserves row orientation when moving a lower pane into a top corner', () => {
    const original = placeWorkspaceAtEdge(
      placeWorkspaceAtEdge([], 'b', 'a', 'bottom', 'grid'),
      'c',
      'b',
      'right',
      'unused'
    )
    const placed = placeWorkspacePane(
      original,
      'b',
      'a',
      { kind: 'quadrant', quadrant: 'top-left' },
      'unused'
    )
    expect(placed[0].layout).toMatchObject({
      direction: 'vertical',
      first: { direction: 'horizontal', first: { workspaceId: 'b' }, second: { workspaceId: 'a' } },
      second: { type: 'leaf', workspaceId: 'c' }
    })
  })
  it('minimizes total movement when a fourth pane joins three rows', () => {
    const original = placeWorkspaceAtEdge(
      placeWorkspaceAtEdge([], 'b', 'a', 'bottom', 'grid'),
      'c',
      'b',
      'bottom',
      'unused'
    )
    const placed = placeWorkspacePane(
      original,
      'd',
      'c',
      { kind: 'quadrant', quadrant: 'bottom-right' },
      'unused'
    )
    expect(placed[0].layout).toMatchObject({
      direction: 'horizontal',
      first: { direction: 'vertical', first: { workspaceId: 'a' }, second: { workspaceId: 'c' } },
      second: { direction: 'vertical', first: { workspaceId: 'b' }, second: { workspaceId: 'd' } }
    })
  })
  it('keeps the left pane in place when adding a third pane at the top-right', () => {
    const original = placeWorkspaceAtEdge([], 'b', 'a', 'right', 'grid')
    const placed = placeWorkspacePane(
      original,
      'c',
      'b',
      {
        kind: 'quadrant',
        quadrant: 'top-right'
      },
      'unused'
    )
    expect(placed[0].layout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', workspaceId: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', workspaceId: 'c' },
        second: { type: 'leaf', workspaceId: 'b' }
      }
    })
  })
  it('keeps the right pane as the partner when moving from the left column', () => {
    const original = placeWorkspaceAtEdge(
      placeWorkspaceAtEdge([], 'c', 'a', 'right', 'grid'),
      'b',
      'a',
      'bottom',
      'unused'
    )
    const placed = placeWorkspacePane(
      original,
      'a',
      'c',
      {
        kind: 'quadrant',
        quadrant: 'top-right'
      },
      'unused'
    )
    expect(placed[0].layout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', workspaceId: 'b' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', workspaceId: 'a' },
        second: { type: 'leaf', workspaceId: 'c' }
      }
    })
  })
  it('swaps occupied quadrants while retaining sizes, identities and the other panes', () => {
    const original = setWorkspaceSplitRatio(grid(), 'grid', [], 0.6)
    const swapped = placeWorkspacePane(original, 'd', 'b', { kind: 'swap' }, 'unused')
    expect(collectWorkspaceIds(swapped[0].layout)).toEqual(['a', 'c', 'd', 'b'])
    expect(swapped[0].layout).toMatchObject({ ratio: 0.6 })
    expect(placeWorkspacePane(swapped, 'd', 'b', { kind: 'swap' }, 'unused')).toEqual(original)
  })
  it.each(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const)(
    'moves a full-height column into %s',
    (quadrant) => {
      const columns = placeWorkspaceAtEdge(grid(), 'b', 'd', 'left', 'unused')
      const placed = placeWorkspacePane(columns, 'b', 'd', { kind: 'quadrant', quadrant }, 'unused')
      expect(collectWorkspaceIds(placed[0].layout).sort()).toEqual(['a', 'b', 'c', 'd'])
      const layout = placed[0].layout
      if (layout.type !== 'split') {
        throw new Error('No grid')
      }
      const column = quadrant.endsWith('left') ? layout.first : layout.second
      if (column.type !== 'split') {
        throw new Error('No quadrant')
      }
      expect(quadrant.startsWith('top') ? column.first : column.second).toEqual({
        type: 'leaf',
        workspaceId: 'b'
      })
      expect(layout.ratio).toBe(0.5)
      expect(column.ratio).toBe(0.5)
    }
  )
  it('retains all remaining panes and independent groups when forming a quadrant', () => {
    let groups = placeWorkspaceAtEdge(grid(), 'e', 'a', 'left', 'unused')
    groups = placeWorkspaceAtEdge(groups, 'y', 'x', 'bottom', 'other')
    const placed = placeWorkspacePane(
      groups,
      'd',
      'b',
      { kind: 'quadrant', quadrant: 'bottom-right' },
      'unused'
    )
    expect(collectWorkspaceIds(placed[0].layout).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(placed[1]).toBe(groups[1])
  })
})
