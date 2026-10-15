import type { RuntimeTerminalRead, RuntimeTerminalResolvePane } from '../../../shared/runtime-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'

type ComposerAttestedRead = RuntimeTerminalRead & {
  composerState?: 'empty' | 'draft' | 'unknown'
}

export async function verifyEmptyAgentComposer(
  candidate: AgentHibernationCandidate,
  runtimeEnvironmentId: string | null
): Promise<boolean> {
  const target = runtimeEnvironmentId
    ? ({ kind: 'environment', environmentId: runtimeEnvironmentId } as const)
    : ({ kind: 'local' } as const)
  try {
    const resolved = await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
      target,
      'terminal.resolvePane',
      { paneKey: candidate.paneKey, worktreeId: candidate.worktreeId },
      { timeoutMs: 10_000 }
    )
    const terminal = resolved.terminal
    if (
      terminal.connected !== true ||
      terminal.ptyId !== candidate.expectedRuntimePtyIds[0] ||
      terminal.tabId !== candidate.tabId ||
      terminal.leafId !== candidate.leafId
    ) {
      return false
    }
    const read = await callRuntimeRpc<{ terminal: ComposerAttestedRead }>(
      target,
      'terminal.read',
      { terminal: terminal.handle, screen: true },
      { timeoutMs: 10_000 }
    )
    // Why: input timestamps reset on restart, while an unsent TUI draft survives in the PTY.
    return (
      read.terminal.handle === terminal.handle &&
      read.terminal.status === 'running' &&
      read.terminal.source === 'screen' &&
      read.terminal.composerState === 'empty' &&
      !read.terminal.draft
    )
  } catch {
    // An old or unreachable host cannot attest an empty composer.
    return false
  }
}
