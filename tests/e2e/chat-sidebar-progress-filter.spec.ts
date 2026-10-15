import { expect, test } from './helpers/orca-app'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'

test('folder grouping filters Done chats through the menu and persists across restart', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  await retryTransientMainEvaluate(() =>
    electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false)
      }
    })
  )
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    const worktree = Object.values(state.worktreesByRepo).flat()[0]
    const tabs = [state.createTab(worktree.id), state.createTab(worktree.id)]
    const names = ['In-progress parent', 'Idle in-progress child', 'Completed history']
    const ids = [tabs[0].id, tabs[1].id, 'completed-filter-history']
    const timestamp = Date.now() - 3_600_000
    const keys = ids.map((id) => JSON.stringify(['local', 'codex', id]))
    window.__store!.setState((current) => ({
      tabsByWorktree: {
        ...current.tabsByWorktree,
        [worktree.id]: current.tabsByWorktree[worktree.id].map((tab) => {
          const index = ids.indexOf(tab.id)
          return index === -1
            ? tab
            : {
                ...tab,
                launchAgent: 'codex',
                aiVaultTitle: {
                  agent: 'codex',
                  sessionId: tab.id,
                  title: names[index]
                }
              }
        })
      }
    }))
    await state.updateSettings({
      chatSidebar: {
        view: 'chats',
        groupBy: 'folder',
        showOnlyInProgress: false,
        completed: { [keys[2]]: { done: true, at: timestamp, activityAt: timestamp } },
        sessions: Object.fromEntries(
          ids.map((sessionId, index) => [
            keys[index],
            {
              worktreeId: worktree.id,
              snapshot: {
                executionHostId: 'local',
                agent: 'codex',
                sessionId,
                title: names[index],
                cwd: worktree.path,
                filePath: `/sessions/${sessionId}.jsonl`,
                codexHome: null,
                createdAt: new Date(timestamp).toISOString(),
                updatedAt: new Date(timestamp).toISOString(),
                modifiedAt: new Date(timestamp).toISOString()
              }
            }
          ])
        )
      }
    })
  })
  const rows = orcaPage.locator('[data-chat-sidebar-id]')
  const completed = rows.filter({ hasText: 'Completed history' })
  const child = rows.filter({ hasText: 'Idle in-progress child' })
  await expect(rows).toHaveCount(3)
  await expect(completed).toHaveAttribute('data-chat-completed', 'true')
  await expect(child).toHaveAttribute('data-chat-sub-tab', 'true')
  await orcaPage
    .getByRole('button', { name: 'Chat grouping and folder filters', exact: true })
    .click()
  const filter = orcaPage.getByRole('menuitemcheckbox', {
    name: 'Hide Done chats',
    exact: true
  })
  await expect(filter).toHaveAttribute('aria-checked', 'false')
  await filter.click()
  await expect(filter).toHaveAttribute('aria-checked', 'true')
  await orcaPage.keyboard.press('Escape')
  await expect(rows).toHaveCount(2)
  await expect(completed).toHaveCount(0)
  await expect(child).toHaveAttribute('data-chat-state', 'idle')
  await expect(child).toHaveAttribute('data-chat-sub-tab', 'true')
  await orcaPage.getByPlaceholder('Find chat...').click()
  await expect(filter).toBeHidden()
  await orcaPage.screenshot({ path: testInfo.outputPath('folder-progress-filter.png') })
  await orcaPage.reload()
  await expect(rows).toHaveCount(2)
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__store!.getState().settings?.chatSidebar?.showOnlyInProgress)
    )
    .toBe(true)
  await orcaPage
    .getByRole('button', { name: 'Chat grouping and folder filters', exact: true })
    .click()
  await filter.click()
  await expect(filter).toHaveAttribute('aria-checked', 'false')
  await orcaPage.keyboard.press('Escape')
  await expect(rows).toHaveCount(3)
  await expect(completed).toHaveAttribute('data-chat-completed', 'true')
})

test('fresh recovered status replaces the orange dashed circle without changing the chat timestamp', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  await retryTransientMainEvaluate(() =>
    electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false)
      }
    })
  )
  const ids = await orcaPage.evaluate(async () => {
    const s = window.__store!.getState()
    const worktree = Object.values(s.worktreesByRepo).flat()[0]
    const tab = s.createTab(worktree.id)
    const paneKey = `${tab.id}:77777777-7777-4777-8777-777777777777`
    const timestamp = Date.now() - 3_600_000
    window.__store!.setState((current) => ({
      tabsByWorktree: {
        ...current.tabsByWorktree,
        [worktree.id]: current.tabsByWorktree[worktree.id].map((t) =>
          t.id === tab.id
            ? {
                ...t,
                launchAgent: 'codex',
                aiVaultTitle: { agent: 'codex', sessionId: tab.id, title: 'Compact recovery' }
              }
            : t
        )
      },
      ptyIdsByTabId: { ...current.ptyIdsByTabId, [tab.id]: ['recovery-test-live-pty'] },
      agentStatusByPaneKey: {
        ...current.agentStatusByPaneKey,
        [paneKey]: {
          paneKey,
          tabId: tab.id,
          worktreeId: worktree.id,
          state: 'working',
          agentType: 'codex',
          prompt: 'Continue',
          stateStartedAt: timestamp,
          turnStartedAt: timestamp,
          updatedAt: timestamp,
          evidenceObservedAt: timestamp,
          stateHistory: []
        }
      }
    }))
    await s.updateSettings({ chatSidebar: { view: 'chats', groupBy: 'status' } })
    return { paneKey }
  })
  const row = orcaPage.locator('[data-chat-sidebar-id]').filter({ hasText: 'Compact recovery' })
  await expect(row).toHaveAttribute('data-chat-state', 'unverifiable')
  await expect(row.getByLabel('No recent update', { exact: true })).toBeVisible()
  const timestamp = await row.locator('[data-chat-title] + span').getAttribute('title')
  await orcaPage.screenshot({ path: testInfo.outputPath('orange-stale-indicator.png') })
  await orcaPage.evaluate(
    ({ paneKey }) =>
      window.__store!.setState((s) => ({
        agentStatusByPaneKey: {
          ...s.agentStatusByPaneKey,
          [paneKey]: {
            ...s.agentStatusByPaneKey[paneKey],
            updatedAt: Date.now(),
            evidenceObservedAt: Date.now()
          }
        }
      })),
    ids
  )
  await expect(row).toHaveAttribute('data-chat-state', 'working')
  await expect(row.getByLabel('Working', { exact: true })).toBeVisible()
  await expect(row.getByLabel('No recent update', { exact: true })).toHaveCount(0)
  await expect(row.locator('[data-chat-title] + span')).toHaveAttribute('title', timestamp ?? '')
  await orcaPage.screenshot({ path: testInfo.outputPath('working-recovered-indicator.png') })
})
