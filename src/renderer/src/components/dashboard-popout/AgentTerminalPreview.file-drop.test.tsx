// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminalHarness } from './__mocks__/preview-terminal-input'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import { captureTerminalDropTarget } from '../terminal-pane/terminal-drop-target'
import { writeTerminalDropPathsToCapturedTarget } from '../terminal-pane/terminal-drop-path-writer'
import { WORKSPACE_FILE_PATH_MIME, writeWorkspaceFileDragSource } from '@/lib/workspace-file-drag'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const dropHarness = vi.hoisted(() => ({
  capture: vi.fn(),
  deliver: vi.fn(async (_paths: string[]) => undefined),
  internal: vi.fn(),
  internalNative: vi.fn(),
  prepare: vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] }))
}))
const dropHost = vi.hoisted((): { value: ExecutionHostId } => ({ value: 'local' }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => dropHost.value
}))
vi.mock('../terminal-pane/terminal-native-file-drop-destination', () => ({
  captureNativeTerminalFileDrop: dropHarness.capture
}))
vi.mock('../terminal-pane/terminal-drop-handler', () => ({
  handleTerminalFileDrop: dropHarness.internalNative,
  handleInternalTerminalFileDrop: dropHarness.internal
}))

const dataListeners = new Set<(data: TerminalPreviewDataPayload) => void>()
const input = vi.fn(async (_ptyId: string, _data: string) => true)
const workspace = {
  worktreeId: 'folder-a',
  tabId: 'tab-a',
  cwd: '/workspace',
  paneKey: 'leaf-a',
  executionHostId: 'local' as const
}

function osDrop(root: HTMLElement): void {
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files: [new File(['x'], 'a b.txt')] }
  })
  Object.defineProperty(event, 'isTrusted', { value: true })
  root.dispatchEvent(event)
}

function osDropRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('[data-os-file-drop-owner]')
  if (!root) {
    throw new Error('Missing OS file drop owner')
  }
  return root
}

beforeEach(() => {
  terminalHarness.instances.length = 0
  dropHost.value = 'local'
  dropHarness.capture.mockImplementation(() => dropHarness.deliver)
  Object.assign(window, {
    api: {
      fs: {
        getPathForFile: (file: File) => `/tmp/${file.name}`,
        prepareDroppedPaths: dropHarness.prepare
      },
      terminalPreview: {
        connect: vi.fn(async () => ({
          snapshot: { data: '', cols: 80, rows: 24, seq: 1 },
          replay: []
        })),
        input,
        fit: vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows })),
        ack: vi.fn(),
        unsubscribe: vi.fn(),
        onData: (listener: (data: TerminalPreviewDataPayload) => void) => {
          dataListeners.add(listener)
          return () => dataListeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  dataListeners.clear()
  vi.clearAllMocks()
})

it.each(['unmount', 'replace', 'host-change', 'reconnect'] as const)(
  'rejects a prepared OS drop after %s',
  async (change) => {
    let releasePreparation: ((result: { paths: string[]; failures: [] }) => void) | undefined
    dropHarness.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreparation = resolve
        })
    )
    const view = render(<AgentTerminalPreview ptyId="pty-a" workspace={workspace} />)
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    await act(async () => osDrop(osDropRoot(view.container)))
    expect(dropHarness.capture).toHaveBeenCalledTimes(1)
    if (change === 'unmount') {
      view.unmount()
    } else if (change === 'replace') {
      view.rerender(<AgentTerminalPreview ptyId="pty-b" workspace={workspace} />)
    } else if (change === 'host-change') {
      dropHost.value = 'ssh:other'
    } else {
      await act(async () => {
        for (const listener of dataListeners) {
          listener({ type: 'resync', ptyId: 'pty-a' })
        }
      })
    }
    await act(async () => releasePreparation?.({ paths: ['/tmp/a b.txt'], failures: [] }))
    expect(dropHarness.deliver).not.toHaveBeenCalled()
  }
)

it('captures one preview and its original PTY when two show the same tab', async () => {
  const first = render(<AgentTerminalPreview ptyId="pty-a" workspace={workspace} />)
  render(<AgentTerminalPreview ptyId="pty-a" workspace={workspace} />)
  await waitFor(() => expect(terminalHarness.instances).toHaveLength(2))
  await act(async () => osDrop(osDropRoot(first.container)))
  await waitFor(() => expect(dropHarness.deliver).toHaveBeenCalledWith(['/tmp/a b.txt']))
  expect(dropHarness.capture).toHaveBeenCalledTimes(1)
  const args = dropHarness.capture.mock.calls[0][0]
  expect(args).toMatchObject({ worktreeId: 'folder-a', tabId: 'tab-a', cwd: '/workspace' })
  const pane = args.manager.getActivePane()
  const transport = pane && args.paneTransports.get(pane.id)
  if (!pane || !transport) {
    throw new Error('Missing captured destination')
  }
  const result = await writeTerminalDropPathsToCapturedTarget({
    ...args,
    dropTarget: captureTerminalDropTarget(pane, transport),
    paths: ['/tmp/a b.txt', '/tmp/$HOME.txt'],
    targetShell: 'posix'
  })
  expect(result.pathsWritten).toBe(2)
  expect(input.mock.calls).toEqual([
    ['pty-a', "'/tmp/a b.txt' "],
    ['pty-a', "'/tmp/$HOME.txt' "]
  ])
})

it.each([
  ['local', 'local', 'internal'],
  ['local', 'ssh:destination', 'native'],
  ['ssh:destination', 'ssh:destination', 'internal'],
  ['ssh:other', 'ssh:destination', 'rejected']
] as const)(
  'routes an internal file from %s to %s through %s',
  async (source, destination, route) => {
    dropHost.value = destination
    const view = render(
      <AgentTerminalPreview
        ptyId="pty-a"
        workspace={{ ...workspace, executionHostId: destination }}
      />
    )
    await waitFor(() => expect(terminalHarness.instances).toHaveLength(1))
    const target = osDropRoot(view.container)
    const dataTransfer = new DataTransfer()
    dataTransfer.setData(WORKSPACE_FILE_PATH_MIME, '/source/a b.txt')
    writeWorkspaceFileDragSource(dataTransfer, {
      workspaceId: 'source-folder',
      executionHostId: source
    })
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    await act(async () => {
      target.dispatchEvent(event)
    })
    expect(dropHarness.internalNative).toHaveBeenCalledTimes(route === 'native' ? 1 : 0)
    expect(dropHarness.internal).toHaveBeenCalledTimes(route === 'internal' ? 1 : 0)
  }
)
