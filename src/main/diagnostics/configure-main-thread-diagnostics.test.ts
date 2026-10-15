import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  observer: vi.fn(),
  capture: vi.fn(),
  record: vi.fn()
}))
vi.mock('./main-thread-churn-probe', () => ({
  isMainThreadDiagnosticsEnabled: () =>
    process.env.ORCA_MAIN_THREAD_DIAGNOSTICS === '1' ||
    process.argv.includes('--orca-main-thread-diagnostics'),
  recordSubprocessSpawn: mocks.record,
  startMainThreadChurnProbe: mocks.probe
}))
vi.mock('./main-thread-file-capture', () => ({ createMainThreadFileCapture: mocks.capture }))
vi.mock('../../shared/child-process/spawn-observer', () => ({ setSpawnObserver: mocks.observer }))
vi.mock('../git/source-control/git-read-cache-invalidation', () => ({
  settledDiffCache: { stats: () => ({ hits: 3 }) }
}))
import { configureMainThreadDiagnostics } from './configure-main-thread-diagnostics'

const originalArgv = process.argv
afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it('enables automatic file capture from the explicit launch option', () => {
  process.argv = [...originalArgv, '--orca-main-thread-diagnostics']
  vi.stubEnv('ORCA_MAIN_THREAD_DIAGNOSTICS', '')
  const sink = vi.fn()
  mocks.capture.mockReturnValue(sink)
  configureMainThreadDiagnostics('/profile')
  expect(process.env.ORCA_MAIN_THREAD_DIAGNOSTICS).toBe('')
  expect(mocks.capture).toHaveBeenCalledWith(join('/profile', 'diagnostics', 'main-thread.jsonl'))
  expect(mocks.observer).toHaveBeenCalledWith(mocks.record)
  expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ writeLine: sink }))
})

it('preserves stderr capture for the existing environment variable', () => {
  process.argv = originalArgv.filter((x) => x !== '--orca-main-thread-diagnostics')
  vi.stubEnv('ORCA_MAIN_THREAD_DIAGNOSTICS', '1')
  configureMainThreadDiagnostics('/profile')
  expect(mocks.observer).toHaveBeenCalledWith(mocks.record)
  expect(mocks.capture).not.toHaveBeenCalled()
  expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ writeLine: undefined }))
})

it('does not install the spawn observer or disk capture when diagnostics are disabled', () => {
  process.argv = originalArgv.filter((x) => x !== '--orca-main-thread-diagnostics')
  vi.stubEnv('ORCA_MAIN_THREAD_DIAGNOSTICS', '')
  configureMainThreadDiagnostics('/profile')
  expect(mocks.observer).not.toHaveBeenCalled()
  expect(mocks.capture).not.toHaveBeenCalled()
})
