import { useSyncExternalStore } from 'react'
import {
  getTerminalProviderSnapshotCapabilityRevision,
  subscribeTerminalProviderSnapshotCapability
} from './terminal-provider-snapshot-capability'

export function useTerminalProviderSnapshotCapabilityRevision(): number {
  return useSyncExternalStore(
    subscribeTerminalProviderSnapshotCapability,
    getTerminalProviderSnapshotCapabilityRevision,
    getTerminalProviderSnapshotCapabilityRevision
  )
}
