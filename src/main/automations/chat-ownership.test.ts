import { describe, expect, it, vi } from 'vitest'
import {
  recordAutomationChatOwnership,
  recordAutomationProviderSessionOwnership
} from './chat-ownership'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Automation, AutomationRun } from '../../shared/automations-types'

function fixture() {
  let settings = createGlobalSettingsFixture()
  const automation: Automation = {
    id: 'automation',
    name: 'Audit',
    prompt: 'Audit',
    precheck: null,
    agentId: 'codex',
    projectId: 'project',
    executionTargetType: 'ssh',
    executionTargetId: 'host',
    schedulerOwner: 'remote_host_service',
    workspaceMode: 'existing',
    workspaceId: 'workspace',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: 1,
    updatedAt: 1
  }
  const updateSettings = vi.fn(
    (patch: Partial<GlobalSettings>) => (settings = { ...settings, ...patch })
  )
  const store = {
    getSettings: () => settings,
    updateSettings,
    listAutomations: () => [automation],
    listAutomationRuns: () => [run]
  }
  const run: AutomationRun = {
    id: 'run',
    automationId: 'automation',
    title: 'Audit',
    scheduledFor: 1,
    status: 'dispatched',
    trigger: 'scheduled',
    workspaceId: 'workspace',
    runContext: {
      kind: 'workspace-run',
      projectId: 'project',
      hostId: 'ssh:host',
      projectHostSetupId: 'setup',
      repoId: 'repo',
      path: '/project'
    },
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab',
    terminalPaneKey: 'tab:pane',
    terminalPtyId: 'pty',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 2,
    createdAt: 1
  }
  return { store, run }
}

describe('automation chat origin persistence', () => {
  it('retains host-scoped tab and pane identities after completion clears terminal pointers', () => {
    const { store, run } = fixture()
    recordAutomationChatOwnership(store, run, [])
    expect(store.getSettings().chatSidebar?.automationChats).toEqual([
      '["ssh:host","tab"]',
      '["ssh:host","tab:pane"]'
    ])
    recordAutomationChatOwnership(
      store,
      { ...run, terminalSessionId: null, terminalPaneKey: null },
      []
    )
    expect(store.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps provider ids even when the terminal retires and preserves other settings', () => {
    const { store, run } = fixture()
    store.updateSettings({ chatSidebar: { hiddenFolders: ['Private'] } })
    const usage = {
      status: 'known',
      provider: 'codex',
      model: null,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningOutputTokens: null,
      totalTokens: 2,
      estimatedCostUsd: null,
      estimatedCostSource: null,
      providerSessionId: 'provider-session',
      attribution: 'provider_session_time_window',
      collectedAt: 3,
      unavailableReason: null,
      unavailableMessage: null
    } as const
    recordAutomationChatOwnership(store, { ...run, usage }, [])
    expect(store.getSettings().chatSidebar).toMatchObject({
      hiddenFolders: ['Private'],
      automationChats: expect.arrayContaining(['["ssh:host","codex","provider-session"]'])
    })
  })

  it('tags the provider as soon as its hook arrives, before a final run update', () => {
    const { store } = fixture()
    recordAutomationProviderSessionOwnership(store, [
      { paneKey: 'tab:pane', sessionId: 'provider-session' }
    ])
    expect(store.getSettings().chatSidebar?.automationChats).toContain(
      '["ssh:host","codex","provider-session"]'
    )
  })
})
