// @ts-nocheck -- Extracted unchanged from the adjacent runtime layer; retained-process behavior is covered by runtime integration tests.
import { OrcaRuntimeWithEmitDaemonPtyTransientFact } from './orca-runtime-emit-daemon-pty-transient-fact'
import { resolveAgentStatusBinding } from '../ipc/agent-status-ipc-boundary'
import { pruneOldestMapEntry } from './prune-oldest-map-entry'

export class OrcaRuntimeWithReconcileRestoredWorkingTitleMonitor extends OrcaRuntimeWithEmitDaemonPtyTransientFact {
  private readonly restoredWorkingTitleMonitors = new Map<string, string>()

  protected reconcileRetainedProviderAttach(ptyId: string): void {
    this.reconcileSubscriberDrivenProviderAttach(ptyId)
    this.reconcileRestoredWorkingTitleMonitor(ptyId)
  }

  protected reconcileRestoredWorkingTitleMonitor(ptyId: string, attempt = 0): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected || pty.connectionId !== null || !pty.paneKey || !pty.incarnationId) {
      return
    }
    const row = (this.getAgentProviderSessionRowsForPaneFn?.(pty.paneKey) ?? []).find(
      (candidate) =>
        candidate.agentType === 'codex' &&
        candidate.state === 'working' &&
        candidate.restoredUnconfirmed === true &&
        (candidate.connectionId ?? null) === null
    )
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    const binding = resolveAgentStatusBinding(pty.paneKey, this)
    if (
      !row ||
      this.graphStatus !== 'ready' ||
      binding.kind !== 'pane' ||
      receipt?.paneKey !== pty.paneKey ||
      receipt?.terminalHandle !== binding.terminalHandle ||
      receipt?.processIncarnation !== binding.processIncarnation ||
      !this.isKnownUnattachedLocalDaemonPty(ptyId) ||
      this.terminalViewSubscribers.hasPendingProviderAttach(ptyId) ||
      (row.terminalHandle && row.terminalHandle !== binding.terminalHandle) ||
      this.restoredWorkingTitleMonitors.get(ptyId) === binding.processIncarnation
    ) {
      return
    }
    const attach = this.ptyController?.attach
    if (!attach) {
      return
    }
    const incarnation = binding.processIncarnation
    this.restoredWorkingTitleMonitors.set(ptyId, incarnation)
    pruneOldestMapEntry(this.restoredWorkingTitleMonitors, 512)
    // Reattach only the inventory-proven local PTY; fresh native bytes confirm status.
    void attach(ptyId)
      .catch(() => false)
      .then((attached) => {
        if (!attached && this.restoredWorkingTitleMonitors.get(ptyId) === incarnation) {
          this.restoredWorkingTitleMonitors.delete(ptyId)
          if (attempt < 2) {
            const retry = setTimeout(
              () => {
                if (this.getTerminalProcessIncarnation(binding.terminalHandle) === incarnation) {
                  this.reconcileRestoredWorkingTitleMonitor(ptyId, attempt + 1)
                }
              },
              500 * (attempt + 1)
            )
            retry.unref()
          }
        }
      })
  }
}
