import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getRepoSshConnectionId, parseExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type { useAppStore } from '@/store'

/** Where a new-tab agent launch runs, and the quoting rules that follow from it. */
export type AgentLaunchExecutionContext = {
  /** `undefined` means rival host rows disagree, which is not evidence of a remote. */
  worktreeSshConnectionId: string | null | undefined
  resolvedLaunchPlatform: NodeJS.Platform
  isRemote: boolean
  /** Only set for a local Windows launch; remote targets need their own shell signal. */
  queuedShell: AgentStartupShell | undefined
}

export function resolveAgentLaunchExecutionContext(
  store: ReturnType<typeof useAppStore.getState>,
  args: {
    worktreeId: string
    executionHostId?: ExecutionHostId
    launchPlatform?: NodeJS.Platform
  }
): AgentLaunchExecutionContext {
  const selectedHost = parseExecutionHostId(args.executionHostId)
  const worktree = args.executionHostId
    ? (store.getKnownWorktreeById?.(args.worktreeId, args.executionHostId) ?? null)
    : store.allWorktrees?.().find((entry: { id: string }) => entry.id === args.worktreeId)
  const repo = worktree
    ? args.executionHostId
      ? findRepoForHost(store.repos ?? [], worktree.repoId, { hostId: args.executionHostId })
      : store.repos?.find((entry) => entry.id === worktree.repoId)
    : null
  // Why: `store.repos.find` is host-blind and the same repo id can exist on local, SSH and runtime
  // hosts, so the row it returns can belong to a different host than the worktree names (#11163).
  // The shared resolver answers from the worktree's own host; `undefined` (rival rows disagree) is
  // not evidence of a remote, and main rejects that launch anyway.
  const worktreeSshConnectionId = selectedHost
    ? selectedHost.kind === 'ssh'
      ? selectedHost.targetId
      : repo
        ? getRepoSshConnectionId(repo)
        : null
    : getConnectionIdFromState(store, args.worktreeId)
  const resolvedLaunchPlatform =
    args.launchPlatform ??
    (repo
      ? getAgentLaunchPlatformForRepo(
          repo,
          worktreeSshConnectionId
            ? undefined
            : getLocalProjectExecutionRuntimeContext(store, args.worktreeId)
        )
      : CLIENT_PLATFORM)
  // Why: SSH remotes deploy the shim as plain `orca`, so skip the Linux-only `orca-ide` rename for remote launches.
  const isRemote = Boolean(worktreeSshConnectionId)
  return {
    worktreeSshConnectionId,
    resolvedLaunchPlatform,
    isRemote,
    queuedShell: resolveLocalWindowsAgentStartupShell({
      platform: resolvedLaunchPlatform,
      isRemote,
      terminalWindowsShell: store.settings?.terminalWindowsShell
    })
  }
}
