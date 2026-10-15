// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import type { RenderRow } from '../listing/render-row'
import { getShortcutPlatform } from '@/lib/shortcut-platform'

const activateAndRevealWorktree = vi.fn()
const updateWorktreeMeta = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: (...args: unknown[]) => activateAndRevealWorktree(...args)
}))

vi.mock('@/store', () => {
  const state = {
    keybindings: undefined,
    workspaceStatuses: [
      { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle' },
      { id: 'completed', label: 'Done', color: 'green', icon: 'check' }
    ],
    getKnownWorktreeById: (id: string) => ({ id, workspaceStatus: 'in-progress', hostId: 'local' }),
    updateWorktreeMeta
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})

const { useWorktreeListKeyboardNavigation } = await import('./use-keyboard')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const repo = { id: 'repo-1', path: '/repo-1', displayName: 'Repo 1' }

// Local worktrees carry no `hostId` — `withRepoHostOwnership` leaves them unqualified.
function localRow(id: string): HostSectionRow & { type: 'item' } {
  return {
    type: 'item',
    rowKey: `row:${id}`,
    sectionKey: 'repo:repo-1',
    worktree: { id, repoId: repo.id } as unknown as Worktree,
    repo: repo as never,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

const rows: HostSectionRow[] = [localRow('a'), localRow('b'), localRow('c')]
const renderRows = rows as unknown as RenderRow[]

let container: HTMLDivElement
let root: Root

function press(direction: 'up' | 'down'): void {
  const mod = getShortcutPlatform() === 'darwin' ? { metaKey: true } : { ctrlKey: true }
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: direction === 'down' ? 'ArrowDown' : 'ArrowUp',
        code: direction === 'down' ? 'ArrowDown' : 'ArrowUp',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...mod
      })
    )
  })
}

function renderProbe(activeWorktreeId: string, activeHostId: 'local' | null): void {
  function Probe() {
    const { handleContainerKeyDown } = useWorktreeListKeyboardNavigation({
      rows,
      renderRows,
      activeWorktreeId,
      activeWorkspaceExecutionHostId: activeHostId,
      pinnedDisplayPolicy: 'single-location',
      virtualizer: { scrollToIndex: () => {} } as never,
      scrollRef: { current: null },
      activeModal: 'none',
      markDirectScrollInput: () => {}
    })
    return <div data-testid="workspace-list" onKeyDown={handleContainerKeyDown} />
  }
  act(() => root.render(<Probe />))
}

beforeEach(() => {
  activateAndRevealWorktree.mockClear()
  updateWorktreeMeta.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('worktree keyboard cycling with a resolved active host', () => {
  it('steps to the next row when the active host resolved to local but rows are unqualified', () => {
    // Why: a sidebar click activates with the repo-resolved host (`local`), while
    // local rows carry no hostId; a raw identity compare misses and wraps to the top.
    renderProbe('b', 'local')

    press('down')

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('steps to the previous row when the active host resolved to local', () => {
    renderProbe('b', 'local')

    press('up')

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('a', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('still steps normally when the active host is unqualified', () => {
    renderProbe('b', null)

    press('down')

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('c', {
      navigationIntent: 'user-open',
      revealInSidebar: false
    })
  })

  it('moves the selected In progress workspace to Done only when Delete is pressed in the list', () => {
    renderProbe('b', 'local')
    const list = container.querySelector('[data-testid="workspace-list"]')!
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'b',
      { workspaceStatus: 'completed' },
      { executionHostId: 'local' }
    )

    updateWorktreeMeta.mockClear()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })
})
