import { expect, test } from './helpers/orca-app'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

test('Done folder collapse, open-only filtering and sidebar renaming persist without hiding idle tabs', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  const userDataPath = await retryTransientMainEvaluate(() =>
    electronApp.evaluate(({ app, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false)
      }
      return app.getPath('userData')
    })
  )
  const folderPath = join(userDataPath, 'Finished folder')
  await mkdir(folderPath, { recursive: true })
  const ids = await orcaPage.evaluate(async (folderPath) => {
    const state = window.__store!.getState()
    const worktree = Object.values(state.worktreesByRepo).flat()[0]
    const tab = state.createTab(worktree.id)
    state.setAiVaultTabTitle(tab.id, { agent: 'codex', sessionId: tab.id, title: 'Idle open chat' })
    state.setActiveWorktree(worktree.id)
    const group = await window.api.projectGroups.create({
      name: 'Finished folder',
      parentPath: folderPath
    })
    await state.fetchProjectGroups()
    const folder = await state.createFolderWorkspace({
      projectGroupId: group.id,
      folderPath,
      name: 'Finished folder'
    })
    if (!folder) {
      throw new Error('Could not create fixture folder')
    }
    const finishedId = 'finished-folder-history'
    const closedId = 'closed-idle-history'
    const timestamp = Date.now() - 3_600_000
    const key = (id: string) => JSON.stringify(['local', 'codex', id])
    await state.updateSettings({
      chatSidebar: {
        view: 'chats',
        groupBy: 'folder',
        completed: { [key(finishedId)]: { done: true, at: timestamp, activityAt: timestamp } },
        sessions: Object.fromEntries(
          [
            [tab.id, worktree.id, worktree.path, 'Idle open chat'],
            [closedId, worktree.id, worktree.path, 'Closed idle chat'],
            [finishedId, `folder:${folder.id}`, folderPath, 'Done folder chat']
          ].map(([sessionId, worktreeId, cwd, title]) => [
            key(sessionId),
            {
              worktreeId,
              snapshot: {
                executionHostId: 'local',
                agent: 'codex',
                sessionId,
                title,
                cwd,
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
    return { tabId: tab.id, finishedKey: key(finishedId) }
  }, folderPath)
  const rows = orcaPage.locator('[data-chat-sidebar-id]')
  const idle = rows.filter({ hasText: 'Idle open chat' })
  const closed = rows.filter({ hasText: 'Closed idle chat' })
  const done = rows.filter({ hasText: 'Done folder chat' })
  const heading = orcaPage.locator('[data-chat-section="chat:folder:Finished folder"]')
  const menu = orcaPage.getByRole('button', {
    name: 'Chat grouping and folder filters',
    exact: true
  })
  await expect(rows).toHaveCount(3)
  await menu.click()
  await orcaPage
    .getByRole('menuitemcheckbox', { name: 'Collapse Done folders', exact: true })
    .click()
  await orcaPage.keyboard.press('Escape')
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await expect(done).toHaveCount(0)
  await expect(idle).toHaveAttribute('data-chat-state', 'idle')
  await expect(closed).toHaveCount(1)
  await heading.click()
  await expect(done).toHaveCount(1)
  await menu.click()
  const collapse = orcaPage.getByRole('menuitemcheckbox', {
    name: 'Collapse Done folders',
    exact: true
  })
  await collapse.click()
  await collapse.click()
  await orcaPage.keyboard.press('Escape')
  await expect(done).toHaveCount(0)
  await heading.click()
  await expect(done).toHaveCount(1)
  await orcaPage.reload()
  await expect(done).toHaveCount(1)
  await heading.click()
  await expect(done).toHaveCount(0)
  await orcaPage.evaluate(async ({ finishedKey }) => {
    const state = window.__store!.getState()
    const current = state.settings!.chatSidebar!
    await state.updateSettings({
      chatSidebar: {
        ...current,
        completed: { [finishedKey]: { ...current.completed![finishedKey], done: false } }
      }
    })
  }, ids)
  await expect(heading).toHaveAttribute('aria-expanded', 'true')
  await expect(done).toHaveCount(1)
  await menu.click()
  await orcaPage
    .getByRole('menuitemcheckbox', { name: 'Show only open chats', exact: true })
    .click()
  await orcaPage.keyboard.press('Escape')
  await expect(rows).toHaveCount(1)
  await expect(idle).toHaveCount(1)
  await idle.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Rename chat', exact: true }).click()
  await orcaPage
    .getByRole('textbox', { name: 'Chat name', exact: true })
    .fill('Consistent chat name')
  await orcaPage.getByRole('button', { name: 'Save', exact: true }).click()
  const renamed = rows.filter({ hasText: 'Consistent chat name' })
  const tab = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${ids.tabId}"]`)
  await expect(renamed).toHaveCount(1)
  await expect(tab).toContainText('Consistent chat name')
  const resumedId = await orcaPage.evaluate(({ tabId }) => {
    const state = window.__store!.getState()
    const original = Object.values(state.tabsByWorktree)
      .flat()
      .find((tab) => tab.id === tabId)!
    state.closeTab(tabId)
    const next = state.createTab(original.worktreeId)
    state.setAiVaultTabTitle(next.id, { agent: 'codex', sessionId: tabId, title: 'Idle open chat' })
    return next.id
  }, ids)
  const resumed = orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${resumedId}"]`)
  await expect(renamed).toHaveCount(1)
  await expect(resumed).toContainText('Consistent chat name')
  // Why: the fixture reopens a tab directly; wait for the main-process session before reloading.
  await expect
    .poll(() =>
      orcaPage.evaluate(async (tabId) => {
        const saved = await window.api.session.get()
        return Object.values(saved.tabsByWorktree)
          .flat()
          .some((tab) => tab.id === tabId && tab.customTitle === 'Consistent chat name')
      }, resumedId)
    )
    .toBe(true)
  await orcaPage.reload()
  await expect(rows).toHaveCount(1)
  await expect(renamed).toHaveCount(1)
  await expect(resumed).toContainText('Consistent chat name')
  await menu.click()
  await expect(
    orcaPage.getByRole('menuitemcheckbox', { name: 'Show only open chats', exact: true })
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('folder-filter-menu.png') })
})
