import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { codexRestartResumeStartup } from './codex-restart-resume-startup'
import { chatState, chatTab, chatWorktree } from '../sidebar/chat-sidebar-test-fixtures'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AppState } from '@/store'
import { savedTabResume } from './pty-connection/saved-tab-resume'
import { REMOTE_PTY_ID_PREFIX } from './pty-connection/pty-connect-limits'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

const platform = vi.hoisted((): { value: NodeJS.Platform } => ({ value: 'linux' }))
vi.mock('@/lib/new-workspace', () => ({
  get CLIENT_PLATFORM() {
    return platform.value
  }
}))
beforeEach(() => {
  platform.value = 'linux'
})
const leafId = '77777777-7777-4777-8777-777777777777'
const paneKey = makePaneKey('a', leafId)

function state(): AppState {
  return {
    ...useAppStore.getState(),
    ...chatState({
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          worktreeId: chatWorktree.id,
          tabId: 'a',
          connectionId: null,
          state: 'done',
          agentType: 'codex',
          prompt: 'Original request',
          stateStartedAt: 1_000,
          updatedAt: 2_000,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'exact-session' }
        }
      }
    })
  }
}

describe('Codex restart resumes its own conversation', () => {
  it.each([
    { shell: 'powershell.exe', expected: "'resume' 'exact-session'" },
    { shell: 'cmd.exe', expected: '"resume" "exact-session"' }
  ])('quotes exact resume for native Windows $shell', ({ shell, expected }) => {
    platform.value = 'win32'
    const source = state()
    source.settings!.terminalWindowsShell = shell
    source.tabsByWorktree[chatWorktree.id][0].shellOverride = shell
    const startup = codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId, 'C:\\project')
    expect(startup.command).toContain(expected)
    expect(startup.resumeProviderSession?.id).toBe('exact-session')
  })

  it('uses POSIX resume quoting for a WSL pane on a Windows client', () => {
    platform.value = 'win32'
    const source = state()
    source.settings!.terminalWindowsShell = 'cmd.exe'
    const startup = codexRestartResumeStartup(
      source,
      chatWorktree.id,
      'a',
      leafId,
      '\\\\wsl.localhost\\Ubuntu\\home\\project'
    )
    expect(startup.command).toContain("'resume' 'exact-session'")
    expect(startup.resumeProviderSession?.id).toBe('exact-session')
  })

  it('keeps a Done session and uses current configuration', () => {
    const source = state()
    source.settings!.agentCmdOverrides = { codex: 'current-codex' }
    source.settings!.agentDefaultArgs = { codex: '--model current-model' }
    const startup = codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId)
    expect(startup.command).toBe(
      "current-codex '--model' 'current-model' '--cd' '.' 'resume' 'exact-session'"
    )
    expect(startup.resumeProviderSession).toEqual({ key: 'session_id', id: 'exact-session' })
    expect(source.agentStatusByPaneKey[paneKey].state).toBe('done')
    expect(startup.startupCommandDelivery).toBe('shell-ready')
  })

  it('uses the selected leaf instead of a sibling conversation', () => {
    const source = state()
    source.tabsByWorktree[chatWorktree.id][0].aiVaultTitle = {
      agent: 'codex',
      sessionId: 'sibling-session',
      title: 'Sibling'
    }
    expect(codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId).command).toContain(
      "'resume' 'exact-session'"
    )
  })

  it('does not resume a record captured on another machine', () => {
    const source = state()
    source.agentStatusByPaneKey[paneKey].connectionId = 'other-server'
    const startup = codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId)
    expect(startup.command).toMatch(/^codex.* 'resume'$/)
    expect(startup.resumeProviderSession).toBeUndefined()
  })

  it('opens the resume picker when no exact ID is known', () => {
    const source = state()
    source.agentStatusByPaneKey = {}
    source.settings!.agentCmdOverrides = { codex: 'current-codex' }
    expect(codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId).command).toMatch(
      /^current-codex.* 'resume'$/
    )
  })

  it('uses the remote host picker when its replacement home guard is unavailable', () => {
    const source = state()
    const startup = codexRestartResumeStartup(
      source,
      chatWorktree.id,
      'a',
      leafId,
      '/project',
      `${REMOTE_PTY_ID_PREFIX}server:old-pty`
    )
    expect(startup.command).toMatch(/'resume'$/)
    expect(startup.resumeProviderSession).toBeUndefined()
  })

  it('does not borrow an older session when the current pane has no session ID yet', () => {
    const source = state()
    source.agentStatusByPaneKey[paneKey].providerSession = undefined
    source.tabsByWorktree[chatWorktree.id][0].aiVaultTitle = {
      agent: 'codex',
      sessionId: 'older-session',
      title: 'Older chat'
    }
    const startup = codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId)
    expect(startup.command).toMatch(/'resume'$/)
    expect(startup.resumeProviderSession).toBeUndefined()
  })

  it('opens the picker for a legacy tab with no verified pane binding', () => {
    const source = state()
    source.tabsByWorktree[chatWorktree.id][0].aiVaultTitle = {
      agent: 'codex',
      sessionId: 'possible-sibling',
      title: 'Saved chat'
    }
    source.settings!.chatSidebar = {
      ...source.settings!.chatSidebar,
      sessions: {
        '["local","codex","possible-sibling"]': {
          worktreeId: chatWorktree.id,
          snapshot: {
            executionHostId: 'local',
            agent: 'codex',
            sessionId: 'possible-sibling',
            title: 'Saved chat',
            cwd: '/project',
            filePath: '/home/user/.codex/sessions/2026/10/01/rollout-sibling.jsonl',
            codexHome: '/home/user/.codex',
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: null,
            modifiedAt: '2026-10-01T01:00:00Z'
          }
        }
      }
    }
    expect(
      savedTabResume(
        source,
        chatWorktree.id,
        'a',
        getKnownExecutionHostIdForWorktree(source, chatWorktree.id)
      )?.sessionId
    ).toBe('possible-sibling')
    const startup = codexRestartResumeStartup(source, chatWorktree.id, 'a', null, '/project')
    expect(startup.command).toMatch(/'resume'$/)
    expect(startup.resumeProviderSession).toBeUndefined()
  })

  it('leaves account switches to the existing selected-account launch', () => {
    const source = state()
    source.codexRestartNoticeByPtyId.old = {
      previousAccountLabel: 'Account A',
      nextAccountLabel: 'Account B',
      restartRequested: true
    }
    const startup = codexRestartResumeStartup(
      source,
      chatWorktree.id,
      'a',
      leafId,
      undefined,
      'old'
    )
    expect(startup.command).toBe('codex')
    expect(startup.resumeProviderSession).toBeUndefined()
    expect(startup.env).toBeUndefined()
    expect(startup.envToDelete).toBeUndefined()
  })

  it('does not treat matching display labels as matching accounts', () => {
    const source = state()
    source.codexRestartNoticeByPtyId.old = {
      previousAccountLabel: 'Same label',
      nextAccountLabel: 'Same label',
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    }
    expect(
      codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId, undefined, 'old').command
    ).toBe('codex')
  })

  it.each(['C:/Users/dev/.codex', 'C:/Users/dev/orca/accounts/old'])(
    'does not pin a saved home %s in the renderer',
    (codexHome) => {
      const source = state()
      const transcriptPath = `${codexHome}/sessions/rollout-exact-session.jsonl`
      source.settings!.chatSidebar = {
        ...source.settings!.chatSidebar,
        sessions: {
          '["local","codex","exact-session"]': {
            worktreeId: chatWorktree.id,
            snapshot: {
              agent: 'codex',
              executionHostId: 'local',
              sessionId: 'exact-session',
              filePath: transcriptPath,
              codexHome,
              cwd: '/project',
              title: 'Original chat',
              createdAt: '2026-10-01T00:00:00Z',
              updatedAt: null,
              modifiedAt: '2026-10-01T01:00:00Z'
            }
          }
        }
      }
      const startup = codexRestartResumeStartup(source, chatWorktree.id, 'a', leafId)
      expect(startup.resumeProviderSession?.id).toBe('exact-session')
      expect(startup.env?.CODEX_HOME).toBeUndefined()
      expect(startup.envToDelete).toBeUndefined()
    }
  )
})
