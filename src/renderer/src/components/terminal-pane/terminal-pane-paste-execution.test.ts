import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'

const mocks = vi.hoisted(() => {
  const state: {
    agentStatusByPaneKey: Record<string, AgentStatusEntry>
    paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  } = { agentStatusByPaneKey: {}, paneForegroundAgentByPaneKey: {} }
  return { state, recordInput: vi.fn() }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('./terminal-paste-target-state', () => ({
  isTerminalPanePasteTargetCurrent: () => true,
  isTerminalPanePasteFocusCurrent: () => true
}))
vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordInput
}))

const tabId = 'tab-1'
const leafId = '11111111-1111-4111-8111-111111111111'

function setup(agentType: AgentStatusEntry['agentType'] | null, shellOverride = 'powershell.exe') {
  mocks.state.agentStatusByPaneKey = agentType
    ? {
        [`${tabId}:${leafId}`]: {
          state: 'waiting',
          prompt: '',
          updatedAt: 0,
          stateStartedAt: 0,
          stateHistory: [],
          agentType,
          paneKey: `${tabId}:${leafId}`
        }
      }
    : {}
  mocks.state.paneForegroundAgentByPaneKey = agentType
    ? {
        [`${tabId}:${leafId}`]: {
          agent: agentType === 'codex' ? 'codex' : null,
          agentEvidence: 'process-read',
          routingTrusted: true,
          shellForeground: false
        }
      }
    : {}
  const terminal = {
    modes: { bracketedPasteMode: false },
    options: { ignoreBracketedPasteMode: false },
    input: vi.fn(),
    paste: vi.fn()
  }
  const pane = { id: 1, leafId, terminal, container: {} }
  const transport = {
    getPtyId: () => 'pty-1',
    getLocalSessionMetadata: () => ({ cwd: 'C:/Users/brook/dev/claude/General', shellOverride }),
    getConnectionId: () => null,
    isConnected: () => true,
    sendInput: vi.fn(() => true)
  }
  const controller = {
    forceBracketedMultilineTextPaste: true,
    managerRef: { current: { getActivePane: () => pane, getPanes: () => [pane] } },
    paneTransportsRef: { current: new Map([[pane.id, transport]]) },
    setTerminalError: vi.fn(),
    tabId,
    worktreeId: 'folder:general'
  }
  return { terminal, controller }
}

async function flushPaste(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function pasteFromTestPane(controller: ReturnType<typeof setup>['controller']): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies only the controller fields read by the paste execution.
  const execution = createTerminalPanePasteExecution(controller as never, 'win32')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture pane supplies every field read by this paste path.
  execution.pasteFromClipboard(controller.managerRef.current.getActivePane() as never, 'keyboard')
}

afterEach(() => {
  vi.unstubAllGlobals()
  mocks.recordInput.mockClear()
})

describe('keyboard clipboard paste into a Windows terminal', () => {
  it('uses modified Enter for a multiline Codex draft without submitting it', async () => {
    const { terminal, controller } = setup('codex')
    vi.stubGlobal('window', {
      api: {
        ui: { readClipboardText: async () => 'one\ntwo', saveClipboardImageAsTempFile: vi.fn() }
      }
    })
    vi.stubGlobal('document', { activeElement: null })

    pasteFromTestPane(controller)
    await flushPaste()

    expect(terminal.input).toHaveBeenCalledWith('one\x1b\rtwo')
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(controller.setTerminalError).not.toHaveBeenCalled()
  })

  it('keeps the Windows shell multiline protection when no agent is present', async () => {
    const { terminal, controller } = setup(null)
    vi.stubGlobal('window', {
      api: {
        ui: { readClipboardText: async () => 'one\ntwo', saveClipboardImageAsTempFile: vi.fn() }
      }
    })
    vi.stubGlobal('document', { activeElement: null })

    pasteFromTestPane(controller)
    await flushPaste()

    expect(terminal.input).toHaveBeenCalledWith('\x1b[200~one\rtwo\x1b[201~')
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('keeps a Codex draft bracketed when its Windows client runs a WSL shell', async () => {
    const { terminal, controller } = setup('codex', 'wsl.exe')
    vi.stubGlobal('window', {
      api: {
        ui: { readClipboardText: async () => 'one\ntwo', saveClipboardImageAsTempFile: vi.fn() }
      }
    })
    vi.stubGlobal('document', { activeElement: null })

    pasteFromTestPane(controller)
    await flushPaste()

    expect(terminal.input).toHaveBeenCalledWith('\x1b[200~one\rtwo\x1b[201~')
    expect(terminal.paste).not.toHaveBeenCalled()
  })
})
