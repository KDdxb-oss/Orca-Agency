import { describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const LEFT = 'repo1::/tmp/left'
const RIGHT = 'repo1::/tmp/right'
const MIDDLE = 'repo1::/tmp/middle'

function pairedStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: LEFT, repoId: 'repo1', path: '/tmp/left' }),
        makeWorktree({ id: RIGHT, repoId: 'repo1', path: '/tmp/right' })
      ]
    }
  })
  store.getState().createUnifiedTab(LEFT, 'editor', { id: 'left.md', label: 'left.md' })
  const right = store.getState().createUnifiedTab(RIGHT, 'editor', {
    id: 'right.md',
    label: 'right.md'
  })
  store.setState({ activeWorktreeId: RIGHT })
  vi.spyOn(store.getState(), 'setActiveWorktree').mockImplementation((id) => {
    store.setState({ activeWorktreeId: id })
    return true
  })
  store.getState().placeWorkspaceAtEdge(RIGHT, LEFT, 'bottom')
  return { store, right }
}

describe('closing tabs in a workspace split', () => {
  it('collapses the empty pane and selects the remaining workspace', () => {
    const { store, right } = pairedStore()

    store.getState().closeUnifiedTab(right.id)

    expect(store.getState().workspaceSplitGroups).toEqual([])
    expect(store.getState().activeWorktreeId).toBe(LEFT)
  })

  it('keeps the split while another tab remains', () => {
    const { store, right } = pairedStore()
    store.getState().createUnifiedTab(RIGHT, 'editor', { id: 'more.md', label: 'more.md' })

    store.getState().closeUnifiedTab(right.id)

    expect(store.getState().workspaceSplitGroups).toHaveLength(1)
  })

  it('collapses when the terminal close path removes the last tab', () => {
    const { store, right } = pairedStore()
    const terminal = store.getState().createTab(RIGHT)
    store.getState().closeUnifiedTab(right.id)
    store.getState().closeTab(terminal.id)
    expect(store.getState().workspaceSplitGroups).toEqual([])
    expect(store.getState().activeWorktreeId).toBe(LEFT)
  })

  it('keeps the split for a cleanup close that preserves workspace selection', () => {
    const { store, right } = pairedStore()

    store.getState().closeUnifiedTab(right.id, { preserveWorktreeSelection: true })

    expect(store.getState().workspaceSplitGroups).toHaveLength(1)
  })

  it('removes only the emptied middle pane from a three-workspace split', () => {
    const { store } = pairedStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: LEFT, repoId: 'repo1', path: '/tmp/left' }),
          makeWorktree({ id: RIGHT, repoId: 'repo1', path: '/tmp/right' }),
          makeWorktree({ id: MIDDLE, repoId: 'repo1', path: '/tmp/middle' })
        ]
      }
    })
    const middle = store.getState().createUnifiedTab(MIDDLE, 'editor', {
      id: 'middle.md',
      label: 'middle.md'
    })
    store.getState().placeWorkspaceAtEdge(MIDDLE, LEFT, 'right')
    store.setState({ activeWorktreeId: MIDDLE })

    store.getState().closeUnifiedTab(middle.id)

    const groups = store.getState().workspaceSplitGroups
    expect(groups).toHaveLength(1)
    expect(JSON.stringify(groups)).toContain(LEFT)
    expect(JSON.stringify(groups)).toContain(RIGHT)
    expect(JSON.stringify(groups)).not.toContain(MIDDLE)
    expect(store.getState().activeWorktreeId).toBe(LEFT)
    expect(store.getState().unifiedTabsByWorktree[LEFT]).toHaveLength(1)
    expect(store.getState().unifiedTabsByWorktree[RIGHT]).toHaveLength(1)
  })
})
