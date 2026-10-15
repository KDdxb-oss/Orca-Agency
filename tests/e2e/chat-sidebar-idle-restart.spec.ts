import { readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import { TEST_REPO_PATH_FILE } from './global-setup'

test('idle chat nesting and provider icons survive a real quit before title resolution', async (// oxlint-disable-next-line no-empty-pattern -- owns both launches against the same isolated profile.
{}, testInfo) => {
  test.setTimeout(240_000)
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const worktreeId = await attachRepoAndOpenTerminal(
      first.page,
      readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    )
    const identities = await first.page.evaluate(async (worktreeId) => {
      const s = window.__store!.getState()
      await s.updateSettings({ chatSidebar: { view: 'chats', groupBy: 'status' } })
      const path = s.getKnownWorktreeById(worktreeId)!.path
      const ids: { tabId: string; key: string; agent: 'claude' | 'codex' }[] = []
      for (const agent of ['codex', 'claude'] as const) {
        const tab = s.createTab(worktreeId)
        const paneKey = `${tab.id}:77777777-7777-4777-8777-777777777777`
        const transcriptPath =
          agent === 'claude'
            ? `/home/.claude/projects/${path.replace(/[^a-zA-Z0-9]/g, '-')}/${tab.id}.jsonl`
            : `/home/.codex/sessions/2026/09/20/rollout-${tab.id}.jsonl`
        window.__store!.setState((state) => ({
          agentStatusByPaneKey: {
            ...state.agentStatusByPaneKey,
            [paneKey]: {
              paneKey,
              tabId: tab.id,
              worktreeId,
              agentType: agent,
              state: 'done',
              prompt: `${agent} saved conversation`,
              stateStartedAt: 1790000000000,
              updatedAt: 1790000000000,
              stateHistory: [],
              providerSession: { key: 'session_id', id: tab.id, transcriptPath }
            }
          }
        }))
        ids.push({ tabId: tab.id, key: JSON.stringify(['local', agent, tab.id]), agent })
      }
      return ids
    }, worktreeId)
    const rows = first.page.locator('[data-chat-sidebar-id]')
    await expect(rows).toHaveCount(2)
    await expect(first.page.locator('[data-chat-sub-tab-elbow]')).toHaveCount(1)
    for (const id of identities) {
      await expect(
        rows.filter({ has: first.page.locator(`[data-chat-agent="${id.agent}"]`) })
      ).toHaveCount(1)
    }
    await expect
      .poll(() =>
        first.page.evaluate(
          (ids) =>
            ids.every((id) => {
              const s = window.__store!.getState()
              return (
                Object.values(s.tabsByWorktree)
                  .flat()
                  .find((t) => t.id === id.tabId)?.aiVaultTitle?.sessionId === id.tabId &&
                !!s.settings?.chatSidebar?.sessions?.[id.key]?.snapshot
              )
            }),
          identities
        )
      )
      .toBe(true)
    await session.close(app)
    app = null
    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    // Assert before opening either chat: no live agent or title lookup can repair this layout.
    await expect(second.page.locator('[data-chat-sidebar-id]')).toHaveCount(2)
    await expect(second.page.locator('[data-chat-sub-tab-elbow]')).toHaveCount(1)
    await expect(second.page.locator('[data-chat-agent="claude"]')).toHaveCount(1)
    await expect(second.page.locator('[data-chat-agent="codex"]')).toHaveCount(1)
    await second.page.screenshot({ path: testInfo.outputPath('idle-nesting-after-restart.png') })
    await second.page.evaluate((id) => window.__store!.getState().closeTab(id), identities[1].tabId)
    const closed = second.page
      .locator('[data-chat-sidebar-id]')
      .filter({ hasText: 'claude saved conversation' })
    await expect(closed).toHaveAttribute('data-chat-completed', 'true')
    await expect(closed).not.toHaveAttribute('data-chat-sub-tab', 'true')
    await expect(second.page.locator('[data-chat-sub-tab-elbow]')).toHaveCount(0)
    const doneHeading = second.page.getByRole('button', { name: 'Done (1)', exact: true })
    await doneHeading.click()
    await expect(doneHeading).toHaveAttribute('aria-expanded', 'false')
    await expect(closed).toHaveCount(0)
    const progressHeading = second.page.getByRole('button', {
      name: 'In Progress (1)',
      exact: true
    })
    await progressHeading.click()
    await expect(second.page.locator('[data-chat-sidebar-id]')).toHaveCount(0)
    await doneHeading.click()
    await expect(closed).toHaveCount(1)
    await session.close(app)
    app = null
    const third = await session.launch()
    app = third.app
    await waitForSessionReady(third.page)
    await expect(
      third.page.getByRole('button', { name: 'In Progress (1)', exact: true })
    ).toHaveAttribute('aria-expanded', 'false')
    await expect(third.page.locator('[data-chat-sidebar-id]')).toHaveCount(1)
  } finally {
    if (app) {
      await session.close(app).catch(() => undefined)
    }
    await session.dispose()
  }
})
