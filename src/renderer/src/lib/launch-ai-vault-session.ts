import { useAppStore } from '@/store'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import {
  createWebRuntimeSessionTerminalWithIdentity,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { toWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import { webTerminalPlacementParentTabId } from '@/runtime/web-session-terminal-placement'
import { updateChatSidebar } from '@/components/sidebar/chat-sidebar-preferences'
import { chatFallbackId } from '@/components/sidebar/chat-sidebar-types'
import { toast } from 'sonner'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { TabSplitDirection } from '@/store/slices/tabs'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session'

export type LaunchAiVaultSessionInNewTabResult =
  | { tabId: string; groupId?: string }
  | { tabId: null; groupId?: string; runtimeLaunch: Promise<WebRuntimeTerminalCreateOutcome> }

function rememberUserResumedTab(hostId: string, tabId: string): void {
  const key = chatFallbackId(hostId, tabId)
  void updateChatSidebar((current) =>
    current.userResumedTabs?.includes(key)
      ? null
      : { userResumedTabs: [...(current.userResumedTabs ?? []), key] }
  ).catch(() => toast.error('Could not save the resumed chat in Chats.'))
}

export function launchAiVaultSessionInNewTab(args: {
  agent: AiVaultAgent
  worktreeId: string
  command: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  providerSession?: AgentProviderSessionMetadata
  targetGroupId?: string
  splitDirection?: TabSplitDirection
}): LaunchAiVaultSessionInNewTabResult {
  const store = useAppStore.getState()
  const executionHostId = getExecutionHostIdForWorktree(store, args.worktreeId)
  let targetGroupId = args.targetGroupId
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, args.worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    const runtimeLaunch = createWebRuntimeSessionTerminalWithIdentity({
      worktreeId: args.worktreeId,
      environmentId: runtimeEnvironmentId,
      ...(targetGroupId ? { targetGroupId } : {}),
      agentSessionKind: 'resume',
      launchAgent: args.agent,
      command: args.command,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.env ? { env: args.env } : {}),
      ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
      ...(args.providerSession ? { providerSession: args.providerSession } : {}),
      ...(args.launchConfig ? { agentArgs: args.launchConfig.agentArgs } : {}),
      activate: true
    })
    const observedRuntimeLaunch = runtimeLaunch.then(({ outcome, hostTabId }) => {
      if (outcome.status === 'created') {
        useAppStore.getState().setActiveTabType('terminal', args.worktreeId)
        if (hostTabId) {
          rememberUserResumedTab(
            executionHostId,
            toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(hostTabId))
          )
        }
      }
      return outcome
    })
    return {
      tabId: null,
      ...(targetGroupId ? { groupId: targetGroupId } : {}),
      runtimeLaunch: observedRuntimeLaunch
    }
  }

  if (args.splitDirection && targetGroupId) {
    targetGroupId =
      store.createEmptySplitGroup(args.worktreeId, targetGroupId, args.splitDirection) ??
      targetGroupId
  }

  const tab = args.cwd
    ? store.createTab(args.worktreeId, targetGroupId, undefined, { startupCwd: args.cwd })
    : store.createTab(args.worktreeId, targetGroupId)
  store.queueTabStartupCommand(tab.id, {
    command: args.command,
    ...(args.env ? { env: args.env } : {}),
    ...(args.envToDelete ? { envToDelete: args.envToDelete } : {}),
    ...(args.launchConfig ? { launchConfig: args.launchConfig, launchAgent: args.agent } : {}),
    ...(args.providerSession ? { resumeProviderSession: args.providerSession } : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(args.agent),
      launch_source: 'sidebar',
      request_kind: 'resume'
    }
  })
  store.setActiveTabType('terminal', args.worktreeId)
  rememberUserResumedTab(executionHostId, tab.id)

  persistAgentLaunchTabOrder(args.worktreeId, tab.id)

  return { tabId: tab.id, groupId: targetGroupId }
}
