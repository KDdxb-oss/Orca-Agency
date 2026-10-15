import { useRef, useState, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import { createOsFileDropSequence, useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  TerminalDropSurface,
  TerminalDropTransport
} from '../terminal-pane/terminal-drop-surface'
import { captureNativeTerminalFileDrop } from '../terminal-pane/terminal-native-file-drop-destination'
import type { PreviewTerminalWorkspace } from './agent-terminal-preview-props'

export function usePreviewTerminalOsFileDropOwner(args: {
  ptyId: string
  workspace: PreviewTerminalWorkspace | undefined
  terminalRef: RefObject<Terminal | null>
  connectionEpochRef: RefObject<number>
}): (root: HTMLElement | null) => void {
  const rootRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const isCurrent = (): boolean =>
    Boolean(
      args.workspace &&
      rootRef.current?.isConnected &&
      args.terminalRef.current &&
      getExecutionHostIdForWorktree(useAppStore.getState(), args.workspace.worktreeId) ===
        args.workspace.executionHostId
    )

  return useOsFileDropOwner(rootRef, {
    consumer: 'agent',
    sequence,
    canAccept: () => isCurrent(),
    captureDestination: () => {
      const root = rootRef.current
      const terminal = args.terminalRef.current
      const workspace = args.workspace
      const connectionEpoch = args.connectionEpochRef.current
      if (!root || !terminal || !workspace) {
        return undefined
      }
      const leafId = workspace.paneKey ? parsePaneKey(workspace.paneKey)?.leafId : undefined
      const pane = { id: 0, leafId: leafId ?? args.ptyId, container: root, terminal }
      const manager: TerminalDropSurface = {
        getPanes: () => (isCurrent() ? [pane] : []),
        getActivePane: () => (isCurrent() ? pane : null)
      }
      const host = parseExecutionHostId(workspace.executionHostId)
      const transport: TerminalDropTransport = {
        getPtyId: () => args.ptyId,
        isConnected: isCurrent,
        sendInput: () => false,
        sendInputAccepted: (data) => window.api.terminalPreview.input(args.ptyId, data),
        getExecutionHostId: () => workspace.executionHostId,
        getRuntimeEnvironmentId: () => (host?.kind === 'runtime' ? host.environmentId : null)
      }
      const deliver = captureNativeTerminalFileDrop({
        manager,
        paneTransports: new Map([[pane.id, transport]]),
        worktreeId: workspace.worktreeId,
        tabId: workspace.tabId,
        cwd: workspace.cwd,
        pane
      })
      return async (paths: string[]): Promise<void> => {
        if (
          isCurrent() &&
          args.terminalRef.current === terminal &&
          args.connectionEpochRef.current === connectionEpoch
        ) {
          await deliver(paths)
        }
      }
    },
    onDrop: async (prepared, { destination }) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      await destination?.(prepared.paths)
    }
  })
}
