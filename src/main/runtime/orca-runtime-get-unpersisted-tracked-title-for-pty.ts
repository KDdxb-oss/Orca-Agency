// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithReconcileRestoredWorkingTitleMonitor } from './orca-runtime-reconcile-restored-working-title-monitor'
import { getDecorativeTitleGateKey } from '../../shared/agent-decorative-title-signature'
import { shouldEmitTitleFactForFrame } from './decorative-title-fact-emission'
import type { RuntimePtyTitleTrackerEntry } from './runtime-terminal-state-records'
import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import {
  detectAgentStatusFromTitle,
  isQuarterCircleSpinnerOnlyAgentTitle
} from '../../shared/agent-detection'
import { CLAUDE_IDLE } from '../../shared/agent-title-core'
import { resolveExplicitTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'
import { AGENT_WORKING_TITLE_REFRESH_AFTER_MS } from '../../shared/agent-working-title-freshness'
import { isCancelledCodexStatus } from '../../shared/codex-cancelled-status-recovery'
import { resolveAgentStatusBinding } from '../ipc/agent-status-ipc-boundary'
import type { TerminalGitHubPRLink } from '../../shared/terminal-github-pr-link-detector'
import { scheduleNativeIdleTitleSettlement } from './native-idle-title-settlement'
import { INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS } from '../agent-hooks/server/server-constants'

export class OrcaRuntimeWithGetUnpersistedTrackedTitleForPty extends OrcaRuntimeWithReconcileRestoredWorkingTitleMonitor {
  protected getUnpersistedTrackedTitleForPty(ptyId: string | null): string | null {
    if (!ptyId || this.getTrackedRawTitleForPty(ptyId) !== null) {
      return null
    }
    // Why: a manual title is authoritative until explicitly cleared with null.
    const pty = this.ptysById.get(ptyId)
    if (pty && pty.title !== null) {
      return null
    }
    return this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ?? null
  }

  /** Why: synthetic agent title frames no longer ride pty:data, so neither
   *  renderer xterm nor the headless emulator observes them. Mobile-parity
   *  snapshot titles must prefer main's tracker over snapshot lastTitle, or
   *  hook-driven spinner/idle titles vanish from mobile tabs. */
  protected preferTrackedLastTitle<T extends { lastTitle?: string }>(
    ptyId: string,
    snapshot: T
  ): T {
    const tracked = this.getTrackedDisplayTitleForPty(ptyId)
    if (!tracked) {
      return snapshot
    }
    return { ...snapshot, lastTitle: tracked }
  }

  /** Decorative comparison key: only recognized agent titles fold leading spinner frames. */
  protected makeDecorativeTitleGateKey(rawTitle: string, normalizedTitle: string): string {
    return getDecorativeTitleGateKey(rawTitle, normalizedTitle)
  }

  protected getOrCreatePtyTitleTrackerEntry(ptyId: string): RuntimePtyTitleTrackerEntry {
    const existing = this.ptyTitleTrackersByPtyId.get(ptyId)
    if (existing) {
      return existing
    }
    // Why: trackers are created lazily on the first observed chunk. After an
    // app relaunch the PTY/leaf records can already hold a persisted title; a
    // cold tracker would miss the parked working→idle completion and never
    // arm the stale-title timer for a persisted 'working' title.
    // A display clear takes precedence so a cold tracker does not re-arm the retired title.
    const pty = this.ptysById.get(ptyId)
    let initialTitle = pty?.titleDisplayClear?.title ?? pty?.lastOscTitle ?? null
    if (initialTitle === null) {
      for (const leaf of this.getLeavesForPty(ptyId)) {
        if (leaf.lastOscTitle) {
          initialTitle = leaf.lastOscTitle
          break
        }
      }
    }
    const tracker = createTerminalTitleTracker(
      {
        onTitle: (normalizedTitle, rawTitle, meta) => {
          const live = this.ptyTitleTrackersByPtyId.get(ptyId)
          const gateKey = this.makeDecorativeTitleGateKey(rawTitle, normalizedTitle)
          const decorativeOnly = live?.lastMobileTitleGateKey === gateKey
          if (!decorativeOnly && !meta?.staleWorkingTitleClear) {
            void this.recheckHookAgentPresenceForPty(ptyId)
          }
          if (live) {
            live.lastMobileTitleGateKey = gateKey
          }
          // Why: the same gate the mobile fan-out below already uses, applied one hop earlier —
          // a spinner frame the renderer store discards should not cost a pty:sideEffect message
          // at all. See decorative-title-fact-emission.ts for why repeats still heartbeat.
          const nowMs = Date.now()
          if (
            shouldEmitTitleFactForFrame({
              decorativeOnly,
              staleWorkingTitleClear: meta?.staleWorkingTitleClear === true,
              lastEmittedAtMs: live?.lastTitleFactAtMs ?? null,
              nowMs
            })
          ) {
            if (live) {
              live.lastTitleFactAtMs = nowMs
            }
            this.recordTerminalSideEffectFact(ptyId, {
              kind: 'title',
              normalizedTitle,
              rawTitle,
              ...(meta?.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
            })
            // Captured native state can repair silent hooks on the same observed process.
            const pty = this.ptysById.get(ptyId)
            const owner = pty?.launchAgent ?? pty?.foregroundAgent
            const nativeStatus = detectAgentStatusFromTitle(rawTitle)
            const explicitOwner = resolveExplicitTerminalTitleAgentType(rawTitle)
            const claudeFrame =
              rawTitle.startsWith(CLAUDE_IDLE) || isQuarterCircleSpinnerOnlyAgentTitle(rawTitle)
            if (
              live?.applyingChunk &&
              !meta?.syntheticTitle &&
              !meta?.staleWorkingTitleClear &&
              (owner === 'codex' || owner === 'claude') &&
              (explicitOwner === null || explicitOwner === owner) &&
              (owner === 'claude' ? claudeFrame || explicitOwner === owner : !claudeFrame) &&
              (nativeStatus === 'working' || (owner === 'claude' && nativeStatus === 'idle'))
            ) {
              const reconcile = () => {
                const paneKey = this.resolveTerminalSideEffectAttribution(ptyId).paneKey
                if (!paneKey) {
                  return
                }
                const observed = this.readObservedAgentStatusPaneIdentityFn(paneKey)
                const current = resolveAgentStatusBinding(paneKey, this)
                const row = (this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []).find(
                  (row) =>
                    row.agentType === owner && (row.state === 'working' || row.state === 'done')
                )
                // Why: an inferred Escape cancellation can outlive a recovered compact. Only
                // fresh provider bytes from the already observed process can contradict it.
                const recoversSettled =
                  row &&
                  row.state === 'done' &&
                  row.sessionBoundary !== true &&
                  !row.restoredUnconfirmed &&
                  this.graphStatus === 'ready' &&
                  observed.kind === 'observed' &&
                  current.kind === 'pane' &&
                  this.getLocalTerminalAgentForPane(paneKey) === owner &&
                  this.ptysById.get(ptyId)?.connected === true &&
                  (row.connectionId ?? null) === null &&
                  (this.ptysById.get(ptyId)?.connectionId ?? null) === null &&
                  this.ptysById.get(ptyId)?.lastAgentStatus === 'working' &&
                  this.ptysById.get(ptyId)?.lastAgentStatusObservedLive === true
                const recoversCancelled = recoversSettled && isCancelledCodexStatus(row)
                const settlesIdle =
                  owner === 'claude' &&
                  nativeStatus === 'idle' &&
                  row?.state === 'working' &&
                  !row.restoredUnconfirmed &&
                  this.graphStatus === 'ready' &&
                  observed.kind === 'observed' &&
                  current.kind === 'pane' &&
                  this.getLocalTerminalAgentForPane(paneKey) === owner &&
                  this.ptysById.get(ptyId)?.connected === true &&
                  this.ptysById.get(ptyId)?.lastAgentStatus === 'idle' &&
                  this.ptysById.get(ptyId)?.lastAgentStatusObservedLive === true &&
                  (row.connectionId ?? null) === null &&
                  (this.ptysById.get(ptyId)?.connectionId ?? null) === null
                const confirmsRestored =
                  row?.restoredUnconfirmed === true &&
                  this.graphStatus === 'ready' &&
                  current.kind === 'pane' &&
                  (!row.terminalHandle || row.terminalHandle === current.terminalHandle) &&
                  this.ptysById.get(ptyId)?.connected === true &&
                  (row.connectionId ?? null) === null &&
                  (this.ptysById.get(ptyId)?.connectionId ?? null) === null &&
                  this.ptysById.get(ptyId)?.lastAgentStatus === 'working' &&
                  this.ptysById.get(ptyId)?.lastAgentStatusObservedLive === true
                if (
                  current.kind === 'unresolved' ||
                  (observed.kind === 'observed'
                    ? observed.terminalHandle !== current.terminalHandle ||
                      observed.processIncarnation !== current.processIncarnation ||
                      observed.dispatchId !==
                        (current.kind === 'worker' ? current.dispatchId : null)
                    : !confirmsRestored) ||
                  !row ||
                  (row.restoredUnconfirmed && !confirmsRestored) ||
                  (!confirmsRestored &&
                    !recoversCancelled &&
                    !recoversSettled &&
                    !settlesIdle &&
                    nowMs - (row.evidenceObservedAt ?? row.receivedAt) <=
                      AGENT_WORKING_TITLE_REFRESH_AFTER_MS)
                ) {
                  return
                }
                const idleDelayMs =
                  INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS + 1 - (Date.now() - row.receivedAt)
                if (settlesIdle && idleDelayMs > 0 && current.kind === 'pane') {
                  const expectedRowAt = row.receivedAt
                  const expectedIncarnation = current.processIncarnation
                  // Let a new turn's native spinner supersede a late idle frame before settling it.
                  scheduleNativeIdleTitleSettlement(this, ptyId, idleDelayMs, () => {
                    const latest = (
                      this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []
                    ).find((entry) => entry.agentType === owner && entry.state === 'working')
                    const binding = resolveAgentStatusBinding(paneKey, this)
                    if (
                      latest?.receivedAt === expectedRowAt &&
                      binding.kind === 'pane' &&
                      binding.processIncarnation === expectedIncarnation &&
                      this.ptysById.get(ptyId)?.lastAgentStatus === 'idle'
                    ) {
                      reconcile()
                    }
                  })
                  return
                }
                this.emitTerminalAgentStatusEvents(
                  ptyId,
                  {
                    payloads: [
                      {
                        state: nativeStatus === 'idle' ? 'done' : 'working',
                        prompt: '',
                        agentType: owner
                      }
                    ]
                  },
                  {
                    evidenceOnly: true,
                    observedTerminalHandle: current.terminalHandle,
                    ...(settlesIdle ? { settleNativeIdleTitle: true } : {}),
                    ...(recoversCancelled ? { recoverCancelledWorkingTitle: true } : {}),
                    ...(recoversSettled ? { recoverSettledWorkingTitle: true } : {}),
                    ...(confirmsRestored
                      ? {
                          confirmRestoredWorkingTitle: true,
                          restoredLaunchToken: this.ptysById.get(ptyId)?.launchToken ?? undefined
                        }
                      : {})
                  }
                )
              }
              this.runAfterPendingTerminalSideEffectFacts(ptyId, reconcile)
            }
          }
          const changed = this.applyTrackedPtyTitle(ptyId, rawTitle, normalizedTitle, meta)
          const identityOnlyTitle = this.isLiveCursorNativeTitle(rawTitle, meta)
          const tracksReplicatedStatus =
            live?.applyingChunk === true && this.mobileSessionTabListeners.size > 0
          const titleStatus = tracksReplicatedStatus ? detectAgentStatusFromTitle(rawTitle) : null
          if (
            tracksReplicatedStatus &&
            decorativeOnly &&
            !this.ptyForegroundAgent.hasDelayedSnapshot(ptyId) &&
            (titleStatus === 'working' || titleStatus === 'permission')
          ) {
            // Normalized Pi/Gemini/Grok frames still renew the replicated status lease.
            this.mobileSessionTabsAgentStatusHeartbeat.scheduleDecorativeHeartbeat(ptyId)
          }
          // Why: an identity-only cursor title records nothing, but the tracker
          // title is that pane's only Cursor identity and must still fan out (#10258).
          if (!changed && !identityOnlyTitle) {
            return
          }
          if (live?.applyingChunk) {
            // Why: synthetic spinner ticks change only the braille glyph
            // ~12.5x/sec; fanning out full mobile session snapshots per frame
            // is pure churn. Raw lastOscTitle updates above stay cheap.
            if (!decorativeOnly) {
              this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
              live.chunkTouchedSessionTabs = true
            }
          } else {
            // Stale-working-title timer path — fires between chunks, so the
            // per-chunk batching in onPtyData cannot pick it up.
            this.mobileSessionTabsAgentStatusHeartbeat.observeSemanticTitle(ptyId)
            this.touchMobileSessionSnapshotsForPty(ptyId)
          }
        },
        // Why: agent transitions and bells become pty:sideEffect facts —
        // main is the single byte parser for local/SSH PTYs; the renderer
        // store handler decides what the facts mean (notification policy).
        onAgentBecameWorking: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-working' })
        },
        onAgentBecameIdle: (title, meta) => {
          this.recordTerminalSideEffectFact(ptyId, {
            kind: 'agent-idle',
            title,
            ...(meta?.staleWorkingTitleClear ? { staleWorkingTitleClear: true } : {})
          })
        },
        onAgentExited: () => {
          this.confirmPtyAgentExit(ptyId)
        },
        onCommandStarted: () => {
          this.openCodeRunLifetime.onCommandStarted(ptyId)
        },
        onCommandFinished: (exitCode: number | null) => {
          void this.recheckHookAgentPresenceForPty(ptyId)
          this.retirePtyAgentLaunchAuthority(ptyId)
          this.recordTerminalSideEffectFact(ptyId, { kind: 'command-finished', exitCode })
          this.openCodeRunLifetime.onCommandFinished(ptyId, exitCode)
        },
        onBell: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
        },
        onPrLink: (link: TerminalGitHubPRLink) => {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link })
        },
        // Why: hidden-delivery-gated views never see 2031 bytes; facts keep their theme registry truthful.
        onMode2031Subscribe: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: '2031-subscribe' })
        },
        onMode2031Unsubscribe: () => {
          this.recordTerminalSideEffectFact(ptyId, { kind: '2031-unsubscribe' })
        }
      },
      initialTitle !== null ? { initialTitle } : {}
    )
    tracker.setTransientSideEffectScanningEnabled(this.terminalSideEffectConsumerAvailable)
    const entry: RuntimePtyTitleTrackerEntry = {
      tracker,
      applyingChunk: false,
      lastMobileTitleGateKey: null,
      lastTitleFactAtMs: null,
      chunkTouchedSessionTabs: false,
      pendingFacts: [],
      afterFacts: [],
      // Why: command-code facts exist only for the pty:sideEffect channel —
      // headless serve skips the per-chunk scrape entirely. The detector
      // self-arms on the Command Code banner; the spawn command (when main
      // saw one) mirrors the renderer detector's startupCommand fast-arm.
      commandCodeDetector: this.terminalSideEffectConsumerAvailable
        ? this.createTerminalSideEffectCommandCodeDetector(ptyId)
        : null
    }
    this.ptyTitleTrackersByPtyId.set(ptyId, entry)
    return entry
  }
}
