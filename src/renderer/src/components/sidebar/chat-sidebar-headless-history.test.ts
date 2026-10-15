import { expect, it, vi } from 'vitest'
import type { ChatSidebarSettings } from '../../../../shared/chat-sidebar-settings'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatSession, chatState, chatWorktree } from './chat-sidebar-test-fixtures'
import { chatSessionSnapshot } from './chat-sidebar-session-snapshot'
import { chatSessionKey } from './chat-sidebar-types'
import { classifyUnscannedClaudeHistory } from './chat-sidebar-headless-history'
import { chatSidebarPreferencePatch } from './chat-sidebar-identity'

it('classifies a saved Claude transcript omitted from the bounded history scan', async () => {
  const session = chatSession('older-headless', { agent: 'claude' })
  const key = chatSessionKey('local', 'claude', session.sessionId)
  const snapshot = chatSessionSnapshot(session)
  expect(snapshot.isHeadless).toBeUndefined()
  let current: ChatSidebarSettings = {
    sessions: {
      [key]: { worktreeId: chatWorktree.id, snapshot }
    }
  }
  const resolveTitles = vi.fn(async () => ({
    titles: [
      {
        agent: 'claude' as const,
        sessionId: session.sessionId,
        title: session.title,
        isHeadless: true
      }
    ]
  }))
  const stateBeforeLookup = chatState()
  stateBeforeLookup.settings!.chatSidebar = current
  const rowsBeforeLookup = buildChatSidebarRows(stateBeforeLookup, [], 10_000)
  expect(rowsBeforeLookup).toHaveLength(1)
  const ordinarySave = chatSidebarPreferencePatch(rowsBeforeLookup, current, 10_000, {
    scannedSessions: []
  })
  if (ordinarySave) {
    current = { ...current, ...ordinarySave }
  }
  expect(current.sessions?.[key].snapshot?.isHeadless).toBeUndefined()
  await classifyUnscannedClaudeHistory({
    sessions: current.sessions,
    scannedSessions: [],
    resolveTitles,
    update: (patch) => {
      const changed = patch(current)
      if (changed) {
        current = { ...current, ...changed }
      }
    },
    signal: new AbortController().signal
  })

  expect(resolveTitles).toHaveBeenCalledWith({
    executionHostScope: 'local',
    requests: [{ agent: 'claude', sessionId: session.sessionId, transcriptPath: session.filePath }]
  })
  expect(current.sessions?.[key].snapshot?.isHeadless).toBe(true)
  const staleSave = chatSidebarPreferencePatch(rowsBeforeLookup, current, 10_000, {
    scannedSessions: []
  })
  if (staleSave) {
    current = { ...current, ...staleSave }
  }
  expect(current.sessions?.[key].snapshot?.isHeadless).toBe(true)
  const state = chatState()
  state.settings!.chatSidebar = current
  expect(buildChatSidebarRows(state, [], 10_000)).toEqual([])
  const interactive = {
    ...session,
    isHeadless: undefined,
    updatedAt: new Date(3_000).toISOString(),
    modifiedAt: new Date(3_000).toISOString()
  }
  const interactiveRows = buildChatSidebarRows(state, [interactive], 10_000)
  expect(interactiveRows).toHaveLength(1)
  const interactiveSave = chatSidebarPreferencePatch(interactiveRows, current, 10_000, {
    scannedSessions: [interactive]
  })
  expect(interactiveSave?.sessions?.[key]).toBeDefined()
  expect(interactiveSave?.sessions?.[key].snapshot?.isHeadless).toBeUndefined()
  state.settings!.chatSidebar = { ...current, ...interactiveSave }
  expect(buildChatSidebarRows(state, [], 10_000)).toHaveLength(1)
})

it('retries a fully empty remote result after a later scan', async () => {
  const session = chatSession('remote-headless', {
    agent: 'claude',
    executionHostId: 'ssh:host'
  })
  const key = chatSessionKey(session.executionHostId, 'claude', session.sessionId)
  const current: ChatSidebarSettings = {
    sessions: { [key]: { worktreeId: chatWorktree.id, snapshot: chatSessionSnapshot(session) } }
  }
  const attemptedEmpty = new Set<string>()
  const resolveTitles = vi.fn(async () => ({ titles: [] }))
  const args = {
    sessions: current.sessions,
    scannedSessions: [],
    resolveTitles,
    update: vi.fn(),
    signal: new AbortController().signal,
    attemptedEmpty
  }
  await classifyUnscannedClaudeHistory(args)
  await classifyUnscannedClaudeHistory(args)
  expect(resolveTitles).toHaveBeenCalledTimes(2)
  expect(attemptedEmpty.size).toBe(0)
})

