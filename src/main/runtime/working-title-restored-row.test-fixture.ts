import { expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import type { AgentStatusObservedPaneIdentities } from './agent-status-observed-pane-identity'

export function restoreWorkingRow(context: {
  wiring: ReturnType<typeof makeAgentStatusStoreWiring>
  identities: AgentStatusObservedPaneIdentities
}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Exercise the server's real persistence boundary without starting another HTTP listener.
  const internal = context.wiring.statusStore as unknown as {
    serializeStatusFile(): string
    hydrateLastStatusFromDisk(): void
    lastStatusFilePath: string | null
  }
  const timing = context.wiring.statusStore.getStatusSnapshot()[0]
  const directory = mkdtempSync(join(tmpdir(), 'orca-working-title-'))
  const originalPath = internal.lastStatusFilePath
  try {
    internal.lastStatusFilePath = join(directory, 'last-status.json')
    writeFileSync(internal.lastStatusFilePath, internal.serializeStatusFile())
    internal.hydrateLastStatusFromDisk()
  } finally {
    internal.lastStatusFilePath = originalPath
    rmSync(directory, { recursive: true, force: true })
  }
  const restored = context.wiring.statusStore.getStatusSnapshot()[0]
  expect(restored.restoredUnconfirmed).toBe(true)
  expect(restored.terminalHandle).toBeUndefined()
  vi.spyOn(context.identities, 'read').mockReturnValue({ kind: 'unobserved' })
  return timing
}
