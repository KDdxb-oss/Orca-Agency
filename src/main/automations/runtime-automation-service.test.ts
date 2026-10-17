import { describe, expect, it, vi } from 'vitest'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'

const captured = vi.hoisted(
  (): { dispatcher: unknown; observer: unknown; remoteScheduling: unknown } => ({
    dispatcher: null,
    observer: null,
    remoteScheduling: null
  })
)

vi.mock('./service', () => ({
  AutomationService: class {
    start(): void {}
    stop(): void {}
    constructor(
      _store: unknown,
      opts: {
        headlessDispatcher?: unknown
        terminalObserver?: unknown
        allowRemoteHostScheduling?: unknown
      }
    ) {
      captured.dispatcher = opts.headlessDispatcher
      captured.observer = opts.terminalObserver
      captured.remoteScheduling = opts.allowRemoteHostScheduling
    }
  }
}))

import { createRuntimeAutomationService } from './runtime-automation-service'

describe('desktop background dispatch authority', () => {
  it('keeps remote schedules on the server while dispatching local runs headlessly', () => {
    const runtime = { setAutomationService: vi.fn(), notifyAutomationsChanged: vi.fn() }
    createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service does not read the store.
      store: {} as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: construction invokes only these runtime methods.
      runtime: runtime as never,
      headless: false,
      dispatchHeadlessly: true
    })

    expect(captured.dispatcher).toBeTypeOf('function')
    expect(captured.remoteScheduling).toBe(false)
  })
})

describe('headless automation dispatch', () => {
  it('hands the launched run to its watcher instead of awaiting one tui-idle wait itself', async () => {
    const updateSettings = vi.fn()
    const store = {
      listAutomations: () => [
        { id: 'automation', executionTargetType: 'local', agentId: 'goose' }
      ],
      getSettings: () => ({ chatSidebar: {} }),
      updateSettings
    }
    const runtime = {
      setAutomationService: vi.fn(),
      notifyAutomationsChanged: vi.fn(),
      launchAgentTerminal: vi.fn(async () => ({
        handle: 'terminal-1',
        tabId: 'tab-1',
        paneKey: 'tab-1:pane-1',
        ptyId: 'pty-1',
        worktreeId: 'wt-1'
      })),
      showManagedWorktree: vi.fn(async () => ({ displayName: 'repo' })),
      waitForTerminal: vi.fn(),
      // Not resolvable by pane key yet: the launch's own handle must still reach the watcher.
      getTerminalHandleForPaneKey: vi.fn(() => null),
      getAgentStatusRowsForPane: vi.fn(() => [])
    }
    createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only these mocked ownership methods.
      store: store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the members faked above.
      runtime: runtime as never,
      headless: true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured from the mocked constructor above.
    const dispatcher = captured.dispatcher as HeadlessAutomationDispatcher
    const launch = await dispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a reuse-workspace automation; only these fields are read.
      automation: {
        workspaceMode: 'existing',
        workspaceId: 'wt-1',
        agentId: 'goose'
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the title is read.
      run: { id: 'run', automationId: 'automation', title: 'Nightly' } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unused for an existing workspace.
      target: {} as never
    })

    expect(launch.completion).toBeUndefined()
    expect(launch.terminalPaneKey).toBe('tab-1:pane-1')
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        chatSidebar: expect.objectContaining({
          automationChats: expect.arrayContaining(['["local","tab-1:pane-1"]'])
        })
      }),
      { notifyListeners: true }
    )
    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'goose',
      prompt: undefined,
      title: 'Nightly',
      unlisted: true
    })
    expect(runtime.waitForTerminal).not.toHaveBeenCalled()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured from the mocked constructor above.
    const observer = captured.observer as AutomationRunTerminalObserver
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolution reads only the pane key.
    expect(observer.resolveRunTerminal({ terminalPaneKey: 'tab-1:pane-1' } as never)).toBe(
      'terminal-1'
    )
  })
})

describe('headless automation dispatch with extra agent args', () => {
  it('passes saved extras to an existing-workspace launch', async () => {
    const runtime = {
      setAutomationService: vi.fn(),
      notifyAutomationsChanged: vi.fn(),
      launchAgentTerminal: vi.fn(async () => ({
        handle: 'terminal-1',
        tabId: 'tab-1',
        paneKey: 'tab-1:pane-1',
        ptyId: 'pty-1',
        worktreeId: 'wt-1'
      })),
      showManagedWorktree: vi.fn(async () => ({ displayName: 'repo' })),
      getTerminalHandleForPaneKey: vi.fn(() => null),
      getAgentStatusRowsForPane: vi.fn(() => [])
    }
    createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ownership exits before reading other store methods without a host.
      store: { listAutomations: () => [] } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only the members faked above.
      runtime: runtime as never,
      headless: true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured from the mocked constructor above.
    const dispatcher = captured.dispatcher as HeadlessAutomationDispatcher
    const automation = {
      workspaceMode: 'existing',
      workspaceId: 'wt-1',
      agentId: 'claude',
      prompt: 'go',
      extraAgentArgs: '--model opus'
    }
    await dispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these fields are read.
      automation: automation as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the title is read.
      run: { title: 'Nightly' } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unused for an existing workspace.
      target: {} as never
    })

    expect(runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'claude',
      prompt: 'go',
      title: 'Nightly',
      unlisted: true,
      extraAgentArgs: '--model opus'
    })
  })
})

describe('background automation session reuse', () => {
  it('sends a new prompt to the exact completed unused pane', async () => {
    const completed = {
      id: 'previous-run',
      workspaceId: 'wt-1',
      status: 'completed',
      createdAt: 1,
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'tab-1:pane-1',
      terminalPtyId: 'pty-1'
    }
    const runtime = {
      setAutomationService: vi.fn(),
      notifyAutomationsChanged: vi.fn(),
      launchAgentTerminal: vi.fn(),
      showManagedWorktree: vi.fn(async () => ({ displayName: 'repo' })),
      getTerminalHandleForPaneKey: vi.fn(() => 'terminal-1'),
      getTerminalPtyIdForHandle: vi.fn(() => 'pty-1'),
      readTerminalClientUse: vi.fn(() => 'unused'),
      getAgentStatusRowsForPane: vi.fn(() => [
        { state: 'done', agentType: 'claude', receivedAt: 2 }
      ]),
      sendTerminalAgentPrompt: vi.fn(async () => ({ accepted: true }))
    }
    createRuntimeAutomationService({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this dispatch reads only listAutomationRuns.
      store: { listAutomationRuns: () => [completed], listAutomations: () => [] } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the mocked runtime methods above are invoked.
      runtime: runtime as never,
      headless: true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: captured from the mocked constructor above.
    const dispatcher = captured.dispatcher as HeadlessAutomationDispatcher
    const result = await dispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reuse reads only these automation fields.
      automation: {
        id: 'automation-1',
        workspaceMode: 'existing',
        workspaceId: 'wt-1',
        agentId: 'claude',
        prompt: 'do the next task',
        reuseSession: true
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reuse reads only the run id.
      run: { id: 'next-run', title: 'Nightly' } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: target is unused for existing workspaces.
      target: {} as never
    })

    expect(result).toMatchObject({
      terminalSessionId: 'tab-1',
      terminalPaneKey: 'tab-1:pane-1',
      terminalPtyId: 'pty-1'
    })
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith('terminal-1', 'do the next task', {
      inputKind: 'driving',
      acceptQueued: true
    })
    expect(runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })
})
