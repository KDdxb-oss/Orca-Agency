import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeLocalPtyAgentOwner } from './local-pty-agent-owner-observation'
import { queryWindowsPaneProcessInventory } from '../providers/windows-foreground-process-rows'

vi.mock('../providers/windows-foreground-process-rows', () => ({
  queryWindowsPaneProcessInventory: vi.fn()
}))
const query = vi.mocked(queryWindowsPaneProcessInventory)
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
const pty = {
  ptyId: 'pty-1',
  incarnationId: 'inc-1',
  connectionId: null,
  isWsl: false,
  launchAgent: 'codex' as const
}
const provider = {
  listProcesses: vi.fn(async () => [
    {
      id: 'pty-1',
      incarnationId: 'inc-1',
      rootProcessId: 100,
      cwd: '',
      title: 'shell',
      wslDistro: null
    }
  ])
}
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  query.mockReset()
  provider.listProcesses.mockClear()
})

describe('local native agent owner observation', () => {
  it('uses the outer Codex process while a nested Claude and shell are running', async () => {
    query.mockResolvedValue({
      anchorRow: null,
      candidates: [
        { pid: 101, ppid: 100, depth: 1, name: 'codex.exe', command: 'codex.exe' },
        { pid: 102, ppid: 101, depth: 2, name: 'powershell.exe', command: 'powershell.exe' },
        { pid: 103, ppid: 102, depth: 3, name: 'claude.exe', command: 'claude.exe' },
        {
          pid: 104,
          ppid: 101,
          depth: 2,
          name: 'node.exe',
          command: 'node.exe C:\\mcp\\server-filesystem\\dist\\index.js'
        }
      ]
    })
    expect(await observeLocalPtyAgentOwner(pty, provider)).toEqual({
      available: true,
      agent: 'codex',
      launchPresent: true
    })
    expect(query).toHaveBeenCalledWith(100, { fresh: true })
  })

  it('observes a replacement outer Claude without requiring a neutral shell title', async () => {
    query.mockResolvedValue({
      anchorRow: null,
      candidates: [{ pid: 103, ppid: 100, depth: 1, name: 'claude.exe', command: 'claude.exe' }]
    })
    expect(await observeLocalPtyAgentOwner(pty, provider)).toEqual({
      available: true,
      agent: 'claude',
      launchPresent: false
    })
  })

  it('keeps recognized launch presence when another wrapper is unreadable', async () => {
    query.mockResolvedValue({
      anchorRow: null,
      candidates: [
        { pid: 101, ppid: 100, depth: 1, name: 'codex.exe', command: 'codex.exe' },
        { pid: 102, ppid: 101, depth: 2, name: 'node.exe', command: 'node.exe' }
      ]
    })
    expect(await observeLocalPtyAgentOwner(pty, provider)).toEqual({
      available: false,
      local: true,
      launchPresent: true
    })
  })

  it('does not report ambiguous sibling agents as an empty tree', async () => {
    query.mockResolvedValue({
      anchorRow: null,
      candidates: [
        { pid: 101, ppid: 100, depth: 1, name: 'codex.exe', command: 'codex.exe' },
        { pid: 102, ppid: 100, depth: 1, name: 'claude.exe', command: 'claude.exe' }
      ]
    })
    expect(await observeLocalPtyAgentOwner(pty, provider)).toEqual({
      available: false,
      local: true,
      launchPresent: true
    })
  })

  it.each(['missing-root', 'unreadable-wrapper', 'incarnation', 'ssh', 'wsl'])(
    'does not infer ownership from %s',
    async (kind) => {
      query.mockResolvedValue(
        kind === 'missing-root'
          ? null
          : {
              anchorRow: null,
              candidates: [{ pid: 101, ppid: 100, depth: 1, name: 'node.exe', command: 'node.exe' }]
            }
      )
      const target = {
        ...pty,
        ...(kind === 'incarnation' ? { incarnationId: 'other' } : {}),
        ...(kind === 'ssh' ? { connectionId: 'remote' } : {}),
        ...(kind === 'wsl' ? { isWsl: true } : {})
      }
      expect(await observeLocalPtyAgentOwner(target, provider)).toEqual(
        kind === 'unreadable-wrapper'
          ? { available: false, local: true, launchPresent: false }
          : kind === 'ssh' || kind === 'wsl'
            ? { available: false }
            : { available: false, local: true }
      )
    }
  )
})
