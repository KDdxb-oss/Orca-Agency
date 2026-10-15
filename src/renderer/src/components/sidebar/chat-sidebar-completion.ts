import type {
  ChatSidebarCompletion,
  ChatSidebarSettings
} from '../../../../shared/chat-sidebar-settings'
import { chatHasWorkingTurn, type ChatSidebarRow } from './chat-sidebar-types'

type CompletionRow = Pick<
  ChatSidebarRow,
  'tabId' | 'turnStartedAt' | 'activityFromState' | 'state' | 'promptBackedWorking'
>

export function isChatCompleted(
  row: CompletionRow & Pick<ChatSidebarRow, 'worktree'>,
  completion: ChatSidebarCompletion | undefined
): boolean {
  if (!completion) {
    return row.worktree.workspaceStatus === 'completed' && !chatHasWorkingTurn(row)
  }
  return completion.done !== false && row.turnStartedAt <= completion.at
}

export function chatCompletionActivityTime(
  row: CompletionRow & Pick<ChatSidebarRow, 'completed' | 'timestamp'>,
  completion: ChatSidebarCompletion | undefined
): number {
  // Why: resume writes can advance the transcript timestamp without a new prompt.
  return completion &&
    (row.completed || (completion.closedTabId && row.turnStartedAt <= completion.at))
    ? completion.activityAt
    : row.timestamp
}

/** Only a proven new turn clears Done; a replacement tab is still the same conversation. */
export function refreshedChatCompletion(
  row: CompletionRow,
  completion: ChatSidebarCompletion,
  _now: number
): ChatSidebarCompletion | null {
  if (row.turnStartedAt > completion.at && (completion.done !== false || completion.closedTabId)) {
    return { ...completion, closedTabId: undefined, done: false }
  }
  if (completion.done === false) {
    return null
  }
  if (row.activityFromState) {
    if (completion.working === true && row.state !== 'working') {
      return { ...completion, working: false }
    }
  }
  return null
}

export function chatCompletionEdit(
  row: Pick<ChatSidebarRow, 'id' | 'aliases' | 'timestamp' | 'state'>,
  current: ChatSidebarSettings,
  done: boolean,
  now: number
): Partial<ChatSidebarSettings> {
  const completed = { ...current.completed }
  for (const alias of row.aliases) {
    delete completed[alias]
  }
  completed[row.id] = {
    activityAt: row.timestamp,
    at: now,
    done,
    ...(row.state === 'working' ? { working: true } : {})
  }
  return { completed }
}
