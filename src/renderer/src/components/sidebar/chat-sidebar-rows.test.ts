import { describe, expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatFallbackId, chatSessionKey } from './chat-sidebar-types'
import { chatSession, chatState, chatTab, chatWorktree } from './chat-sidebar-test-fixtures'
import { chatSessionSnapshot } from './chat-sidebar-session-snapshot'

const leafId = '77777777-7777-4777-8777-777777777777'
const otherLeafId = '88888888-8888-4888-8888-888888888888'
const paneKey = makePaneKey('running', leafId)

function statusEntry(key: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: key,
    state: 'done',
    stateStartedAt: 3_000,
    updatedAt: 3_000,
    stateHistory: [],
    prompt: 'Work',
    agentType: 'codex',
    ...overrides
  }
}

describe('chat sidebar', () => {
  it('excludes headless Claude history, including remembered snapshots', () => {
    const state = chatState()
    state.settings!.chatSidebar = { historySince: 0 }
    const headless = chatSession('headless', { agent: 'claude', isHeadless: true })
    const interactive = chatSession('interactive', { agent: 'claude' })
    expect(
      buildChatSidebarRows(state, [headless, interactive], 10_000).map((row) => row.sessionKey)
    ).toEqual([chatSessionKey('local', 'claude', 'interactive')])
    state.settings!.chatSidebar.sessions = {
      [chatSessionKey('local', 'claude', 'headless')]: {
        worktreeId: chatWorktree.id,
        snapshot: chatSessionSnapshot(headless)
      }
    }
    expect(buildChatSidebarRows(state, [], 10_000)).toEqual([])
  })

  it('uses the newest moved transcript regardless of scan order, before and after its tab closes', () => {
    const state = chatState({ tabsByWorktree: { [chatWorktree.id]: [chatTab('moved')] } })
    state.settings!.chatSidebar = { historySince: 0 }
    const old = chatSession('session-moved', {
      updatedAt: new Date(2_000).toISOString(),
      filePath: '/old/session.jsonl'
    })
    const newer = {
      ...old,
      updatedAt: new Date(3_000).toISOString(),
      filePath: '/new/session.jsonl'
    }
    for (const sessions of [
      [newer, old],
      [old, newer]
    ]) {
      expect(buildChatSidebarRows(state, sessions, 4_000)[0].session?.filePath).toBe(newer.filePath)
    }
    state.tabsByWorktree = {}
    expect(buildChatSidebarRows(state, [newer, old], 4_000)[0].session?.filePath).toBe(
      newer.filePath
    )
    state.settings!.chatSidebar.sessions = {
      [chatSessionKey('local', 'codex', old.sessionId)]: {
        worktreeId: chatWorktree.id,
        snapshot: chatSessionSnapshot(newer)
      }
    }
    expect(buildChatSidebarRows(state, [old], 4_000)[0].session?.filePath).toBe(newer.filePath)
  })
  it('uses a provider title for an idle agent even while its terminal title is still generic', () => {
    const state = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [
          chatTab('idle', {
            title: 'Terminal 3',
            defaultTitle: 'Terminal 3',
            aiVaultTitle: {
              agent: 'codex',
              sessionId: 'session-idle',
              title: 'Recently finished task'
            }
          })
        ]
      }
    })
    expect(buildChatSidebarRows(state, [], 10_000)[0].title).toBe('Recently finished task')
  })
  it('shows conversations and excludes unused agent launches and plain terminals', () => {
    const rows = buildChatSidebarRows(
      chatState({
        tabsByWorktree: {
          [chatWorktree.id]: [
            chatTab('a'),
            chatTab('b', { launchAgent: 'claude', aiVaultTitle: null }),
            chatTab('shell', { launchAgent: undefined, aiVaultTitle: null, title: 'PowerShell' })
          ]
        }
      }),
      [],
      10_000
    )
    expect(rows.map((row) => row.tabId).sort()).toEqual(['a'])
    expect(rows.every((row) => row.folder === 'Acme')).toBe(true)
  })

  it('keeps a running older task above one that finished more recently', () => {
    const state = chatState({
      tabsByWorktree: { [chatWorktree.id]: [chatTab('running'), chatTab('recent')] },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          stateStartedAt: 5_000,
          updatedAt: 5_000,
          stateHistory: [],
          prompt: 'Work',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'session-running' }
        }
      }
    })
    const rows = buildChatSidebarRows(
      state,
      [chatSession('session-recent', { updatedAt: new Date(9_000).toISOString() })],
      10_000
    )
    expect(rows.map((row) => row.tabId)).toEqual(['running', 'recent'])
    expect(rows[0].state).toBe('working')
    expect(rows[0].timestamp).toBeLessThan(rows[1].timestamp)
  })

  it('honors the Update display name over an automatic title for a single chat', () => {
    const state = chatState({
      worktreesByRepo: { repo: [{ ...chatWorktree, displayName: 'Aside profile extensions' }] },
      tabsByWorktree: {
        [chatWorktree.id]: [
          chatTab('a', {
            aiVaultTitle: {
              agent: 'codex',
              sessionId: 'session-a',
              title: 'Import extensions to Example firm'
            }
          })
        ]
      }
    })
    expect(buildChatSidebarRows(state, [], 10_000)[0].title).toBe('Aside profile extensions')
  })

  it('renames one conversation without renaming another in its workspace', () => {
    const state = chatState({
      settings: createGlobalSettingsFixture({
        chatSidebar: {
          titles: {
            [chatSessionKey('local', 'codex', 'session-a')]: 'My name'
          }
        }
      }),
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b')] }
    })
    const rows = buildChatSidebarRows(state, [], 10_000)
    expect(rows.map((row) => row.title).sort()).toEqual(['Chat b', 'My name'])
  })

  it('retains a closed registered conversation and deduplicates its open copy', () => {
    const session = chatSession('session-a')
    const state = chatState({
      settings: createGlobalSettingsFixture({
        chatSidebar: {
          sessions: {
            [chatSessionKey('local', 'codex', session.sessionId)]: { worktreeId: chatWorktree.id }
          }
        }
      }),
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] }
    })
    expect(buildChatSidebarRows(state, [session], 10_000)).toHaveLength(1)
    state.tabsByWorktree = {}
    expect(buildChatSidebarRows(state, [session], 10_000)[0]).toMatchObject({
      tabId: null,
      session,
      title: 'History session-a'
    })
  })

  it('imports matching history since the chosen date, excluding subagents and other hosts', () => {
    const state = chatState({
      settings: createGlobalSettingsFixture({ chatSidebar: { historySince: 500 } })
    })
    const rows = buildChatSidebarRows(
      state,
      [
        chatSession('yes'),
        chatSession('old', { createdAt: new Date(100).toISOString() }),
        chatSession('child', {
          subagent: { parentSessionId: 'yes', agentType: null, status: null }
        }),
        chatSession('remote', { executionHostId: 'ssh:other' }),
        chatSession('elsewhere', { cwd: '/unrelated' })
      ],
      10_000
    )
    expect(rows.map((row) => row.session?.sessionId)).toEqual(['yes'])
  })

  it('does not collapse identically named conversations', () => {
    const rows = buildChatSidebarRows(
      chatState({ settings: createGlobalSettingsFixture({ chatSidebar: { historySince: 0 } }) }),
      [chatSession('one', { title: 'Same' }), chatSession('two', { title: 'Same' })],
      10_000
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].id).not.toBe(rows[1].id)
  })

  it('honors an explicitly hidden migrated copy without hiding other workspace chats', () => {
    const rows = buildChatSidebarRows(
      chatState({
        settings: createGlobalSettingsFixture({
          chatSidebar: {
            historySince: 0,
            hidden: [chatSessionKey('local', 'codex', 'old-copy')]
          }
        })
      }),
      [chatSession('old-copy'), chatSession('client-work')],
      10_000
    )
    expect(rows.map((row) => row.session?.sessionId)).toEqual(['client-work'])
  })

  it('reopens a manually completed chat when a new turn starts', () => {
    const state = chatState({
      settings: createGlobalSettingsFixture({
        chatSidebar: {
          completed: {
            [chatSessionKey('local', 'codex', 'session-running')]: { activityAt: 4_000, at: 4_500 }
          }
        }
      }),
      tabsByWorktree: { [chatWorktree.id]: [chatTab('running')] },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          updatedAt: 5_000,
          stateStartedAt: 5_000,
          stateHistory: [],
          prompt: 'New turn',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'session-running' }
        }
      }
    })
    expect(buildChatSidebarRows(state, [], 6_000)[0].completed).toBe(false)
  })

  it('does not reset idle title-derived recency on each render', () => {
    const state = chatState({
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] },
      ptyIdsByTabId: { a: ['pty-a'] },
      runtimePaneTitlesByTabId: { a: { 1: 'Codex' } },
      terminalLayoutsByTabId: {
        a: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
      }
    })
    expect(buildChatSidebarRows(state, [], 10_000)[0].timestamp).toBe(
      buildChatSidebarRows(state, [], 50_000)[0].timestamp
    )
  })
  it('uses the foreground process read over a stale title in Chats', () => {
    const pane = makePaneKey('a', leafId)
    const state = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [chatTab('a')]
      },
      ptyIdsByTabId: { a: ['pty-a'] },
      runtimePaneTitlesByTabId: { a: { 1: 'Claude Code' } },
      terminalLayoutsByTabId: {
        a: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
      },
      paneForegroundAgentByPaneKey: {
        [pane]: { agent: 'codex', agentEvidence: 'process-read', shellForeground: false }
      }
    })
    expect(buildChatSidebarRows(state, [], 10_000)[0]).toMatchObject({
      agentType: 'codex',
      paneKey: pane
    })
  })
  it('keeps two agents split inside one tab as separate chats', () => {
    const paneA = makePaneKey('split', leafId)
    const paneB = makePaneKey('split', otherLeafId)
    const state = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [
          chatTab('split', {
            aiVaultTitle: { agent: 'codex', sessionId: 'session-a', title: 'Chat A' }
          })
        ]
      },
      agentStatusByPaneKey: {
        [paneA]: statusEntry(paneA, { providerSession: { key: 'session_id', id: 'session-a' } }),
        [paneB]: statusEntry(paneB, { state: 'working', stateStartedAt: 4_000 })
      }
    })
    const rows = buildChatSidebarRows(state, [], 10_000)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.id).sort()).toEqual(
      [chatSessionKey('local', 'codex', 'session-a'), chatFallbackId('local', paneB)].sort()
    )
  })

  it('does not reopen Done for a resume boundary or heartbeat from before completion', () => {
    const key = chatSessionKey('local', 'codex', 'session-running')
    const settings = createGlobalSettingsFixture({
      chatSidebar: { completed: { [key]: { activityAt: 4_000, at: 4_500 } } }
    })
    const tabsByWorktree = { [chatWorktree.id]: [chatTab('running')] }
    const providerSession = { key: 'session_id' as const, id: 'session-running' }
    const boundary = chatState({
      settings,
      tabsByWorktree,
      agentStatusByPaneKey: {
        [paneKey]: statusEntry(paneKey, {
          stateStartedAt: 6_000,
          updatedAt: 6_000,
          sessionBoundary: true,
          providerSession
        })
      }
    })
    expect(buildChatSidebarRows(boundary, [], 7_000)[0].completed).toBe(true)
    const heartbeat = chatState({
      settings,
      tabsByWorktree,
      agentStatusByPaneKey: {
        [paneKey]: statusEntry(paneKey, {
          state: 'working',
          stateStartedAt: 4_000,
          updatedAt: 9_000,
          providerSession
        })
      }
    })
    expect(buildChatSidebarRows(heartbeat, [], 9_500)[0].completed).toBe(true)
  })

  it('orders working chats by turn start rather than heartbeat time', () => {
    const state = chatState({
      tabsByWorktree: { [chatWorktree.id]: [chatTab('running')] },
      agentStatusByPaneKey: {
        [paneKey]: statusEntry(paneKey, {
          state: 'working',
          stateStartedAt: 4_000,
          updatedAt: 9_000
        })
      }
    })
    expect(buildChatSidebarRows(state, [], 9_500)[0].timestamp).toBe(4_000)
  })

  it('keeps a name and completion stored before the provider session was known', () => {
    const fallback = chatFallbackId('local', 'a')
    const rows = buildChatSidebarRows(
      chatState({
        settings: createGlobalSettingsFixture({
          chatSidebar: {
            titles: { [fallback]: 'Early name' },
            completed: { [fallback]: { activityAt: 500, at: 5_000 } }
          }
        }),
        tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] }
      }),
      [],
      10_000
    )
    expect(rows[0]).toMatchObject({
      id: chatSessionKey('local', 'codex', 'session-a'),
      aliases: [fallback],
      title: 'Early name',
      completed: true
    })
  })

  it('ranks a manual tab name over the workspace name and ignores automatic workspace names', () => {
    const named = { ...chatWorktree, displayName: 'Aside profile extensions' }
    const manualTab = chatState({
      worktreesByRepo: { repo: [named] },
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a', { customTitle: 'Tab rename' })] }
    })
    expect(buildChatSidebarRows(manualTab, [], 10_000)[0].title).toBe('Tab rename')
    const automatic = chatState({
      worktreesByRepo: { repo: [{ ...named, displayNameMode: 'automatic' }] },
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] }
    })
    expect(buildChatSidebarRows(automatic, [], 10_000)[0].title).toBe('Chat a')
  })

  it('keeps the workspace name on its open chat when history from the same folder loads', () => {
    const state = chatState({
      settings: createGlobalSettingsFixture({ chatSidebar: { historySince: 0 } }),
      worktreesByRepo: { repo: [{ ...chatWorktree, displayName: 'Aside profile extensions' }] },
      tabsByWorktree: { [chatWorktree.id]: [chatTab('a')] }
    })
    const rows = buildChatSidebarRows(state, [chatSession('older')], 10_000)
    const open = rows.find((row) => row.tabId === 'a')
    expect(open).toMatchObject({ title: 'Aside profile extensions', ownsWorkspaceName: true })
    expect(rows.find((row) => row.tabId === null)?.title).toBe('History older')
  })

  it('keeps a registered workspace name on its chat after sibling chats appear', () => {
    const key = chatSessionKey('local', 'codex', 'session-b')
    const rows = buildChatSidebarRows(
      chatState({
        settings: createGlobalSettingsFixture({
          chatSidebar: {
            sessions: { [key]: { worktreeId: chatWorktree.id, ownsWorkspaceName: true } }
          }
        }),
        worktreesByRepo: { repo: [{ ...chatWorktree, displayName: 'Aside profile extensions' }] },
        tabsByWorktree: { [chatWorktree.id]: [chatTab('a'), chatTab('b')] }
      }),
      [],
      10_000
    )
    expect(Object.fromEntries(rows.map((row) => [row.tabId, row.title]))).toEqual({
      a: 'Chat a',
      b: 'Aside profile extensions'
    })
  })

  it('skips history in archived workspaces and uses the provided session workspace map', () => {
    const archived = {
      ...chatWorktree,
      id: 'repo::/clients/Old',
      path: '/clients/Old',
      isArchived: true
    }
    const state = chatState({
      settings: createGlobalSettingsFixture({ chatSidebar: { historySince: 0 } }),
      worktreesByRepo: { repo: [chatWorktree, archived] }
    })
    const map = new Map([
      [
        'codex:mapped',
        { status: 'active' as const, label: 'Acme', path: '/x', worktreeId: chatWorktree.id }
      ],
      [
        'codex:gone',
        { status: 'archived' as const, label: 'Old', path: '/x', worktreeId: archived.id }
      ]
    ])
    const rows = buildChatSidebarRows(
      state,
      [chatSession('mapped', { cwd: '/unrelated' }), chatSession('gone')],
      10_000,
      map
    )
    expect(rows.map((row) => row.session?.sessionId)).toEqual(['mapped'])
  })

  it('does not list a startup working event without a prompt or conversation', () => {
    const state = chatState({
      tabsByWorktree: {
        [chatWorktree.id]: [chatTab('running', { aiVaultTitle: null, title: 'Terminal 1' })]
      },
      agentStatusByPaneKey: {
        [paneKey]: statusEntry(paneKey, { state: 'working', prompt: '' })
      }
    })
    expect(buildChatSidebarRows(state, [], 10_000)).toEqual([])
  })
  it('lists and resumes a registered closed chat from its snapshot while the scan is pending', () => {
    const snapshot = {
      executionHostId: 'local' as const,
      agent: 'codex' as const,
      sessionId: 'closed',
      title: 'Add Zevari MCP',
      cwd: chatWorktree.path,
      filePath: '/codex-home/sessions/closed.jsonl',
      codexHome: '/codex-home',
      createdAt: new Date(1_000).toISOString(),
      updatedAt: new Date(4_000).toISOString(),
      modifiedAt: new Date(4_000).toISOString()
    }
    const key = chatSessionKey('local', 'codex', 'closed')
    const state = chatState({
      settings: createGlobalSettingsFixture({
        chatSidebar: {
          sessions: {
            [key]: { worktreeId: chatWorktree.id, snapshot },
            [chatSessionKey('local', 'codex', 'mismatch')]: {
              worktreeId: chatWorktree.id,
              snapshot: { ...snapshot, sessionId: 'other' }
            }
          }
        }
      })
    })
    const pending = buildChatSidebarRows(state, [], 10_000)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: key,
      tabId: null,
      title: 'Add Zevari MCP',
      timestamp: 4_000
    })
    expect(pending[0].session).toMatchObject({
      sessionId: 'closed',
      filePath: snapshot.filePath,
      codexHome: '/codex-home',
      cwd: chatWorktree.path
    })
    const scanned = buildChatSidebarRows(
      state,
      [chatSession('closed', { title: 'Renamed by provider', filePath: snapshot.filePath })],
      10_000
    )
    expect(scanned.map((row) => row.title)).toEqual(['Renamed by provider'])
  })
})
