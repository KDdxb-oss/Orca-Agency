import { describe, expect, it, vi } from 'vitest'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import type { AutomationRun } from '../../shared/automations-types'
import { requestAutomationDispatch } from './automation-dispatch-request'

describe('desktop automation dispatch', () => {
  it('launches through the background runtime even when a renderer is ready', async () => {
    const state = buildProfileStateCutoverFixture('/fixture')
    const automation = { ...state.automations[0], precheck: null }
    let current: AutomationRun = {
      ...state.automationRuns[0],
      automationId: automation.id,
      status: 'pending'
    }
    const renderer = { isDestroyed: () => false, send: vi.fn() }
    const headlessDispatcher = vi.fn(async () => ({
      workspaceId: 'workspace-1',
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'tab-1:pane-1',
      terminalPtyId: 'pty-1'
    }))
    const updateRun = vi.fn(async (result: Partial<AutomationRun>) => {
      current = { ...current, ...result }
      return current
    })
    const target = { ok: true as const, cwd: state.repos[0].path, repo: state.repos[0] }
    await requestAutomationDispatch(
      {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatch reads only these in-memory store members.
        store: {
          listAutomationRuns: () => [current],
          listAutomations: () => [automation],
          flushPendingOrThrowAsync: vi.fn(async () => {})
        } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: updateRun is the only writer method used by this dispatch.
        runs: { updateRun } as never,
        isActive: () => true,
        getRenderer: () => renderer,
        headlessDispatcher,
        resolveTarget: () => target,
        runPrecheck: vi.fn(async () => null),
        markDispatchResult: vi.fn(async () => current),
        watchRun: vi.fn()
      },
      automation,
      current,
      target
    )

    expect(headlessDispatcher).toHaveBeenCalledOnce()
    expect(renderer.send).not.toHaveBeenCalled()
    expect(current).toMatchObject({
      status: 'dispatched',
      terminalPaneKey: 'tab-1:pane-1'
    })
  })
})
