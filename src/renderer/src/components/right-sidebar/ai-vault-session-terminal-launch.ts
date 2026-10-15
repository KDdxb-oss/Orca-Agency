import { toast } from 'sonner'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isAiVaultTitleAgent } from '../../../../shared/ai-vault-session-title'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { activateAiVaultResumeWorkspace } from './ai-vault-session-resume-in-chat-launch'
import {
  aiVaultResumeUnsupportedMessage,
  resolveAiVaultSessionLaunchTarget
} from './ai-vault-session-launch-target'

export type AiVaultResumePlacement = {
  targetGroupId?: string
  splitDirection?: TabSplitDirection
  onResumed?: () => void
  validateDestination?: () => boolean
  onSettled?: (outcome: 'created' | 'not-created' | 'unverifiable') => void
}

const pendingResumes = new Set<string>()
const RESUME_SETTLE_MS = 10_000

export function launchAiVaultSessionInTerminal(args: {
  session: AiVaultSession
  targetWorktreeId?: string
  activeWorktreeId: string | null
  prepareStartup: (worktreeId: string) => Promise<AiVaultResumeStartup>
  describeFailure?: (message: string) => string
  resume?: { key: string; placement?: AiVaultResumePlacement }
}): void {
  const {
    session,
    targetWorktreeId,
    activeWorktreeId,
    prepareStartup,
    describeFailure = (message) => message,
    resume
  } = args
  const targetId = resolveAiVaultSessionLaunchTargetOrNotify({
    sessionFilePath: session.filePath,
    sessionExecutionHostId: session.executionHostId,
    activeWorktreeId,
    targetWorktreeId,
    // Chats can create the destination after its resume callback was rendered.
    targetState: useAppStore.getState()
  })
  if (!targetId) {
    resume?.placement?.onSettled?.('not-created')
    return
  }
  if (resume && pendingResumes.has(resume.key)) {
    resume.placement?.onSettled?.('not-created')
    return
  }
  if (resume) {
    pendingResumes.add(resume.key)
  }
  let outcome: 'created' | 'not-created' | 'unverifiable' = 'not-created'
  let settleMs = 0
  const showQueuedToast = (): void => {
    toast.success(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.agentSessionQueued',
        '{{value0}} session queued',
        { value0: agentLabel(session.agent) }
      )
    )
  }
  void prepareStartup(targetId.worktreeId)
    .then(async (startup) => {
      if (resume?.placement?.validateDestination?.() === false) {
        throw new Error('The destination pane was closed. Drop the chat onto an open pane.')
      }
      if (
        resume?.placement?.targetGroupId &&
        !useAppStore
          .getState()
          .groupsByWorktree[targetId.worktreeId]?.some(
            (group) => group.id === resume.placement?.targetGroupId
          )
      ) {
        throw new Error('The destination pane was closed. Drop the chat onto an open pane.')
      }
      const launchResult = launchAiVaultSessionInNewTab({
        agent: session.agent,
        worktreeId: targetId.worktreeId,
        ...startup,
        targetGroupId: resume?.placement?.targetGroupId,
        splitDirection: resume?.placement?.splitDirection
      })
      if (launchResult.tabId === null) {
        outcome = 'unverifiable'
        const runtimeOutcome = await launchResult.runtimeLaunch
        if (runtimeOutcome.status === 'failed') {
          toast.error(
            describeFailure(runtimeOutcome.message) ||
              translate(
                'auto.lib.launch.agent.in.new.tab.11cce5cc77',
                'Could not launch {{value0}} in a new terminal.',
                { value0: agentLabel(session.agent) }
              )
          )
          return
        }
      } else if (resume) {
        linkResumedTab(launchResult.tabId, session)
      }
      outcome = 'created'
      settleMs = RESUME_SETTLE_MS
      if (useAppStore.getState().activeWorktreeId !== targetId.worktreeId) {
        activateAiVaultResumeWorkspace(targetId.worktreeId)
      }
      resume?.placement?.onResumed?.()
      showQueuedToast()
    })
    .catch((error: unknown) => notifyAiVaultSessionPreparationFailure(error, describeFailure))
    .finally(() => {
      if (resume) {
        setTimeout(() => pendingResumes.delete(resume.key), settleMs)
      }
      resume?.placement?.onSettled?.(outcome)
    })
}

function linkResumedTab(tabId: string, session: AiVaultSession): void {
  const title = session.title.trim()
  if (isAiVaultTitleAgent(session.agent) && title) {
    useAppStore
      .getState()
      .setAiVaultTabTitle(tabId, { agent: session.agent, sessionId: session.sessionId, title })
  }
}

export function notifyAiVaultSessionPreparationFailure(
  error: unknown,
  describeFailure: (message: string) => string = (message) => message
): void {
  toast.error(
    error instanceof Error
      ? describeFailure(error.message)
      : translate(
          'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
          'Could not prepare this session for resume.'
        )
  )
}

export function resolveAiVaultSessionLaunchTargetOrNotify(
  args: Parameters<typeof resolveAiVaultSessionLaunchTarget>[0]
): Extract<ReturnType<typeof resolveAiVaultSessionLaunchTarget>, { status: 'ready' }> | null {
  const target = resolveAiVaultSessionLaunchTarget(args)
  if (target.status === 'missing') {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
        'Open a workspace before resuming a session.'
      )
    )
    return null
  }
  if (target.status === 'unsupported') {
    toast.error(aiVaultResumeUnsupportedMessage(target.targetStatus))
    return null
  }
  return target
}
