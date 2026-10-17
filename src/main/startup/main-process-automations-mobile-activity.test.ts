import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  idleSeconds: vi.fn(),
  freeBytes: vi.fn(),
  createService: vi.fn((options: { localScheduleReady?: () => boolean }) => options),
  state: {
    store: {},
    runtime: { hasMobileTerminalSubscribers: vi.fn() },
    claudeUsage: {},
    codexUsage: {},
    isServeMode: false,
    automations: null
  }
}))

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: fixture.idleSeconds } }))
vi.mock('node:os', () => ({ freemem: fixture.freeBytes }))
vi.mock('../automations/runtime-automation-service', () => ({
  createRuntimeAutomationService: fixture.createService
}))
vi.mock('./main-process-state', () => ({ mainProcessState: fixture.state }))

import { initializeMainProcessAutomations } from './main-process-automations'

describe('local scheduled automation admission', () => {
  beforeEach(() => {
    fixture.createService.mockClear()
    fixture.idleSeconds.mockReturnValue(900)
    fixture.freeBytes.mockReturnValue(8 * 1024 ** 3)
    fixture.state.runtime.hasMobileTerminalSubscribers.mockReturnValue(false)
  })

  it('defers new scheduled runs while a phone terminal is open', () => {
    initializeMainProcessAutomations()
    const ready = fixture.createService.mock.calls[0]?.[0].localScheduleReady

    expect(ready?.()).toBe(true)
    fixture.state.runtime.hasMobileTerminalSubscribers.mockReturnValue(true)
    expect(ready?.()).toBe(false)
  })
})
