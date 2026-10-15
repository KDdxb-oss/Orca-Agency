import type { OrcaRuntimeWithReconcileRestoredWorkingTitleMonitor } from './orca-runtime-reconcile-restored-working-title-monitor'

const pendingByOwner = new WeakMap<object, Map<string, ReturnType<typeof setTimeout>>>()

export function scheduleNativeIdleTitleSettlement(
  owner: OrcaRuntimeWithReconcileRestoredWorkingTitleMonitor,
  ptyId: string,
  delayMs: number,
  settle: () => void
): void {
  let pending = pendingByOwner.get(owner)
  if (!pending) {
    pending = new Map()
    pendingByOwner.set(owner, pending)
  }
  const previous = pending.get(ptyId)
  if (previous) {
    clearTimeout(previous)
  }
  const timer = setTimeout(() => {
    pending.delete(ptyId)
    settle()
  }, delayMs)
  timer.unref?.()
  pending.set(ptyId, timer)
}
