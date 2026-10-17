import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8').slice('encrypted:'.length)
  }
}))

describe('durable local schedule deferral', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-local-schedule-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  async function waitingDailyRun() {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
    const automation = store.createAutomation({
      name: 'Daily local check',
      prompt: 'Check the repo',
      agentId: 'codex',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })
    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    let ready = false
    const send = vi.fn()
    const service = new AutomationService(store, {
      tickMs: 60_000,
      localScheduleReady: () => ready
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test only exercises these two WebContents methods.
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.start()
    service.setRendererReady()
    await vi.waitFor(() => expect(store.listAutomationRuns(automation.id)).toHaveLength(1))
    return { store, automation, service, send, setReady: () => (ready = true) }
  }

  it("expires yesterday's wait without dropping a newly due daily occurrence", async () => {
    const h = await waitingDailyRun()
    vi.setSystemTime(new Date('2026-05-14T09:01:00'))
    h.setReady()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))
    expect(h.store.listAutomationRuns(h.automation.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduledFor: new Date('2026-05-13T09:00:00').getTime(),
          status: 'skipped_missed'
        }),
        expect.objectContaining({
          scheduledFor: new Date('2026-05-14T09:00:00').getTime(),
          status: 'dispatching'
        })
      ])
    )
    h.service.stop()
  })

  it('does not dispatch a waiting occurrence after the automation was disabled and reenabled', async () => {
    const h = await waitingDailyRun()
    vi.setSystemTime(new Date('2026-05-13T09:02:00'))
    h.store.updateAutomation(h.automation.id, { enabled: false })
    h.store.updateAutomation(h.automation.id, { enabled: true })
    h.setReady()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() =>
      expect(h.store.listAutomationRuns(h.automation.id)[0]?.status).toBe('skipped_unavailable')
    )
    expect(h.send).not.toHaveBeenCalled()
    h.service.stop()
  })

  it('keeps a waiting occurrence when an unrelated run of the same automation finishes', async () => {
    const h = await waitingDailyRun()
    const waiting = h.store.listAutomationRuns(h.automation.id)[0]
    const earlier = h.store.createAutomationRun(
      h.automation,
      new Date('2026-05-13T08:00:00').getTime(),
      'manual'
    )
    h.store.updateAutomationRun({ runId: earlier.id, status: 'completed' })
    expect(
      h.store.listAutomations().find((row) => row.id === h.automation.id)?.updatedAt
    ).toBeGreaterThan(waiting.createdAt)
    h.setReady()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1))
    expect(
      h.store.listAutomationRuns(h.automation.id).find((run) => run.id === waiting.id)?.status
    ).toBe('dispatching')
    expect(h.store.listAutomationRuns(h.automation.id)).toHaveLength(2)
    h.service.stop()
  })
})
