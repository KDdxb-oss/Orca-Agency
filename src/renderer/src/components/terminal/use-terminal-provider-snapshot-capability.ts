import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { createTerminalProviderSnapshotBoundPtyIdsSelector } from './terminal-provider-snapshot-bound-pty-ids'
import { startTerminalProviderSnapshotCapabilitySynchronization } from './terminal-provider-snapshot-capability'
import { useTerminalProviderSnapshotCapabilityRevision } from './use-terminal-provider-snapshot-capability-revision'

export function useTerminalProviderSnapshotCapability(enabled: boolean): number {
  // Why the full field set: synchronization PRUNES cached verdicts outside the
  // collected ids, so a collector narrower than startup's (App.tsx refresh
  // passes full state) would evict valid answers for split-leaf and
  // pending-reconnect ptys back into the exempt-by-default unknown state.
  // Why a selector: it returns an identity-stable id set, so the
  // synchronization loop restarts only on genuine id-set changes and title
  // frames and active-leaf moves never reach the collector at all.
  const selectBoundPtyIds = useMemo(() => createTerminalProviderSnapshotBoundPtyIdsSelector(), [])
  const boundPtyIds = useAppStore(selectBoundPtyIds)
  const capabilityRevision = useTerminalProviderSnapshotCapabilityRevision()

  useEffect(() => {
    // Why: hydration exposes restored PTY ids before activation unlocks; prefetching here preserves cold deferral without blocking render.
    if (!enabled && boundPtyIds.length === 0) {
      return
    }
    return startTerminalProviderSnapshotCapabilitySynchronization(boundPtyIds)
  }, [boundPtyIds, enabled])

  return capabilityRevision
}
