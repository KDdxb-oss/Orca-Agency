import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { LocalPtyAgentOwnerObservation } from './local-pty-agent-owner-observation'

function setup() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The subject only reads these ownership fields; terminal buffers and surfaces are outside this unit boundary.
  const pty = {
    connected: true,
    incarnationId: 'inc-1',
    launchAgent: null,
    launchToken: null,
    foregroundAgent: 'codex',
    lastAgentStatus: 'working'
  } as RuntimePtyWorktreeRecord
  let read = 'claude'
  const observe = vi
    .fn<() => Promise<LocalPtyAgentOwnerObservation>>()
    .mockResolvedValue({ available: true, agent: 'codex', launchPresent: false })
  const controller = {
    getForegroundProcess: async () => read,
    write: () => true,
    kill: () => true,
    confirmShellForeground: async () => true
  }
  const subject = new RuntimePtyForegroundAgent({
    getController: () => controller,
    getPty: () => pty,
    touchSnapshot: vi.fn(),
    finishDelayedSnapshot: vi.fn(),
    retireLaunchOwner: () => {
      pty.launchAgent = null
      pty.launchToken = null
    },
    observeLocalOwner: observe
  })
  return {
    subject,
    pty,
    observe,
    setRead: (value: string) => {
      read = value
    }
  }
}

describe('native owner proof reuse', () => {
  it('reuses proof for an unchanged nested read', async () => {
    const c = setup()
    await c.subject.refresh('pty-1')
    await c.subject.refresh('pty-1')
    expect(c.observe).toHaveBeenCalledTimes(1)
    expect(c.pty.foregroundAgent).toBe('codex')
  })

  it('invalidates proof across A, B, A even when B needs no inventory', async () => {
    const c = setup()
    await c.subject.refresh('pty-1')
    c.setRead('codex')
    await c.subject.refresh('pty-1')
    c.setRead('claude')
    c.observe.mockResolvedValue({ available: true, agent: 'claude', launchPresent: false })
    await c.subject.refresh('pty-1')
    expect(c.observe).toHaveBeenCalledTimes(2)
    expect(c.pty.foregroundAgent).toBe('claude')
  })

  it('discards an inventory whose status class changed while it was pending', async () => {
    const c = setup()
    let resolve: ((value: LocalPtyAgentOwnerObservation) => void) | undefined
    c.observe.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const pending = c.subject.refresh('pty-1')
    await vi.waitFor(() => expect(c.observe).toHaveBeenCalledTimes(1))
    c.pty.lastAgentStatus = 'idle'
    resolve?.({ available: true, agent: 'claude', launchPresent: false })
    await pending
    expect(c.pty.foregroundAgent).toBe('codex')
    c.pty.lastAgentStatus = 'working'
    c.observe.mockResolvedValue({ available: true, agent: 'claude', launchPresent: false })
    await c.subject.refresh('pty-1')
    expect(c.observe).toHaveBeenCalledTimes(2)
    expect(c.pty.foregroundAgent).toBe('claude')
  })

  it('reuses managed parent proof across repeated nested reads', async () => {
    const c = setup()
    c.pty.launchAgent = 'codex'
    c.pty.launchToken = 'launch-1'
    c.observe.mockResolvedValue({ available: true, agent: 'codex', launchPresent: true })
    await c.subject.refresh('pty-1')
    await c.subject.refresh('pty-1')
    expect(c.observe).toHaveBeenCalledTimes(1)
    expect(c.pty.launchAgent).toBe('codex')
  })
})
