import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { getRuntimeGitCommitCompare } from '@/runtime/runtime-git-diff-client'
import { readStructuredAgentSessionTurnCheckpointDiff } from '@/runtime/structured-agent-session-client'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { isStructuredTab } from '@/components/native-chat/structured-agent-session-tabs'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import type { AgentTurnCheckpointDiff } from '../../../../shared/agent-turn-checkpoint-types'

type DiffLoad =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'loaded'; diff: AgentTurnCheckpointDiff }
  | { kind: 'failed' }

const stopRowActivation = (event: React.SyntheticEvent): void => event.stopPropagation()

/** The finished agent's final answer: the turn's own, kept past the next prompt when the row has it. */
export function agentRowResultAnswer(agent: DashboardAgentRowData): string {
  return (
    agent.entry.lastCompletedAssistantMessage?.trim() ||
    agent.entry.lastAssistantMessage?.trim() ||
    ''
  )
}

/** Opens the turn's checkpoint as a commit diff: one file, or every file when `path` is absent. */
async function openAgentTurnDiff(
  worktreeId: string,
  diff: AgentTurnCheckpointDiff,
  path?: string
): Promise<void> {
  const state = useAppStore.getState()
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  if (!worktree) {
    return
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  const result = await getRuntimeGitCommitCompare(
    {
      settings: getRepoOwnerRoutedSettings(state.settings, repo),
      worktreeId,
      worktreePath: worktree.path,
      connectionId: getConnectionId(worktreeId) ?? undefined
    },
    diff.commit
  )
  if (result.summary.status !== 'ready') {
    throw new Error(result.summary.errorMessage ?? 'The turn checkpoint could not be read.')
  }
  const subject = translate('components.sidebar.agentResult.diffSubject', 'Agent turn')
  const entry = path === undefined ? undefined : result.entries.find((item) => item.path === path)
  if (!entry) {
    state.openCommitAllDiffs(worktreeId, worktree.path, result.summary, result.entries, subject)
    return
  }
  state.openCommitDiff(
    worktreeId,
    worktree.path,
    entry,
    { ...result.summary, subject },
    detectLanguage(entry.path)
  )
}

function openDiffOrToast(worktreeId: string, diff: AgentTurnCheckpointDiff, path?: string): void {
  openAgentTurnDiff(worktreeId, diff, path).catch((error: unknown) =>
    toast.error(
      error instanceof Error
        ? error.message
        : translate('components.sidebar.agentResult.diffFailed', 'Could not open the diff')
    )
  )
}

/** A structured chat's latest turn checkpoint, read once the panel opens. */
function useAgentTurnDiff(agent: DashboardAgentRowData): DiffLoad {
  // A structured chat's row carries its chat tab's id; the session is that tab's entity.
  const tab = useAppStore((state) =>
    state.unifiedTabsByWorktree[agent.tab.worktreeId]?.find(
      (candidate) => candidate.id === agent.tab.id && isStructuredTab(candidate)
    )
  )
  const sessionId = tab?.entityId ?? null
  const owner = useAppStore((state) => (tab ? structuredAgentSessionOwnerForTab(state, tab) : null))
  const [load, setLoad] = useState<DiffLoad>({ kind: sessionId ? 'loading' : 'none' })
  useEffect(() => {
    const target = structuredAgentSessionTargetForHost(owner)
    if (!sessionId || !target) {
      setLoad({ kind: 'none' })
      return
    }
    let current = true
    setLoad({ kind: 'loading' })
    readStructuredAgentSessionTurnCheckpointDiff(target, sessionId)
      .then((diff) => current && setLoad(diff ? { kind: 'loaded', diff } : { kind: 'none' }))
      .catch(() => current && setLoad({ kind: 'failed' }))
    return () => {
      current = false
    }
  }, [owner, sessionId])
  return load
}

function AgentRowResultFiles({
  worktreeId,
  diff
}: {
  worktreeId: string
  diff: AgentTurnCheckpointDiff
}): React.JSX.Element {
  if (diff.fileCount === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('components.sidebar.agentResult.noChanges', 'No files changed in this turn.')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {diff.fileCount === 1
            ? translate('components.sidebar.agentResult.oneFile', '1 changed file')
            : translate('components.sidebar.agentResult.manyFiles', '{{count}} changed files', {
                count: diff.fileCount
              })}
        </span>
        <DiffLineCounts added={diff.added} removed={diff.removed} />
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() => openDiffOrToast(worktreeId, diff)}
        >
          {diff.truncated
            ? translate('components.sidebar.agentResult.openFullDiff', 'Open full diff')
            : translate('components.sidebar.agentResult.openDiff', 'Open diff')}
        </Button>
      </div>
      {diff.truncated ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.sidebar.agentResult.truncated',
            'Large turn: showing the first {{shown}} of {{count}} files.',
            { shown: diff.files.length, count: diff.fileCount }
          )}
        </p>
      ) : null}
      <ul
        className="scrollbar-sleek flex max-h-48 flex-col overflow-y-auto"
        aria-label={translate('components.sidebar.agentResult.filesLabel', 'Changed files')}
      >
        {diff.files.map((file) => (
          <li key={file.path}>
            <Button
              variant="ghost"
              size="xs"
              className="w-full justify-start"
              title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              onClick={() => openDiffOrToast(worktreeId, diff, file.path)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-mono">{file.path}</span>
                <DiffLineCounts added={file.added ?? 0} removed={file.removed ?? 0} />
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AgentRowResultPanel({
  agent
}: {
  agent: DashboardAgentRowData
}): React.JSX.Element {
  const answer = agentRowResultAnswer(agent)
  const load = useAgentTurnDiff(agent)
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium">
          {translate('components.sidebar.agentResult.answer', 'Final answer')}
        </h3>
        <p className="scrollbar-sleek max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {answer ||
            translate(
              'components.sidebar.agentResult.noAnswer',
              'The agent left no final message.'
            )}
        </p>
      </section>
      {load.kind === 'none' ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium">
            {translate('components.sidebar.agentResult.changes', 'Changes')}
          </h3>
          {load.kind === 'loading' ? (
            <p className="text-xs text-muted-foreground">
              {translate('components.sidebar.agentResult.loading', 'Loading changes…')}
            </p>
          ) : load.kind === 'failed' ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'components.sidebar.agentResult.loadFailed',
                "Couldn't load this turn's changes."
              )}
            </p>
          ) : (
            <AgentRowResultFiles worktreeId={agent.tab.worktreeId} diff={load.diff} />
          )}
        </section>
      )}
    </div>
  )
}

/** A finished agent's Result: its final answer, and for a structured chat the files and diff of its
 *  last turn. Subagent rows have no turn of their own, so they get none. */
export function AgentRowResult({
  agent
}: {
  agent: DashboardAgentRowData
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (agent.state !== 'done' || agent.rowSource === 'subagent' || agent.childRow) {
    return null
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={translate(
            'components.sidebar.agentResult.trigger',
            "Show this agent's result"
          )}
          onClick={stopRowActivation}
          onPointerDown={stopRowActivation}
        >
          {translate('components.sidebar.agentResult.triggerShort', 'Result')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96"
        onClick={stopRowActivation}
        onPointerDown={stopRowActivation}
      >
        {open ? <AgentRowResultPanel agent={agent} /> : null}
      </PopoverContent>
    </Popover>
  )
}