it('remembers a missing local transcript during this app session', async () => {
  const session = chatSession('missing-local', { agent: 'claude' })
  const key = chatSessionKey('local', 'claude', session.sessionId)
  const current: ChatSidebarSettings = {
    sessions: { [key]: { worktreeId: chatWorktree.id, snapshot: chatSessionSnapshot(session) } }
  }
  const attemptedEmpty = new Set<string>()
  const resolveTitles = vi.fn(async () => ({ titles: [] }))
  const args = {
    sessions: current.sessions,
    scannedSessions: [],
    resolveTitles,
    update: vi.fn(),
    signal: new AbortController().signal,
    attemptedEmpty
  }
  await classifyUnscannedClaudeHistory(args)
  await classifyUnscannedClaudeHistory(args)
  expect(resolveTitles).toHaveBeenCalledTimes(1)
  expect(attemptedEmpty.size).toBe(1)
})

it('retries a fully empty WSL transcript result after a later scan', async () => {
  const session = chatSession('wsl-headless', {
    agent: 'claude',
    filePath: '//wsl.localhost/Ubuntu/home/user/.claude/projects/work/session.jsonl'
  })
  const key = chatSessionKey('local', 'claude', session.sessionId)
  const current: ChatSidebarSettings = {
    sessions: { [key]: { worktreeId: chatWorktree.id, snapshot: chatSessionSnapshot(session) } }
  }
  const attemptedEmpty = new Set<string>()
  const resolveTitles = vi.fn(async () => ({ titles: [] }))
  const args = {
    sessions: current.sessions,
    scannedSessions: [],
    resolveTitles,
    update: vi.fn(),
    signal: new AbortController().signal,
    attemptedEmpty
  }
  await classifyUnscannedClaudeHistory(args)
  await classifyUnscannedClaudeHistory(args)
  expect(resolveTitles).toHaveBeenCalledTimes(2)
  expect(attemptedEmpty.size).toBe(0)
})

it('retries a WSL miss when a Windows transcript in the same batch resolves', async () => {
  const windows = chatSession('windows-title', { agent: 'claude' })
  const wsl = chatSession('wsl-missing', {
    agent: 'claude',
    filePath: '//wsl.localhost/Ubuntu/home/user/.claude/projects/work/session.jsonl'
  })
  const windowsKey = chatSessionKey('local', 'claude', windows.sessionId)
  const wslKey = chatSessionKey('local', 'claude', wsl.sessionId)
  const current: ChatSidebarSettings = {
    sessions: {
      [windowsKey]: { worktreeId: chatWorktree.id, snapshot: chatSessionSnapshot(windows) },
      [wslKey]: { worktreeId: chatWorktree.id, snapshot: chatSessionSnapshot(wsl) }
    }
  }
  const attemptedEmpty = new Set<string>()
  const resolveTitles = vi.fn(async () => ({
    titles: [
      {
        agent: 'claude' as const,
        sessionId: windows.sessionId,
        title: windows.title,
        isHeadless: false
      }
    ]
  }))
  const args = {
    sessions: current.sessions,
    scannedSessions: [],
    resolveTitles,
    update: vi.fn(),
    signal: new AbortController().signal,
    attemptedEmpty
  }
  await classifyUnscannedClaudeHistory(args)
  await classifyUnscannedClaudeHistory(args)
  expect(resolveTitles).toHaveBeenCalledTimes(2)
  expect(resolveTitles).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      requests: expect.arrayContaining([
        { agent: 'claude', sessionId: wsl.sessionId, transcriptPath: wsl.filePath }
      ])
    })
  )
  expect(attemptedEmpty.size).toBe(0)
})

it('does not classify a saved row whose transcript was changed while lookup ran', async () => {
  const session = chatSession('older-headless', { agent: 'claude' })
  const key = chatSessionKey('local', 'claude', session.sessionId)
  const snapshot = chatSessionSnapshot(session)
  expect(snapshot.isHeadless).toBeUndefined()
  let current: ChatSidebarSettings = {
    sessions: {
      [key]: { worktreeId: chatWorktree.id, snapshot }
    }
  }
  await classifyUnscannedClaudeHistory({
    sessions: current.sessions,
    scannedSessions: [],
    resolveTitles: async () => {
      current = {
        sessions: {
          [key]: {
            worktreeId: chatWorktree.id,
            snapshot: { ...chatSessionSnapshot(session), filePath: '/moved/session.jsonl' }
          }
        }
      }
      return {
        titles: [
          {
            agent: 'claude',
            sessionId: session.sessionId,
            title: session.title,
            isHeadless: true
          }
        ]
      }
    },
    update: (patch) => {
      const changed = patch(current)
      if (changed) {
        current = { ...current, ...changed }
      }
    },
    signal: new AbortController().signal
  })
  expect(current.sessions?.[key].snapshot?.filePath).toBe('/moved/session.jsonl')
  expect(current.sessions?.[key].snapshot?.isHeadless).toBeUndefined()
})
