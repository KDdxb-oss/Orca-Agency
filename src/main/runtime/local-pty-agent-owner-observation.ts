import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { selectForegroundProcessCandidate } from '../../shared/foreground-process-selection'
import type { TerminalAgent } from '../../shared/terminal-agent'
import type { IPtyProvider } from '../providers/types'
import { queryWindowsPaneProcessInventory } from '../providers/windows-foreground-process-rows'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export type LocalPtyAgentOwnerObservation =
  | { available: false; launchPresent?: boolean; local?: true }
  | { available: true; agent: TerminalAgent | null; launchPresent: boolean }

export async function observeLocalPtyAgentOwner(
  pty: Pick<
    RuntimePtyWorktreeRecord,
    'ptyId' | 'incarnationId' | 'connectionId' | 'isWsl' | 'launchAgent'
  >,
  provider: Pick<IPtyProvider, 'listProcesses'> | null
): Promise<LocalPtyAgentOwnerObservation> {
  if (process.platform !== 'win32' || !provider || pty.connectionId || pty.isWsl !== false) {
    return { available: false }
  }
  try {
    const incarnation = pty.incarnationId
    const ownerProcess = (await provider.listProcesses()).find((entry) => entry.id === pty.ptyId)
    if (
      !ownerProcess?.rootProcessId ||
      ownerProcess.incarnationId !== incarnation ||
      ownerProcess.wslDistro
    ) {
      return { available: false, local: true }
    }
    const inventory = await queryWindowsPaneProcessInventory(ownerProcess.rootProcessId, {
      fresh: true
    })
    if (!inventory || pty.incarnationId !== incarnation) {
      return { available: false, local: true }
    }
    const recognized = inventory.candidates.flatMap((candidate) => {
      const agent = recognizeAgentProcessFromCommandLine(candidate.command)
      return agent ? [agent] : []
    })
    const launchPresent = recognized.some((agent) => agent.agent === pty.launchAgent)
    if (
      inventory.candidates.some(
        (candidate) =>
          !recognizeAgentProcessFromCommandLine(candidate.command) &&
          isAgentForegroundWrapperProcess(candidate.name) &&
          candidate.command.trim().toLowerCase() === candidate.name.trim().toLowerCase()
      )
    ) {
      return { available: false, local: true, launchPresent }
    }
    const selected = selectForegroundProcessCandidate(inventory.candidates)
    if (!selected && recognized.length > 0) {
      return { available: false, local: true, launchPresent }
    }
    return {
      available: true,
      agent: selected?.recognized.agent ?? null,
      launchPresent
    }
  } catch {
    return { available: false, local: true }
  }
}
