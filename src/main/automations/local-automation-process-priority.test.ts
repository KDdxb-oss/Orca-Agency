import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  automationProcessTreePids,
  scheduleLocalAutomationPriorityFollowups
} from './local-automation-process-priority'

afterEach(() => vi.useRealTimers())

describe('local automation process priority', () => {
  it('includes only the automation terminal descendants', () => {
    expect(
      automationProcessTreePids(100, [
        { pid: 101, ppid: 100 },
        { pid: 102, ppid: 101 },
        { pid: 103, ppid: 100 },
        { pid: 201, ppid: 200 },
        { pid: 202, ppid: 201 }
      ]).sort((a, b) => a - b)
    ).toEqual([101, 102, 103])
  })

  it.skipIf(process.platform !== 'win32')(
    'stops follow-up priority changes when a pane gets a new PTY',
    async () => {
      vi.useFakeTimers()
      let ownsPty = true
      const lower = vi.fn(async () => {})
      scheduleLocalAutomationPriorityFollowups('original-pty', () => ownsPty, lower)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(lower).toHaveBeenCalledExactlyOnceWith('original-pty')

      ownsPty = false
      await vi.advanceTimersByTimeAsync(9_000)
      expect(lower).toHaveBeenCalledTimes(1)
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rechecks an automation-owned PTY after its agent can spawn late tools',
    async () => {
      vi.useFakeTimers()
      const lower = vi.fn(async () => {})
      scheduleLocalAutomationPriorityFollowups('automation-pty', () => true, lower)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(lower).toHaveBeenCalledTimes(2)
      expect(lower).toHaveBeenNthCalledWith(2, 'automation-pty')
    }
  )
})
