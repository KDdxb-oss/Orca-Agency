import type { AppState } from '@/store'
import {
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan,
  resolveStartupShell
} from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { agentResumeOriginNamesAnotherExecutionHost } from '@/lib/sleeping-record-execution-host-scope'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getCachedWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { CODEX_ACCOUNT_RESTART_STARTUP } from '@/lib/codex-session-restart'
import { isSameCodexRestartNoticeAccount } from '@/store/slices/codex-restart-notice-account-identity'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { buildAgentResumeLaunchCommand } from '../../../../shared/agent-resume-launch-command'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import type { PtyPaneStartup } from './pty-connection-types'
import { savedTabResume } from './pty-connection/saved-tab-resume'
import { savedResumePaths } from './pty-connection/saved-resume-paths'
import { isRemoteRuntimePtyId } from './pty-connection/paired-parked-terminal-restore'

/** Capture resume identity before restart clears the old PTY's pane binding. */
export function codexRestartResumeStartup(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string | null,
  cwd?: string,
  ptyId?: string | null
): NonNullable<PtyPaneStartup> {
  let fallback: NonNullable<PtyPaneStartup> = {
    ...CODEX_ACCOUNT_RESTART_STARTUP,
    command: 'codex resume'
  }
  const tab = state.tabsByWorktree[worktreeId]?.find((item) => item.id === tabId)
  const paneKey = leafId ? makePaneKey(tabId, leafId) : undefined
  const boundPtyId =
    ptyId ?? (leafId ? state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] : tab?.ptyId)
  const notice = boundPtyId ? state.codexRestartNoticeByPtyId[boundPtyId] : undefined
  // Account switches retain their existing launch contract; this resumes configuration restarts.
  if (
    notice &&
    !isSameCodexRestartNoticeAccount(
      { id: notice.previousAccountId, label: notice.previousAccountLabel },
      { id: notice.nextAccountId, label: notice.nextAccountLabel }
    )
  ) {
    return CODEX_ACCOUNT_RESTART_STARTUP
  }
  if (!tab) {
    return fallback
  }
  const hostId = getKnownExecutionHostIdForWorktree(state, worktreeId)
  const entry = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
  const sleeping = paneKey ? state.sleepingAgentSessionsByPaneKey[paneKey] : undefined
  const saved = savedTabResume(state, worktreeId, tabId, hostId, paneKey)
  const scopedEntry =
    entry?.agentType === 'codex' &&
    (!entry.tabId || entry.tabId === tabId) &&
    (!entry.worktreeId || entry.worktreeId === worktreeId) &&
    !agentResumeOriginNamesAnotherExecutionHost(entry.connectionId, hostId)
      ? entry
      : undefined
  const scopedSleeping =
    sleeping?.agent === 'codex' &&
    sleeping.worktreeId === worktreeId &&
    !agentResumeOriginNamesAnotherExecutionHost(sleeping.connectionId, hostId)
      ? sleeping
      : undefined
  const providerSession = normalizeAgentProviderSession(
    scopedEntry
      ? scopedEntry.providerSession
      : scopedSleeping
        ? scopedSleeping.providerSession
        : saved?.agent === 'codex'
          ? { key: 'session_id', id: saved.sessionId }
          : undefined
  )
  // Use current configuration, not the launch settings that triggered this restart notice.
  const capabilities = getCachedWindowsTerminalCapabilities()
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId, undefined, {
    wslAvailable: capabilities?.wslAvailable,
    availableWslDistros: capabilities?.wslDistros ?? null
  })
  const target = resolveAgentResumeLaunchTarget({
    projectRuntime,
    connectionId: scopedEntry?.connectionId ?? scopedSleeping?.connectionId,
    executionHostId: hostId,
    worktreePath: cwd,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: tab.shellOverride
  })
  const launchArgs = {
    agent: 'codex' as const,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs('codex', state.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv('codex', state.settings?.agentDefaultEnv),
    platform: target.platform,
    shell: target.shell
  }
  const picker = buildAgentStartupPlan({ ...launchArgs, prompt: '', allowEmptyPromptLaunch: true })
  if (picker) {
    fallback = {
      ...CODEX_ACCOUNT_RESTART_STARTUP,
      command: buildAgentResumeLaunchCommand(
        'codex',
        picker.launchCommand,
        ['codex', 'resume'],
        resolveStartupShell(target.platform, target.shell)
      ),
      launchConfig: picker.launchConfig,
      env: picker.env
    }
  }
  // Exact replacements require a bound leaf and a host that enforces the current-home guard.
  if (!providerSession || !leafId || isRemoteRuntimePtyId(boundPtyId)) {
    return fallback
  }
  const plan = buildAgentResumeStartupPlan({
    ...launchArgs,
    providerSession,
    resumeInLaunchCwd: true
  })
  if (!plan) {
    return fallback
  }
  const snapshot =
    state.settings?.chatSidebar?.sessions?.[JSON.stringify([hostId, 'codex', providerSession.id])]
      ?.snapshot
  const matchingSaved =
    snapshot?.agent === 'codex' &&
    snapshot.executionHostId === hostId &&
    snapshot.sessionId === providerSession.id &&
    (!providerSession.transcriptPath ||
      normalizeRuntimePathForComparison(providerSession.transcriptPath) ===
        normalizeRuntimePathForComparison(snapshot.filePath))
      ? snapshot
      : undefined
  const paths = matchingSaved
    ? savedResumePaths(
        matchingSaved,
        cwd,
        target.platform,
        projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
          ? projectRuntime.runtime.distro
          : undefined
      )
    : null
  if (matchingSaved && !paths) {
    return fallback
  }
  return {
    ...CODEX_ACCOUNT_RESTART_STARTUP,
    command: plan.launchCommand,
    launchConfig: plan.launchConfig,
    resumeProviderSession: {
      ...providerSession,
      ...(matchingSaved ? { transcriptPath: matchingSaved.filePath } : {})
    },
    // Main verifies the rollout and owns account/home selection for the replacement.
    env: plan.env,
    showSessionRestoredBanner: true
  }
}
