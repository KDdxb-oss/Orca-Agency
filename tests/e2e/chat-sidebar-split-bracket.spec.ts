import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('split windows stay bracketed and adjacent until unsplit', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
    }
  })
  await waitForSessionReady(orcaPage)
  const ids = await orcaPage.evaluate(async () => {
    const s = window.__store!.getState()
    const original = Object.values(s.worktreesByRepo).flat()[0]
    const group = await window.api.projectGroups.create({
      name: 'Bracket test',
      parentPath: original.path
    })
    await s.fetchProjectGroups()
    const ids: string[] = []
    const names = ['Working split chat', 'Old split partner', 'Recent independent chat']
    for (let index = 0; index < names.length; index++) {
      const folder = await s.createFolderWorkspace({
        projectGroupId: group.id,
        folderPath: original.path,
        name: original.path.split(/[\\/]/).at(-1)
      })
      if (!folder) {
        throw new Error('Could not create bracket test workspace')
      }
      const id = `folder:${folder.id}`
      ids.push(id)
      const tab = s.createTab(id)
      s.setAiVaultTabTitle(tab.id, { agent: 'codex', sessionId: tab.id, title: names[index] })
      if (index === 0) {
        const review = s.createTab(id)
        s.setAiVaultTabTitle(review.id, {
          agent: 'claude',
          sessionId: review.id,
          title: 'Review of working chat'
        })
      }
      window.__store!.setState((current) => ({
        agentStatusByPaneKey: {
          ...current.agentStatusByPaneKey,
          [`${tab.id}:77777777-7777-4777-8777-777777777777`]: {
            paneKey: `${tab.id}:77777777-7777-4777-8777-777777777777`,
            state: index === 0 ? 'working' : 'done',
            agentType: 'codex',
            prompt: names[index],
            stateStartedAt: Date.now() - (index === 1 ? 18_000_000 : 60_000),
            updatedAt: Date.now() - (index === 1 ? 18_000_000 : 60_000),
            stateHistory: [],
            providerSession: { key: 'session_id', id: tab.id }
          }
        }
      }))
    }
    await s.updateSettings({ theme: 'dark', chatSidebar: { view: 'chats', groupBy: 'status' } })
    return ids
  })
  const rows = orcaPage.locator('[data-chat-sidebar-id]')
  const working = rows.filter({ hasText: 'Working split chat' })
  const review = rows.filter({ hasText: 'Review of working chat' })
  const partner = rows.filter({ hasText: 'Old split partner' })
  const independent = rows.filter({ hasText: 'Recent independent chat' })
  await expect(orcaPage.getByText('In Progress (4)', { exact: true })).toBeVisible()
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('Working split chat')
  await expect(rows.nth(1)).toContainText('Review of working chat')
  await expect(rows.nth(2)).toContainText('Recent independent chat')
  await orcaPage.evaluate(
    ([first, second]) => window.__store!.getState().placeWorkspaceAtEdge(second, first, 'right'),
    ids
  )
  await expect(rows.nth(2)).toContainText('Old split partner')
  await expect(orcaPage.locator('[data-chat-split-bracket]')).toHaveCount(3)
  expect(await working.getAttribute('data-chat-split-group')).toBe(
    await partner.getAttribute('data-chat-split-group')
  )
  await expect(review).toHaveAttribute('data-chat-sub-tab', 'true')
  const first = await working.boundingBox()
  const child = await review.boundingBox()
  const second = await partner.boundingBox()
  expect(first!.height).toBe(20)
  expect(child!.height).toBe(36)
  expect(child!.y).toBe(first!.y + first!.height)
  expect(second!.y).toBe(child!.y + child!.height)
  await expect(working.locator('[data-chat-folder]')).toHaveCount(0)
  const joinedTitle = await working.locator('[data-chat-title]').boundingBox()
  const independentTitle = await independent.locator('[data-chat-title]').boundingBox()
  const folder = await review.locator('[data-chat-folder]').boundingBox()
  expect(joinedTitle!.x).toBe(independentTitle!.x)
  expect(folder!.x).toBe(joinedTitle!.x)
  const childTitle = await review.locator('[data-chat-title]').boundingBox()
  const nextTitle = await partner.locator('[data-chat-title]').boundingBox()
  expect(childTitle!.y - (joinedTitle!.y + joinedTitle!.height)).toBeLessThanOrEqual(4)
  expect(folder!.y - (childTitle!.y + childTitle!.height)).toBeLessThanOrEqual(1)
  expect(nextTitle!.y - (folder!.y + folder!.height)).toBeGreaterThanOrEqual(6)
  const bracket = working.locator('[data-chat-split-bracket]')
  const elbow = review.locator('[data-chat-sub-tab-elbow]')
  expect((await bracket.boundingBox())!.width).toBe(4)
  expect((await elbow.boundingBox())!.width).toBe(8)
  expect((await elbow.boundingBox())!.height).toBe(8)
  const elbowColor = await elbow.evaluate((node) => getComputedStyle(node).borderLeftColor)
  await expect(bracket).toHaveCSS('border-left-color', elbowColor)
  await orcaPage.screenshot({ path: testInfo.outputPath('split-chat-bracket.png') })
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ theme: 'light' }))
  await expect(orcaPage.locator('html')).not.toHaveClass(/dark/)
  await orcaPage.screenshot({ path: testInfo.outputPath('split-chat-bracket-light.png') })
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await orcaPage.evaluate((id) => window.__store!.getState().unsplitWorkspace(id), ids[1])
  await expect(orcaPage.locator('[data-chat-split-bracket]')).toHaveCount(0)
  await expect(rows.nth(1)).toContainText('Review of working chat')
  await expect(rows.nth(2)).toContainText('Recent independent chat')
  await expect(rows.nth(3)).toContainText('Old split partner')
  await orcaPage.evaluate(([first, second]) => {
    const s = window.__store!.getState()
    s.placeWorkspaceAtEdge(second, first, 'right')
    s.setActiveWorktree(first)
    s.setActiveView('terminal')
  }, ids)
  const pane = (id: string) => orcaPage.locator(`[data-workspace-surface-id="${id}"]`)
  await expect(pane(ids[0])).toBeVisible()
  await expect(pane(ids[1])).toBeVisible()
  for (const edge of ['bottom', 'top'] as const) {
    await expect(pane(ids[0])).toBeVisible()
    await expect(pane(ids[1])).toBeVisible()
    for (const event of ['dragover', 'drop']) {
      await pane(ids[0]).evaluate(
        (surface, { sourceId, edge, event }) => {
          const rect = surface.getBoundingClientRect()
          const dataTransfer = new DataTransfer()
          dataTransfer.setData('application/x-orca-worktree-id', sourceId)
          surface.dispatchEvent(
            new DragEvent(event, {
              bubbles: true,
              cancelable: true,
              dataTransfer,
              clientX: rect.left + rect.width / 2,
              clientY: edge === 'bottom' ? rect.bottom - 5 : rect.top + 5
            })
          )
        },
        { sourceId: ids[2], edge, event }
      )
      if (event === 'dragover') {
        await expect(orcaPage.locator(`[data-workspace-window-drop="${edge}"]`)).toBeVisible()
      }
    }
    await expect(pane(ids[2])).toBeVisible()
    await expect
      .poll(async () => {
        const a = await pane(ids[0]).boundingBox(),
          b = await pane(ids[1]).boundingBox(),
          c = await pane(ids[2]).boundingBox()
        return !!(
          a &&
          b &&
          c &&
          Math.abs(a.y - b.y) < 1 &&
          (edge === 'bottom' ? c.y >= a.y + a.height : a.y >= c.y + c.height) &&
          Math.abs(c.width - a.width - b.width - 4) < 2
        )
      })
      .toBe(true)
    await expect(orcaPage.locator('[data-chat-split-bracket]')).toHaveCount(4)
    await expect(orcaPage.locator('[data-chat-sub-tab-elbow]')).toHaveCount(1)
    const pairTitles = ['Working split chat', 'Review of working chat', 'Old split partner']
    await expect(rows.locator('[data-chat-title]')).toHaveText(
      edge === 'bottom'
        ? [...pairTitles, 'Recent independent chat']
        : ['Recent independent chat', ...pairTitles]
    )
    await orcaPage.screenshot({ path: testInfo.outputPath(`workspace-full-width-${edge}.png`) })
    if (edge === 'bottom') {
      await orcaPage.evaluate(([first, , third]) => {
        const s = window.__store!.getState()
        s.unsplitWorkspace(third)
        s.setActiveWorktree(first)
      }, ids)
    }
  }
})
