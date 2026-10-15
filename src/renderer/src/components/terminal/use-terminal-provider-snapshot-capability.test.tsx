// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  clearTerminalProviderSnapshotCapabilities,
  collectTerminalProviderSnapshotPtyIds,
  synchronizeTerminalProviderSnapshotCapabilities,
  terminalProviderHasAuthoritativeSnapshot
} from './terminal-provider-snapshot-capability'

type HookStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null }[]>
  ptyIdsByTabId: Record<string, string[]>
  pendingReconnectPtyIdByTabId?: Record<string, string>
  terminalLayoutsByTabId?: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
}

const storeState: HookStoreState = {
  tabsByWorktree: {
    'repo::worktree': [{ id: 'tab-1', ptyId: 'repo::worktree@@pty-1' }]
  },
  ptyIdsByTabId: { 'tab-1': ['repo::worktree@@pty-1'] }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { useTerminalProviderSnapshotCapability } from './use-terminal-provider-snapshot-capability'

describe('useTerminalProviderSnapshotCapability', () => {
  const resolveCapabilities = vi.fn()

  beforeEach(() => {
    clearTerminalProviderSnapshotCapabilities()
    resolveCapabilities.mockReset()
    storeState.tabsByWorktree = {
      'repo::worktree': [{ id: 'tab-1', ptyId: 'repo::worktree@@pty-1' }]
    }
    storeState.ptyIdsByTabId = { 'tab-1': ['repo::worktree@@pty-1'] }
    ;(window as unknown as { api: unknown }).api = {
      pty: { getAuthoritativeBufferSnapshotCapabilities: resolveCapabilities }
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
    delete storeState.pendingReconnectPtyIdByTabId
    delete storeState.terminalLayoutsByTabId
  })

  // Why: synchronization PRUNES cached verdicts outside its collected set, so
  // the ongoing collector must gather the same fields startup does
  // (pending-reconnect and split-leaf layout ptys) or their startup answers
  // decay back into exempt-by-default unknown.
  it('keeps startup verdicts for split-leaf and pending-reconnect ptys alive', async () => {
    storeState.pendingReconnectPtyIdByTabId = { 'tab-2': 'repo::worktree@@restored' }
    storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { leaf: 'repo::worktree@@split' } }
    }
    const startupResolver = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    await synchronizeTerminalProviderSnapshotCapabilities(
      collectTerminalProviderSnapshotPtyIds(storeState),
      startupResolver
    )
    expect(terminalProviderHasAuthoritativeSnapshot('repo::worktree@@split')).toBe(true)
    resolveCapabilities.mockResolvedValue([])

    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await Promise.resolve()

    for (const ptyId of [
      'repo::worktree@@pty-1',
      'repo::worktree@@split',
      'repo::worktree@@restored'
    ]) {
      expect(terminalProviderHasAuthoritativeSnapshot(ptyId)).toBe(true)
    }
    hook.unmount()
  })

  // The selector must notice split bindings or it reuses a stale PTY list.
  it('re-collects when a split leaf pty appears in the layouts map', async () => {
    resolveCapabilities.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())

    storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { leaf: 'repo::worktree@@new-split' } }
    }
    hook.rerender()

    await waitFor(() =>
      expect(resolveCapabilities).toHaveBeenLastCalledWith(['repo::worktree@@new-split'])
    )
    hook.unmount()
  })

  it('preserves newline-bearing folder-workspace pty ids in the selector', async () => {
    const newlinePtyId = 'repo::folder\nname@@pty-1'
    storeState.tabsByWorktree = {
      'repo::folder\nname': [{ id: 'tab-1', ptyId: newlinePtyId }]
    }
    storeState.ptyIdsByTabId = { 'tab-1': [newlinePtyId] }
    resolveCapabilities.mockResolvedValue([{ id: newlinePtyId, authoritative: true }])

    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))

    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledWith([newlinePtyId]))
    hook.unmount()
  })

  // Each collected store map must invalidate the selector's cached PTY list.
  it('re-collects when each remaining collected store map changes', async () => {
    resolveCapabilities.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())

    storeState.pendingReconnectPtyIdByTabId = { 'tab-9': 'repo::worktree@@reconnect' }
    hook.rerender()
    await waitFor(() =>
      expect(resolveCapabilities).toHaveBeenLastCalledWith(['repo::worktree@@reconnect'])
    )

    storeState.tabsByWorktree = {
      'repo::worktree': [
        ...storeState.tabsByWorktree['repo::worktree'],
        { id: 'tab-2', ptyId: 'repo::worktree@@tab-2' }
      ]
    }
    hook.rerender()
    await waitFor(() =>
      expect(resolveCapabilities).toHaveBeenLastCalledWith(['repo::worktree@@tab-2'])
    )

    storeState.ptyIdsByTabId = {
      ...storeState.ptyIdsByTabId,
      'tab-2': ['repo::worktree@@tab-2-split']
    }
    hook.rerender()
    await waitFor(() =>
      expect(resolveCapabilities).toHaveBeenLastCalledWith(['repo::worktree@@tab-2-split'])
    )
    hook.unmount()
  })

  it('prefetches restored PTYs after render before activation is enabled', async () => {
    resolveCapabilities.mockResolvedValue([{ id: 'repo::worktree@@pty-1', authoritative: false }])

    const hook = renderHook(() => {
      useTerminalProviderSnapshotCapability(false)
      expect(resolveCapabilities).not.toHaveBeenCalled()
    })

    await waitFor(() => expect(resolveCapabilities).toHaveBeenCalledOnce())
    expect(resolveCapabilities).toHaveBeenCalledWith(['repo::worktree@@pty-1'])
    hook.unmount()
  })

  it('does not poll again after a provider confirms an authoritative snapshot', async () => {
    vi.useFakeTimers()
    resolveCapabilities.mockResolvedValue([{ id: 'repo::worktree@@pty-1', authoritative: true }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await vi.runAllTimersAsync()

    expect(resolveCapabilities).toHaveBeenCalledOnce()
    hook.unmount()
  })

  // Why: the timer chain is the sole recovery vehicle for unknown verdicts,
  // and its refire reuses the same memoized id array — this pins the backoff
  // return, the rescheduled timer, and the same-identity re-ask end to end.
  it.each([null, false])(
    'polls a %s pty again on the retry timer without any id churn',
    async (authoritative) => {
      vi.useFakeTimers()
      resolveCapabilities
        .mockResolvedValueOnce([{ id: 'repo::worktree@@pty-1', authoritative }])
        .mockResolvedValueOnce([{ id: 'repo::worktree@@pty-1', authoritative: true }])
      const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
      const initialRevision = hook.result.current
      await vi.advanceTimersByTimeAsync(0)
      expect(resolveCapabilities).toHaveBeenCalledOnce()
      expect(hook.result.current).toBe(initialRevision)

      await vi.advanceTimersByTimeAsync(1_000)

      expect(resolveCapabilities).toHaveBeenCalledTimes(2)
      expect(terminalProviderHasAuthoritativeSnapshot('repo::worktree@@pty-1')).toBe(true)
      expect(hook.result.current).toBeGreaterThan(initialRevision)
      hook.unmount()
    }
  )

  it('retains the retry timer when activation restarts an in-flight request', async () => {
    vi.useFakeTimers()
    let finishFirst!: (value: { id: string; authoritative: boolean | null }[]) => void
    const firstAnswer = new Promise<{ id: string; authoritative: boolean | null }[]>((resolve) => {
      finishFirst = resolve
    })
    resolveCapabilities
      .mockImplementationOnce(() => firstAnswer)
      .mockResolvedValueOnce([{ id: 'repo::worktree@@pty-1', authoritative: true }])
    let renders = 0
    const hook = renderHook(
      ({ enabled }) => {
        renders += 1
        return useTerminalProviderSnapshotCapability(enabled)
      },
      { initialProps: { enabled: false } }
    )
    expect(resolveCapabilities).toHaveBeenCalledOnce()

    hook.rerender({ enabled: true })
    const rendersBeforeFalse = renders
    await act(async () => {
      finishFirst([{ id: 'repo::worktree@@pty-1', authoritative: false }])
      await Promise.resolve()
    })
    expect(renders).toBe(rendersBeforeFalse)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(resolveCapabilities).toHaveBeenCalledTimes(2)
    expect(terminalProviderHasAuthoritativeSnapshot('repo::worktree@@pty-1')).toBe(true)
    expect(hook.result.current).toBeGreaterThan(0)
    hook.unmount()
  })

  it('cancels an unknown-capability retry when the hook unmounts', async () => {
    vi.useFakeTimers()
    resolveCapabilities.mockResolvedValue([{ id: 'repo::worktree@@pty-1', authoritative: null }])
    const hook = renderHook(() => useTerminalProviderSnapshotCapability(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCapabilities).toHaveBeenCalledOnce()

    hook.unmount()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(resolveCapabilities).toHaveBeenCalledOnce()
  })
})
