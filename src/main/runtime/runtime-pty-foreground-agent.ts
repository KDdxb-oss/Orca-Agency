import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { LocalPtyAgentOwnerObservation } from './local-pty-agent-owner-observation'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type {
  PtyForegroundAgentRefresh,
  PtyForegroundProcessRead,
  PtyForegroundProcessReadEntry
} from './runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type Dependencies = {
  getController(): RuntimePtyController | null
  getPty(ptyId: string): RuntimePtyWorktreeRecord | null
  touchSnapshot(ptyId: string): void
  finishDelayedSnapshot(ptyId: string, changed: boolean): void
  retireLaunchOwner(ptyId: string): void
  observeLocalOwner(pty: RuntimePtyWorktreeRecord): Promise<LocalPtyAgentOwnerObservation>
}

export class RuntimePtyForegroundAgent {
  private readonly refreshes = new Map<string, PtyForegroundAgentRefresh>()
  private readonly reads = new Map<string, PtyForegroundProcessReadEntry>()
  private readonly delayedTitles = new Map<string, number>()
  private readonly observedLaunches = new WeakMap<
    RuntimePtyWorktreeRecord,
    {
      agent: RuntimePtyWorktreeRecord['launchAgent']
      token: string | null
      incarnation: string | null
    }
  >()
  private readonly ownerProofs = new WeakMap<
    RuntimePtyWorktreeRecord,
    {
      agent: RuntimePtyWorktreeRecord['launchAgent']
      token: string | null
      incarnation: string | null
      readAgent: RuntimePtyWorktreeRecord['foregroundAgent']
      nativeStatus: RuntimePtyWorktreeRecord['lastAgentStatus']
      observation: LocalPtyAgentOwnerObservation
    }
  >()

  constructor(private readonly deps: Dependencies) {}

  read(ptyId: string, afterTitle = 0): Promise<PtyForegroundProcessRead> | null {
    const controller = this.deps.getController()
    if (!controller) {
      return null
    }
    const pending = this.reads.get(ptyId)
    if (pending?.controller === controller && pending.startedAfterTitleObservation >= afterTitle) {
      return pending.promise
    }
    if (pending?.controller === controller) {
      return pending.promise.then(
        () => this.read(ptyId, afterTitle) ?? { controller, process: null, available: false }
      )
    }
    const unavailable: PtyForegroundProcessRead = { controller, process: null, available: false }
    let processRead: Promise<string | null>
    try {
      processRead = Promise.resolve(controller.getForegroundProcess(ptyId))
    } catch {
      const entry: PtyForegroundProcessReadEntry = {
        controller,
        startedAfterTitleObservation: afterTitle,
        promise: Promise.resolve(unavailable)
      }
      entry.promise = entry.promise.finally(() => this.deleteRead(ptyId, entry))
      this.reads.set(ptyId, entry)
      return entry.promise
    }
    let entry: PtyForegroundProcessReadEntry
    const promise = processRead
      .then((process) => ({ controller, process, available: true }))
      .catch(() => unavailable)
      .finally(() => this.deleteRead(ptyId, entry))
    entry = { controller, startedAfterTitleObservation: afterTitle, promise }
    this.reads.set(ptyId, entry)
    return entry.promise
  }

  refresh(ptyId: string, afterTitle = 0): Promise<boolean> {
    const pending = this.refreshes.get(ptyId)
    if (pending) {
      pending.requestedAfterTitleObservation = Math.max(
        pending.requestedAfterTitleObservation,
        afterTitle
      )
      return pending.promise
    }
    const entry: PtyForegroundAgentRefresh = {
      promise: Promise.resolve(false),
      startedAfterTitleObservation: afterTitle,
      requestedAfterTitleObservation: afterTitle
    }
    entry.promise = (async () => {
      while (true) {
        entry.startedAfterTitleObservation = entry.requestedAfterTitleObservation
        const changed = await this.load(ptyId, entry.startedAfterTitleObservation)
        if (changed || entry.requestedAfterTitleObservation <= entry.startedAfterTitleObservation) {
          return changed
        }
      }
    })().finally(() => {
      if (this.refreshes.get(ptyId) === entry) {
        this.refreshes.delete(ptyId)
      }
    })
    this.refreshes.set(ptyId, entry)
    return entry.promise
  }

  getPending(ptyId: string, afterTitle: number): Promise<boolean> | undefined {
    return this.refreshes.has(ptyId) ? this.refresh(ptyId, afterTitle) : undefined
  }

  getReads(): ReadonlyMap<string, PtyForegroundProcessReadEntry> {
    return this.reads
  }

