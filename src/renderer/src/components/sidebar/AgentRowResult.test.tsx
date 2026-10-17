/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentTurnCheckpointDiff } from '../../../../shared/agent-turn-checkpoint-types'
import { AgentRowResult, AgentRowResultPanel } from './AgentRowResult'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const store = vi.hoisted(() => {
  const unifiedTabsByWorktree: Record<string, unknown[]> = {}
  return { state: { unifiedTabsByWorktree } }
})
const readDiff = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: unknown) => unknown) => select(store.state), {
    getState: () => store.state
  })
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionOwnerForTab: () => 'owner',
  structuredAgentSessionTargetForHost: (owner: string | null) => (owner ? { kind: 'local' } : null)
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  readStructuredAgentSessionTurnCheckpointDiff: readDiff
}))
vi.mock('@/components/native-chat/structured-agent-session-tabs', () => ({
  isStructuredTab: (tab: { contentType?: string }) => tab.contentType === 'structured'
}))

function makeAgent(
  overrides: Partial<DashboardAgentRowData> = {},
  entry: Partial<AgentStatusEntry> = {}
): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    agentType: 'claude',
    state: 'done',
    startedAt: 500,
    entry: {
      state: 'done',
      prompt: 'do it',
      updatedAt: 1000,
      stateStartedAt: 1000,
      paneKey: 'tab-1:leaf-1',
      stateHistory: [],
      lastAssistantMessage: 'All done.',
      ...entry
    },
    ...overrides
  }
}

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  store.state.unifiedTabsByWorktree = {}
  readDiff.mockReset()
})

async function render(element: React.JSX.Element): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(element))
  return container
}

describe('AgentRowResult', () => {
  it('shows a Result trigger only on a finished top-level row', async () => {
    const done = await render(<AgentRowResult agent={makeAgent()} />)
    expect(done.querySelector('[aria-label="Show this agent\'s result"]')?.textContent).toBe(
      'Result'
    )
    act(() => root?.unmount())
    for (const agent of [makeAgent({ state: 'working' }), makeAgent({ rowSource: 'subagent' })]) {
      const hidden = await render(<AgentRowResult agent={agent} />)
      expect(hidden.textContent).toBe('')
      act(() => root?.unmount())
    }
  })

  it('shows only the answer for a terminal agent with no structured chat', async () => {
    const panel = await render(<AgentRowResultPanel agent={makeAgent()} />)
    expect(panel.textContent).toContain('All done.')
    expect(panel.textContent).not.toContain('Changes')
    expect(readDiff).not.toHaveBeenCalled()
  })

  it("lists a structured chat's turn files and offers the full diff when truncated", async () => {
    store.state.unifiedTabsByWorktree = {
      'wt-1': [{ id: 'tab-1', contentType: 'structured', entityId: 'session-1' }]
    }
    const diff: AgentTurnCheckpointDiff = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      ref: 'refs/orca/checkpoints/session-1/turn-1',
      commit: 'abc123',
      fileCount: 3,
      added: 4,
      removed: 1,
      truncated: true,
      rollbackable: true,
      files: [
        { path: 'a.ts', added: 3, removed: 1 },
        { path: 'b.ts', added: 1, removed: 0 }
      ]
    }
    readDiff.mockResolvedValue(diff)
    const panel = await render(
      <AgentRowResultPanel agent={makeAgent({}, { lastCompletedAssistantMessage: 'Fixed.' })} />
    )
    expect(readDiff).toHaveBeenCalledWith({ kind: 'local' }, 'session-1')
    expect(panel.textContent).toContain('Fixed.')
    expect(panel.textContent).toContain('3 changed files')
    expect(panel.textContent).toContain('Open full diff')
    expect(panel.textContent).not.toContain('starting point')
    expect([...panel.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      expect.stringContaining('a.ts'),
      expect.stringContaining('b.ts')
    ])
  })

  it('waits for a capture still being written, then flags a turn measured from HEAD', async () => {
    store.state.unifiedTabsByWorktree = {
      'wt-1': [{ id: 'tab-1', contentType: 'structured', entityId: 'session-1' }]
    }
    let answer: (diff: AgentTurnCheckpointDiff) => void = () => {}
    readDiff.mockReturnValue(
      new Promise<AgentTurnCheckpointDiff>((resolve) => {
        answer = resolve
      })
    )
    const panel = await render(<AgentRowResultPanel agent={makeAgent()} />)
    expect(panel.textContent).toContain('Loading changes…')

    await act(async () =>
      answer({
        sessionId: 'session-1',
        turnId: 'turn-2',
        ref: 'refs/orca/checkpoints/session-1/turn-2',
        commit: 'def456',
        fileCount: 1,
        added: 1,
        removed: 0,
        truncated: false,
        rollbackable: false,
        files: [{ path: 'c.ts', added: 1, removed: 0 }]
      })
    )
    expect(panel.textContent).not.toContain('Loading changes…')
    expect(panel.textContent).toContain('1 changed file')
    expect(panel.textContent).toContain("This turn's starting point wasn't saved")
  })
})
