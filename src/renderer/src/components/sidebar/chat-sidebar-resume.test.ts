import { describe, expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { chatResumeSession } from './chat-sidebar-resume'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatSidebarPreferencePatch } from './chat-sidebar-identity'
import {
  chatLiveSessionSnapshot,
  codexHomeFromTranscript,
  freshestChatSnapshot
} from './chat-sidebar-session-snapshot'
import { chatSessionKey } from './chat-sidebar-types'
import {
  chatRow,
  chatSession,
  chatState,
  chatTab,
  chatWorktree
} from './chat-sidebar-test-fixtures'

const moved = { ...chatWorktree, id: 'repo::C:/dev/Uncategorized', path: 'C:\\dev\\Uncategorized' }
const leafId = '77777777-7777-4777-8777-777777777777'

describe('resuming a chat from the list', () => {
  it('uses a per-chat destination without changing the running workspace owner', () => {
    const session = chatSession('a', { cwd: chatWorktree.path })
    expect(chatResumeSession(chatRow({ session, folderWorktree: moved }))?.cwd).toBe(moved.path)
    expect(
      chatResumeSession(
        chatRow({
          session: { ...session, cwd: `${chatWorktree.path}/child` },
          folderWorktree: chatWorktree
        })
      )?.cwd
    ).toBe(chatWorktree.path)
    const claude = { ...session, agent: 'claude' as const }
    expect(chatResumeSession(chatRow({ session: claude, folderWorktree: moved }))).toMatchObject({
      cwd: session.cwd,
      resumeCwd: moved.path,
      sessionId: 'a'
    })
  })
  it('starts a chat filed under another workspace in that workspace folder', () => {
    const session = chatSession('a', { cwd: 'C:\\dev\\General', resumeCommand: 'cd old && codex' })
    expect(chatResumeSession(chatRow({ session, worktree: moved }))).toMatchObject({
      cwd: 'C:\\dev\\Uncategorized',
      resumeCommand: ''
    })
  })

  it('keeps the recorded folder for chats inside the workspace or on another host', () => {
    const inside = chatSession('a', { cwd: 'C:\\dev\\Uncategorized\\sub' })
    expect(chatResumeSession(chatRow({ session: inside, worktree: moved }))).toBe(inside)
    const remote = chatSession('a', { cwd: '/srv/old', executionHostId: 'ssh:box' })
    expect(chatResumeSession(chatRow({ session: remote, worktree: moved }))).toBe(remote)
  })

  it('moves a Claude chat only when its transcript sits in the new folder bucket', () => {
    const stale = chatSession('a', {
      agent: 'claude',
      cwd: 'C:\\dev\\General',
      filePath: 'C:\\Users\\me\\.claude\\projects\\C--dev-General\\a.jsonl'
    })
    expect(chatResumeSession(chatRow({ session: stale, worktree: moved }))).toMatchObject({
      resumeCwd: stale.cwd
    })
    const relocated = {
      ...stale,
      filePath: 'C:\\Users\\me\\.claude\\projects\\C--dev-Uncategorized\\a.jsonl'
    }
    expect(chatResumeSession(chatRow({ session: relocated, worktree: moved }))?.resumeCwd).toBe(
      moved.path
    )
  })
  it('checks the real Claude project folder even without an explicit move', () => {
    const session = chatSession('a', { agent: 'claude', cwd: chatWorktree.path })
    expect(chatResumeSession(chatRow({ session }))?.resumeCwd).toBe(chatWorktree.path)
  })
  it('keeps local WSL Claude sessions on their recorded Linux resume path', () => {
    const session = chatSession('wsl', {
      agent: 'claude',
      executionHostPlatform: 'linux',
      cwd: '/home/me/project',
      filePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects\\-home-me-project\\wsl.jsonl'
    })
    const wslWorktree = {
      ...moved,
      path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
    }
    expect(chatResumeSession(chatRow({ session, worktree: wslWorktree }))).toBe(session)
  })
})