  delaySnapshot(ptyId: string, titleAt: number, refresh: Promise<boolean>): void {
    this.delayedTitles.set(ptyId, titleAt)
    void refresh.then((changed) => {
      if (this.delayedTitles.get(ptyId) !== titleAt) {
        return
      }
      this.delayedTitles.delete(ptyId)
      this.deps.finishDelayedSnapshot(ptyId, changed)
    })
  }

  hasDelayedSnapshot(ptyId: string): boolean {
    return this.delayedTitles.has(ptyId)
  }

  clearDelayedSnapshot(ptyId: string): void {
    this.delayedTitles.delete(ptyId)
  }

  private async load(ptyId: string, afterTitle: number): Promise<boolean> {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    if (!controller || !pty?.connected) {
      return false
    }
    const incarnation = pty.incarnationId
    const launchAgent = pty.launchAgent
    const launchToken = pty.launchToken
    const result = await this.read(ptyId, afterTitle)
    if (
      !result ||
      result.controller !== this.deps.getController() ||
      !result.available ||
      this.deps.getPty(ptyId) !== pty ||
      pty.incarnationId !== incarnation ||
      pty.launchAgent !== launchAgent ||
      pty.launchToken !== launchToken ||
      !pty.connected
    ) {
      return false
    }
    const readAgent = result.process ? (recognizeAgentProcess(result.process)?.agent ?? null) : null
    const nativeStatus = pty.lastAgentStatus
    const observedLaunch = this.observedLaunches.get(pty)
    const launchWasObserved =
      observedLaunch?.agent === launchAgent &&
      observedLaunch?.token === launchToken &&
      observedLaunch?.incarnation === incarnation
    const previousProof = this.ownerProofs.get(pty)
    const reusableProof =
      previousProof?.agent === launchAgent &&
      previousProof.token === launchToken &&
      previousProof.incarnation === incarnation &&
      previousProof.readAgent === readAgent &&
      previousProof.nativeStatus === nativeStatus &&
      previousProof.observation.available
    if (!reusableProof) {
      this.ownerProofs.delete(pty)
    }
    const needsOwnerProof = pty.launchAgent
      ? readAgent !== pty.launchAgent || !launchWasObserved
      : readAgent !== pty.foregroundAgent
    const localOwner: LocalPtyAgentOwnerObservation =
      reusableProof && (!launchAgent || launchWasObserved)
        ? previousProof.observation
        : needsOwnerProof
          ? await this.deps.observeLocalOwner(pty)
          : { available: false }
    if (
      this.deps.getPty(ptyId) !== pty ||
      pty.incarnationId !== incarnation ||
      pty.launchAgent !== launchAgent ||
      pty.launchToken !== launchToken ||
      pty.lastAgentStatus !== nativeStatus ||
      this.deps.getController() !== controller ||
      !pty.connected
    ) {
      return false
    }
    if (needsOwnerProof && localOwner.available) {
      this.ownerProofs.set(pty, {
        agent: launchAgent,
        token: launchToken,
        incarnation,
        readAgent,
        nativeStatus,
        observation: localOwner
      })
    }
    if (pty.launchAgent && localOwner.launchPresent) {
      this.observedLaunches.set(pty, { agent: launchAgent, token: launchToken, incarnation })
    }
    if (pty.launchAgent) {
      // A complete local inventory distinguishes the parent from its nested tools.
      if (readAgent !== pty.launchAgent) {
        if (
          !localOwner.available ||
          localOwner.launchPresent ||
          (pty.launchToken && !launchWasObserved && !localOwner.agent)
        ) {
          return false
        }
        if (!localOwner.agent && !(await controller.confirmShellForeground?.(ptyId))) {
          return false
        }
        if (
          this.deps.getPty(ptyId) !== pty ||
          pty.incarnationId !== incarnation ||
          pty.launchAgent !== launchAgent ||
          pty.launchToken !== launchToken ||
          pty.lastAgentStatus !== nativeStatus ||
          this.deps.getController() !== controller ||
          !pty.connected
        ) {
          return false
        }
        this.deps.retireLaunchOwner(ptyId)
      }
    }
    // An ambiguous or unreadable local lineage cannot transfer an existing owner.
    const agent = localOwner.available
      ? localOwner.agent
      : needsOwnerProof && localOwner.local && pty.foregroundAgent
        ? pty.foregroundAgent
        : readAgent
    if (pty.foregroundAgent === agent) {
      return false
    }
    pty.foregroundAgent = agent
    this.deps.touchSnapshot(ptyId)
    return true
  }

  private deleteRead(ptyId: string, entry: PtyForegroundProcessReadEntry): void {
    if (this.reads.get(ptyId) === entry) {
      this.reads.delete(ptyId)
    }
  }
}
