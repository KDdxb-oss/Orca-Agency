import { memo } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { AgentStateDot } from '@/components/AgentStateDot'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { cn } from '@/lib/utils'
import { writeWorkspaceDragData } from './workspace-status'
import type { ChatSidebarRow as Row } from './chat-sidebar-types'
import { setChatCompleted } from './chat-sidebar-preferences'
import { selectChatTabInWorkspace } from './chat-sidebar-selection'
import type { ChatFolderDestination } from './chat-folder-destinations'
import { clearAiVaultSessionDragData } from '@/lib/ai-vault-session-drag'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { detachTerminalChat } from './chat-sidebar-detach'

export const ChatSidebarRow = memo(function ChatSidebarRow({
  row,
  subTab = false,
  showFolder = true,
  groupId,
  splitId,
  splitStart,
  splitEnd,
  selected,
  tabStop,
  now,
  onOpen,
  onRename,
  onSavedDragStart,
  folders,
  onChangeFolder,
  onNewFolder
}: {
  row: Row
  subTab?: boolean
  showFolder?: boolean
  groupId?: string
  splitId?: string
  splitStart?: boolean
  splitEnd?: boolean
  selected: boolean
  tabStop: boolean
  now: number
  onOpen: (row: Row) => void
  onRename: (row: Row) => void
  onSavedDragStart: (event: React.DragEvent, row: Row) => void
  folders: ChatFolderDestination[]
  onChangeFolder: (row: Row, folder: ChatFolderDestination) => void
  onNewFolder: (row: Row) => void
}) {
  const agent = row.agentType ?? row.session?.agent ?? row.liveSession?.agent
  const agentLabel = agent ? formatAgentTypeLabel(agent) : 'Unknown agent'
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={selected}
          aria-label={`${row.title}, ${agentLabel}, ${row.folder}${splitId ? ', shares a split window' : ''}`}
          tabIndex={tabStop ? 0 : -1}
          data-current={selected ? 'true' : undefined}
          data-chat-sidebar-id={row.id}
          data-worktree-id={row.worktree.id}
          data-chat-completed={row.completed}
          data-chat-state={row.displayState ?? row.state}
          data-chat-workspace-group={groupId}
          data-chat-split-group={splitId}
          data-chat-sub-tab={subTab ? 'true' : undefined}
          className={cn(
            'relative flex min-w-0 items-start gap-1 rounded-md px-1 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            showFolder ? 'h-9' : 'h-5',
            subTab && 'pl-7',
            selected && 'bg-sidebar-accent'
          )}
          onClick={() => onOpen(row)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) {
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen(row)
            }
            if (event.key === 'Delete') {
              event.preventDefault()
              void setChatCompleted(row, true)
            }
          }}
          draggable={Boolean(row.tabId || row.session)}
          onDragStart={(event) => {
            if (!row.tabId) {
              onSavedDragStart(event, row)
              return
            }
            selectChatTabInWorkspace(row)
            writeWorkspaceDragData(event.dataTransfer, row.worktree.id)
          }}
          onDragEnd={clearAiVaultSessionDragData}
        >
          {splitId ? (
            <span
              aria-hidden="true"
              data-chat-split-bracket=""
              className={cn(
                'pointer-events-none absolute bottom-0 left-0 top-0 w-1 border-l border-muted-foreground/40',
                splitStart && 'top-2.5 border-t',
                splitEnd && 'bottom-auto h-2.5 border-b'
              )}
            />
          ) : null}
          {subTab ? (
            <span
              aria-hidden="true"
              data-chat-sub-tab-elbow=""
              className="pointer-events-none absolute left-5 top-0.5 size-2 border-b border-l border-muted-foreground/40"
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-5"
            // Why: keyboard users toggle via Delete and the context menu; one tab stop per row.
            tabIndex={-1}
            aria-label={row.completed ? `Reopen ${row.title}` : `Mark ${row.title} done`}
            onClick={(event) => {
              event.stopPropagation()
              void setChatCompleted(row, !row.completed)
            }}
          >
            {row.completed ? (
              <Check className="size-3.5" />
            ) : (
              <AgentStateDot state={row.displayState ?? row.state} />
            )}
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex h-5 min-w-0 items-center gap-1 leading-4">
              <span
                className="flex shrink-0 items-center"
                data-chat-agent={agent ?? 'unknown'}
                title={agentLabel}
                aria-hidden="true"
              >
                <AgentIcon agent={agentTypeToIconAgent(agent)} size={12} />
              </span>
              <span
                className={cn('min-w-0 flex-1 truncate', subTab ? 'text-[11px]' : 'text-xs')}
                data-chat-title=""
                title={row.title}
              >
                {row.title}
              </span>
              <span
                className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                title={row.timestamp ? new Date(row.timestamp).toLocaleString() : undefined}
              >
                {(row.displayState ?? row.state) === 'working'
                  ? 'Now'
                  : row.timestamp
                    ? formatShortTimeAgo(row.timestamp, now)
                    : ''}
              </span>
            </div>
            {showFolder ? (
              <div className="absolute left-12 right-1 top-[18px] flex min-w-0 items-center gap-2 text-[11px] leading-3 text-muted-foreground">
                <span
                  data-chat-folder=""
                  className="min-w-0 flex-1 truncate"
                  title={(row.folderWorktree ?? row.worktree).path}
                >
                  {row.folder}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(row)}>Open chat</ContextMenuItem>
        <ContextMenuItem onSelect={() => onRename(row)}>Rename chat</ContextMenuItem>
        {row.tabId ? (
          <ContextMenuItem onSelect={() => detachTerminalChat(row.tabId!)}>
            Move to separate chat
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={() => void setChatCompleted(row, !row.completed)}>
          {row.completed ? 'Move to In progress' : 'Mark done'}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Change folder</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => onNewFolder(row)}>New folder...</ContextMenuItem>
            <ContextMenuSeparator />
            {folders
              .filter((folder) => folder.hostId === row.hostId)
              .map((folder) => (
                <ContextMenuItem key={folder.id} onSelect={() => onChangeFolder(row, folder)}>
                  {folder.label}
                </ContextMenuItem>
              ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
})
