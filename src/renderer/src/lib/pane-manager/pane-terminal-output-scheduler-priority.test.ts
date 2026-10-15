import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTerminal, loadScheduler } from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: true } }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

describe('terminal output priority fairness', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('serves queued echo first after a 16-pane bulk drain is paced', async () => {
    const { writeTerminalOutput } = await loadScheduler()
    const terminals = Array.from({ length: 16 }, () => createTerminal())
    const order: number[] = []
    terminals.forEach((terminal, index) => {
      terminal.write.mockImplementation((_data, callback) => {
        order.push(index)
        callback?.()
      })
      writeTerminalOutput(terminal, 'redraw', { foreground: true, latencySensitive: false })
    })
    writeTerminalOutput(terminals[15], 'echo', { foreground: true, latencySensitive: true })

    vi.advanceTimersByTime(0)
    expect(order).toEqual([])
    vi.advanceTimersByTime(4)
    expect(order[0]).toBe(15)
    expect(order.length).toBeGreaterThanOrEqual(8)
  })

  it('lets another visible stream progress before the echo pane drains its later bulk', async () => {
    const { writeTerminalOutput, queuedByTerminal } = await loadScheduler()
    const busy = createTerminal()
    const other = createTerminal()
    const chunk = 'b'.repeat(16 * 1024)
    const order: string[] = []
    busy.write.mockImplementation((_data, callback) => {
      order.push('busy')
      callback?.()
    })
    other.write.mockImplementation((_data, callback) => {
      order.push('other')
      callback?.()
    })
    writeTerminalOutput(busy, chunk, { foreground: true, latencySensitive: false })
    writeTerminalOutput(busy, 'echo', { foreground: true, latencySensitive: true })
    writeTerminalOutput(busy, chunk.repeat(20), { foreground: true, latencySensitive: false })
    writeTerminalOutput(other, chunk, { foreground: true, latencySensitive: false })

    vi.advanceTimersByTime(0)

    expect(order.slice(0, 2)).toEqual(['busy', 'other'])
    expect(busy.write.mock.calls.map(([data]) => data).join('')).toContain('echo')
    expect(queuedByTerminal.get(busy)?.queuedChars).toBeGreaterThan(0)
    expect(queuedByTerminal.get(busy)?.interactiveCharsRemaining).toBe(0)
    for (let wave = 0; wave < 4; wave++) {
      writeTerminalOutput(busy, chunk.repeat(32), { foreground: true, latencySensitive: false })
      writeTerminalOutput(other, chunk, { foreground: true, latencySensitive: false })
      vi.advanceTimersByTime(1)
      expect(other.write).toHaveBeenCalledTimes(wave + 2)
      expect(queuedByTerminal.get(busy)?.queuedChars).toBeGreaterThan(0)
      expect(queuedByTerminal.get(busy)?.backgroundBacklogDropped).toBe(false)
    }
  })

  it('rotates visible output even when the leading pane keeps renewing echo priority', async () => {
    const { writeTerminalOutput, queuedByTerminal } = await loadScheduler()
    const busy = createTerminal()
    const other = createTerminal()
    const chunk = 'b'.repeat(16 * 1024)
    writeTerminalOutput(other, chunk, { foreground: true, latencySensitive: false })
    writeTerminalOutput(busy, chunk, {
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true
    })
    writeTerminalOutput(busy, chunk.repeat(20), { foreground: true, latencySensitive: false })

    vi.advanceTimersByTime(0)

    expect(busy.write.mock.invocationCallOrder[0]).toBeLessThan(
      other.write.mock.invocationCallOrder[0]
    )
    expect(other.write).toHaveBeenCalledWith(chunk, expect.any(Function))
    for (let wave = 0; wave < 4; wave++) {
      writeTerminalOutput(busy, chunk.repeat(32), { foreground: true, latencySensitive: true })
      writeTerminalOutput(other, chunk, { foreground: true, latencySensitive: false })
      vi.advanceTimersByTime(1)
      expect(other.write).toHaveBeenCalledTimes(wave + 2)
      expect(queuedByTerminal.get(busy)?.queuedChars).toBeGreaterThan(0)
      expect(queuedByTerminal.get(busy)?.backgroundBacklogDropped).toBe(false)
    }
  })

  it('retires the interactive prefix during a bounded explicit flush', async () => {
    const { writeTerminalOutput, flushTerminalOutput, queuedByTerminal } = await loadScheduler()
    const terminal = createTerminal()
    const chunk = 'b'.repeat(16 * 1024)
    writeTerminalOutput(terminal, chunk, { foreground: true, latencySensitive: false })
    writeTerminalOutput(terminal, 'echo', { foreground: true, latencySensitive: true })
    writeTerminalOutput(terminal, chunk.repeat(4), { foreground: true, latencySensitive: false })

    flushTerminalOutput(terminal, { maxChars: 32 * 1024 })

    expect(terminal.write.mock.calls.map(([data]) => data).join('')).toContain('echo')
    expect(queuedByTerminal.get(terminal)?.interactiveCharsRemaining).toBe(0)
    expect(queuedByTerminal.get(terminal)?.queuedChars).toBeGreaterThan(0)
  })

  it('clears echo priority when output moves to the hidden background', async () => {
    const { writeTerminalOutput, queuedByTerminal } = await loadScheduler()
    const terminal = createTerminal()
    writeTerminalOutput(terminal, 'echo', {
      foreground: true,
      latencySensitive: true,
      coalesceForeground: true
    })
    expect(queuedByTerminal.get(terminal)?.interactiveCharsRemaining).toBe(4)

    writeTerminalOutput(terminal, 'hidden', { foreground: false })

    expect(queuedByTerminal.get(terminal)?.interactiveCharsRemaining).toBe(0)
  })
})
