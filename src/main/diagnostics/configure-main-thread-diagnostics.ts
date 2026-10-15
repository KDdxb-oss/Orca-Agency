import { join } from 'node:path'
import {
  isMainThreadDiagnosticsEnabled,
  recordSubprocessSpawn,
  startMainThreadChurnProbe
} from './main-thread-churn-probe'
import { createMainThreadFileCapture } from './main-thread-file-capture'
import { setSpawnObserver } from '../../shared/child-process/spawn-observer'
import { settledDiffCache } from '../git/source-control/git-read-cache-invalidation'

export function configureMainThreadDiagnostics(userDataPath: string): void {
  const capture = process.argv.includes('--orca-main-thread-diagnostics')
  if (isMainThreadDiagnosticsEnabled()) {
    setSpawnObserver(recordSubprocessSpawn)
  }
  startMainThreadChurnProbe({
    extraStats: () => ({ diffCache: settledDiffCache.stats() }),
    writeLine: capture
      ? createMainThreadFileCapture(join(userDataPath, 'diagnostics', 'main-thread.jsonl'))
      : undefined
  })
}
