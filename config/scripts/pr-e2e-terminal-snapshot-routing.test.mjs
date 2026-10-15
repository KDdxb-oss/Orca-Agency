import { describe, expect, it } from 'vitest'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

describe('terminal snapshot E2E routing', () => {
  it('runs host parking and CLI split journeys for capability and parking source', () => {
    for (const source of [
      'src/main/ipc/pty/ipc/inspect.ts',
      'src/renderer/src/app-shell/use-app-startup-hydration.ts',
      'src/renderer/src/components/use-terminal-workspace-projection.ts',
      'src/renderer/src/components/terminal-pane/terminal-cold-park-withheld-tabs.ts',
      'src/renderer/src/components/terminal-pane/terminal-hidden-worktree-retention.ts',
      'src/renderer/src/components/terminal/terminal-provider-snapshot-bound-pty-ids.ts',
      'src/renderer/src/components/terminal/terminal-provider-snapshot-capability.ts',
      'src/renderer/src/components/terminal/use-terminal-provider-snapshot-capability.ts',
      'src/renderer/src/components/terminal/use-terminal-provider-snapshot-capability-revision.ts',
      'src/renderer/src/components/terminal-pane/use-terminal-tab-cold-parking.ts'
    ]) {
      expect(selectPrE2eSpecs([source]), source).toContain(
        'tests/e2e/host-parked-pane-remote-viewer.spec.ts'
      )
      expect(selectPrE2eSpecs([source]), source).toContain(
        'tests/e2e/terminal-parked-cli-split.spec.ts'
      )
      expect(selectPrE2eSpecs([source.replace(/\.ts$/, '.test.ts')]), source).toEqual([])
    }
  })
})