describe('keeping live chats after their tab closes', () => {
  it('finds the Codex home from where its rollout lives', () => {
    expect(
      codexHomeFromTranscript(
        'C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\sessions\\2026\\09\\28\\rollout-x.jsonl'
      )
    ).toBe('C:\\Users\\me\\AppData\\Roaming\\orca\\codex-runtime-home\\home')
    expect(codexHomeFromTranscript('/home/me/.codex/sessions/2026/09/28/rollout-x.jsonl')).toBe(
      '/home/me/.codex'
    )
    expect(codexHomeFromTranscript('/tmp/rollout-x.jsonl')).toBeNull()
    // Why: only Codex's dated rollout layout proves the folder above is its home.
    expect(codexHomeFromTranscript('/work/sessions/notes/rollout-x.jsonl')).toBeNull()
  })

  it('records a Claude chat only when its transcript bucket matches the workspace folder', () => {
    const key = chatSessionKey('local', 'claude', 'c1')
    const liveSession = {
      agent: 'claude' as const,
      sessionId: 'c1',
      transcriptPath: 'C:\\Users\\me\\.claude\\projects\\C--dev-Uncategorized\\c1.jsonl',
      title: 'Claude chat'
    }
    const row = chatRow({ id: key, sessionKey: key, worktree: moved, liveSession })
    expect(chatLiveSessionSnapshot(row, 5)).toMatchObject({ cwd: moved.path, codexHome: null })
    const subfolder = {
      ...row,
      liveSession: {
        ...liveSession,
        transcriptPath: 'C:\\Users\\me\\.claude\\projects\\C--dev-Uncategorized-sub\\c1.jsonl'
      }
    }
    expect(chatLiveSessionSnapshot(subfolder, 5)).toBeNull()
  })

  it('refreshes a remembered time and name at most once a minute of live activity', () => {
    const base = chatLiveSessionSnapshot(
      chatRow({
        timestamp: 60_000,
        liveSession: {
          agent: 'codex',
          sessionId: 'session-a',
          transcriptPath: '/h/sessions/2026/09/28/a.jsonl',
          title: 'Old'
        }
      }),
      0
    )
    if (!base) {
      throw new Error('expected a live Codex snapshot')
    }
    expect(base.codexHome).toBe('/h')
    const soon = { ...base, title: 'New', updatedAt: new Date(100_000).toISOString() }
    expect(freshestChatSnapshot(base, soon, true)).toBe(base)
    const later = { ...soon, updatedAt: new Date(200_000).toISOString() }
    expect(freshestChatSnapshot(base, later, true)).toMatchObject({
      title: 'New',
      updatedAt: later.updatedAt
    })
  })
  it('saves a hook-verified relocated Claude transcript before the time throttle expires', () => {
    const base = chatSession('c1', {
      agent: 'claude',
      cwd: '/old',
      filePath: '/home/me/.claude/projects/-old/c1.jsonl'
    })
    const previous = {
      executionHostId: base.executionHostId,
      agent: base.agent,
      sessionId: base.sessionId,
      title: base.title,
      cwd: base.cwd!,
      filePath: base.filePath,
      codexHome: base.codexHome,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      modifiedAt: base.modifiedAt
    }
    const current = {
      ...previous,
      cwd: '/new',
      filePath: '/home/me/.claude/projects/-new/c1.jsonl',
      updatedAt: new Date(Date.parse(base.updatedAt) + 1_000).toISOString()
    }
    expect(freshestChatSnapshot(previous, current, true)).toMatchObject({
      cwd: '/new',
      filePath: current.filePath
    })
  })

  it('keeps the real finish time of a turn shorter than a minute', () => {
    const started = chatLiveSessionSnapshot(
      chatRow({
        state: 'working',
        timestamp: 100_000,
        liveSession: {
          agent: 'codex',
          sessionId: 'session-a',
          transcriptPath: '/h/sessions/2026/09/28/a.jsonl',
          title: 'Quick task'
        }
      }),
      0
    )
    const finished = chatLiveSessionSnapshot(
      chatRow({
        state: 'done',
        timestamp: 130_000,
        liveSession: {
          agent: 'codex',
          sessionId: 'session-a',
          transcriptPath: '/h/sessions/2026/09/28/a.jsonl',
          title: 'Quick task'
        }
      }),
      0
    )
    expect(freshestChatSnapshot(started ?? undefined, finished, false)?.updatedAt).toBe(
      new Date(130_000).toISOString()
    )
    // Why: a later snapshot from an older live reading must never move the time backward.
    expect(freshestChatSnapshot(finished ?? undefined, started, false)).toBe(finished)
  })

  it('records only self-describing live chats when the list is not mounted', () => {
    const live = chatRow({
      liveSession: {
        agent: 'codex',
        sessionId: 'session-a',
        transcriptPath: '/h/sessions/2026/09/28/a.jsonl',
        title: 'Live'
      }
    })
    const other = chatRow({ id: 'b', sessionKey: chatSessionKey('local', 'codex', 'b') })
    const patch = chatSidebarPreferencePatch([live, other], {}, 5, { liveOnly: true })
    expect(Object.keys(patch?.sessions ?? {})).toEqual([live.sessionKey])
    expect(chatSidebarPreferencePatch([other], {}, 5, { liveOnly: true })).toBeNull()
  })

  it('keeps a hook-reported Codex chat listed and resumable after close with no scan', () => {
    const paneKey = makePaneKey('live', leafId)
    const transcriptPath = '/home/me/orca-codex/sessions/2026/09/28/rollout-live.jsonl'
    const entry: AgentStatusEntry = {
      paneKey,
      state: 'done',
      stateStartedAt: 3_000,
      updatedAt: 3_000,
      stateHistory: [],
      prompt: 'Add Zevari MCP',
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'live', transcriptPath }
    }
    const open = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [chatTab('live', { aiVaultTitle: null, title: 'Terminal 1' })]
      },
      agentStatusByPaneKey: { [paneKey]: entry }
    })
    const patch = chatSidebarPreferencePatch(buildChatSidebarRows(open, [], 10_000), {}, 10_000)
    const key = chatSessionKey('local', 'codex', 'live')
    expect(patch?.sessions?.[key]?.snapshot).toMatchObject({
      codexHome: '/home/me/orca-codex',
      filePath: transcriptPath,
      cwd: chatWorktree.path
    })
    const closed = chatState({
      settings: createGlobalSettingsFixture({ chatSidebar: { sessions: patch?.sessions } })
    })
    const [row] = buildChatSidebarRows(closed, [], 20_000)
    expect(row).toMatchObject({ id: key, tabId: null, title: 'Add Zevari MCP' })
    expect(row.session).toMatchObject({ codexHome: '/home/me/orca-codex', sessionId: 'live' })
  })
})
