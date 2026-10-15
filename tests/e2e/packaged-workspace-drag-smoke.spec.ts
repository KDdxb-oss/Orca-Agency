import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  test,
  expect,
  type Page,
  type ElectronApplication
} from '@stablyai/playwright-test'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { assertPackagedExecutableIdentity } from './helpers/packaged-executable-identity'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import { captureHiddenRendererScreenshot } from './helpers/hidden-renderer-screenshot'

async function headerPoint(page: Page, workspaceId: string) {
  await page
    .locator(`[data-tab-group-strip-id][data-worktree-id="${workspaceId}"]`)
    .waitFor({ state: 'visible' })
  return page.evaluate((id) => {
    const strip = document.querySelector<HTMLElement>(
      `[data-tab-group-strip-id][data-worktree-id="${id}"]`
    )!
    if (
      navigator.userAgent.includes('Windows') &&
      getComputedStyle(strip).getPropertyValue('-webkit-app-region') !== 'no-drag'
    ) {
      throw new Error('The workspace header is still a native window-drag region')
    }
    const bounds = strip.getBoundingClientRect()
    for (let x = bounds.right - 4; x > bounds.left; x -= 4) {
      const y = bounds.top + bounds.height / 2
      const element = document.elementFromPoint(x, y)
      if (
        element &&
        strip.contains(element) &&
        !element.closest('button, a, input, [role="tab"], [role="button"], .terminal-tab-strip')
      ) {
        return { x, y }
      }
    }
    throw new Error('No unused workspace header space')
  }, workspaceId)
}

async function dragTo(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 20, start.y + 20, { steps: 3 })
  await page.mouse.move(end.x, end.y, { steps: 8 })
}

async function captureDragLayout(app: ElectronApplication, page: Page, outputPath: string) {
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().includes('index.html')
    )!
    await window.capturePage(undefined, { stayHidden: true, stayAwake: true })
  })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().includes('index.html')
    )!
    const capture = await window.capturePage(undefined, { stayHidden: true, stayAwake: true })
    if (capture.isEmpty()) {
      throw new Error('Hidden drag layout capture is empty')
    }
    return capture.toPNG().toString('base64')
  })
  writeFileSync(outputPath, Buffer.from(data, 'base64'))
}

test('packaged mouse drags swap quadrants and combine same-folder tab bars', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
{}, testInfo) => {
  const executablePath = process.env.ORCA_SMOKE_EXECUTABLE
  test.skip(!executablePath, 'Set ORCA_SMOKE_EXECUTABLE to the reviewed package')
  test.setTimeout(480_000)
  const profilePath = testInfo.outputPath('profile')
  mkdirSync(profilePath, { recursive: true })
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(profilePath, 'orca-data.json'),
    JSON.stringify({
      ...profile,
      settings: { ...profile.settings, chatSidebar: { view: 'workspaces' } }
    })
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...inheritedEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir: profilePath
  })
  const app = await electron.launch({
    executablePath,
    args: [],
    env: {
      ...isolation.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_HEADLESS: '1',
      PLAYWRIGHT_LEGACY_SCREENSHOT: '1'
    }
  })
  try {
    await assertPackagedExecutableIdentity(app, executablePath)
    const page = await app.firstWindow({ timeout: 60_000 })
    await retryTransientMainEvaluate(() =>
      app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.setBackgroundThrottling(false)
        }
      })
    )
    await page.waitForFunction(() => Boolean(window.api))
    const folders = ['shared', 'second', 'third', 'shared'].map((name) =>
      path.join(profilePath, name)
    )
    folders.forEach((folder) => mkdirSync(folder, { recursive: true }))
    const ids = await page.evaluate(async (paths) => {
      const group = await window.api.projectGroups.create({
        name: 'Drag projects',
        parentPath: paths[0]
      })
      const ids: string[] = []
      for (const [index, folderPath] of paths.entries()) {
        const workspace = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          folderPath,
          name: `Drag ${index}`
        })
        ids.push(`folder:${workspace.id}`)
      }
      return ids
    }, folders)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    for (const id of ids) {
      await page
        .locator(`[role="option"][data-worktree-id="${id}"]`)
        .first()
        .locator('[data-worktree-card-surface]')
        .click()
      await expect(page.locator(`[data-workspace-surface-id="${id}"] .xterm:visible`)).toHaveCount(
        1,
        { timeout: 30_000 }
      )
    }
    await page
      .locator(`[role="option"][data-worktree-id="${ids[2]}"]`)
      .first()
      .locator('[data-worktree-card-surface]')
      .click()
    const rejectedPane = page.locator(`[data-workspace-surface-id="${ids[2]}"]:visible`)
    await rejectedPane.getByRole('button', { name: 'New tab', exact: true }).click()
    await page.getByRole('menuitem', { name: /New Terminal: PowerShell/ }).dispatchEvent('click')
    await expect(rejectedPane.locator('[data-tab-id]')).toHaveCount(2)
    await rejectedPane.getByRole('button', { name: 'New tab', exact: true }).click()
    await page.getByRole('menuitem', { name: /New Terminal: PowerShell/ }).dispatchEvent('click')
    await expect(rejectedPane.locator('[data-tab-id]')).toHaveCount(3)
    await expect
      .poll(async () => (await page.evaluate(() => window.api.pty.listSessions())).length, {
        timeout: 30_000
      })
      .toBe(6)
    const initial = await page.evaluate(async () => {
      await window.api.session.flush()
      return window.api.session.get()
    })
    const terminalIds = ids.map((id) => initial.tabsByWorktree[id][0].id)
    const initialPtyIds = (await page.evaluate(() => window.api.pty.listSessions()))
      .map((item) => item.id)
      .sort()
    const leaf = (workspaceId: string) => ({ type: 'leaf', workspaceId })
    const pair = (direction: string, first: unknown, second: unknown) => ({
      type: 'split',
      direction,
      first,
      second,
      ratio: 0.5
    })
    await page.evaluate(
      (layout) =>
        localStorage.setItem(
          'orca.workspaceSplitGroups.v1',
          JSON.stringify([{ id: 'drag-grid', layout }])
        ),
      pair(
        'horizontal',
        pair('vertical', leaf(ids[0]), leaf(ids[2])),
        pair('vertical', leaf(ids[1]), leaf(ids[3]))
      )
    )
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    const root = page.locator('[data-workspace-split-root]')
    const pane = (id: string) => page.locator(`[data-workspace-surface-id="${id}"]:visible`)
    for (const id of ids) {
      await expect(pane(id)).toBeVisible()
    }
    expect(await page.evaluate(() => '__store' in window)).toBe(false)
    const originalTopRight = (await pane(ids[1]).boundingBox())!
    await dragTo(page, await headerPoint(page, ids[3]), {
      x: originalTopRight.x + originalTopRight.width / 2,
      y: originalTopRight.y + originalTopRight.height / 2
    })
    await expect(page.locator('[data-workspace-drop-swap]')).toBeVisible()
    await captureHiddenRendererScreenshot(page, testInfo.outputPath('occupied-quadrant-swap.png'))
    await page.mouse.up()
    await expect
      .poll(async () => Math.round((await pane(ids[3]).boundingBox())!.y))
      .toBe(Math.round(originalTopRight.y))
    await expect
      .poll(async () => (await pane(ids[1]).boundingBox())!.y > originalTopRight.y + 20)
      .toBe(true)
    await captureDragLayout(app, page, testInfo.outputPath('occupied-quadrant-swap.png'))

    await page
      .locator(`[role="option"][data-worktree-id="${ids[0]}"]`)
      .first()
      .locator('[data-worktree-card-surface]')
      .click()
    await page.evaluate(
      (layout) =>
        localStorage.setItem(
          'orca.workspaceSplitGroups.v1',
          JSON.stringify([{ id: 'drag-grid', layout }])
        ),
      pair('vertical', leaf(ids[0]), pair('horizontal', leaf(ids[1]), leaf(ids[2])))
    )
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    for (const id of ids.slice(0, 3)) {
      await expect(pane(id)).toBeVisible()
    }
    await expect(pane(ids[3])).toHaveCount(0)
    const rowBounds = (await root.boundingBox())!
    await dragTo(page, await headerPoint(page, ids[1]), {
      x: rowBounds.x + rowBounds.width * 0.1,
      y: rowBounds.y + rowBounds.height * 0.1
    })
    await expect(page.locator('[data-workspace-quadrant-drop="top-left"]')).toBeVisible()
    await page.mouse.up()
    await expect
      .poll(async () => (await pane(ids[1]).boundingBox())!.width)
      .toBeCloseTo(rowBounds.width / 2, -1)
    await expect
      .poll(async () => (await pane(ids[2]).boundingBox())!.width)
      .toBeCloseTo(rowBounds.width, -1)
    await captureDragLayout(app, page, testInfo.outputPath('three-pane-row-quadrant.png'))

    // Tall columns reproduce the layout that previously trapped panes away from quadrants.
    await page.evaluate(
      (layout) =>
        localStorage.setItem(
          'orca.workspaceSplitGroups.v1',
          JSON.stringify([{ id: 'drag-grid', layout }])
        ),
      pair(
        'horizontal',
        leaf(ids[0]),
        pair('horizontal', leaf(ids[1]), pair('horizontal', leaf(ids[2]), leaf(ids[3])))
      )
    )
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    for (const id of ids) {
      await expect(pane(id)).toBeVisible()
    }
    const bounds = (await root.boundingBox())!
    const end = { x: bounds.x + bounds.width * 0.9, y: bounds.y + bounds.height * 0.9 }
    await dragTo(page, await headerPoint(page, ids[1]), end)
    await expect(page.locator('[data-workspace-quadrant-drop="bottom-right"]')).toBeVisible()
    await captureHiddenRendererScreenshot(
      page,
      testInfo.outputPath('bottom-right-quadrant-drop.png')
    )
    await page.mouse.up()
    await expect
      .poll(async () => Math.round((await pane(ids[1]).boundingBox())!.height))
      .toBeCloseTo(Math.round(bounds.height / 2), -1)
    await expect
      .poll(async () => (await pane(ids[1]).boundingBox())!.x > bounds.x + bounds.width * 0.4)
      .toBe(true)
    await captureDragLayout(app, page, testInfo.outputPath('bottom-right-quadrant-drop.png'))

    const sourceTab = pane(ids[3]).locator(`[data-tab-id="${terminalIds[3]}"]`)
    const targetTab = pane(ids[0]).locator(`[data-tab-id="${terminalIds[0]}"]`)
    const sourceBounds = (await sourceTab.boundingBox())!
    const targetBounds = (await targetTab.boundingBox())!
    const rejectedTab = pane(ids[2]).locator('[data-tab-id]').nth(1)
    await rejectedTab.click()
    const rejectedStructure = async () => ({
      order: await pane(ids[2])
        .locator('[data-tab-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-id'))),
      groups: await pane(ids[2])
        .locator('[data-tab-group-strip-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-group-strip-id'))),
      splits: await page.evaluate(() => localStorage.getItem('orca.workspaceSplitGroups.v1'))
    })
    const beforeRejection = await rejectedStructure()
    const rejectedBounds = (await rejectedTab.boundingBox())!
    await dragTo(
      page,
      { x: rejectedBounds.x + 30, y: rejectedBounds.y + 16 },
      { x: targetBounds.x + 4, y: targetBounds.y + 16 }
    )
    await expect(page.locator('[data-workspace-tab-insertion]')).toHaveCount(0)
    await page.mouse.up()
    await expect(rejectedTab).toBeVisible()
    expect(await rejectedStructure()).toEqual(beforeRejection)
    await expect(pane(ids[0]).locator('[data-tab-id]')).toHaveCount(1)
    await dragTo(
      page,
      { x: sourceBounds.x + 30, y: sourceBounds.y + 16 },
      { x: targetBounds.x + 4, y: targetBounds.y + 16 }
    )
    await expect(page.locator('[data-workspace-tab-insertion="0"]')).toBeVisible()
    await captureHiddenRendererScreenshot(
      page,
      testInfo.outputPath('same-folder-tab-insertion.png')
    )
    await page.mouse.up()
    await expect(pane(ids[0]).locator(`[data-tab-id="${terminalIds[3]}"]`)).toBeVisible()
    await expect(pane(ids[3])).toHaveCount(0)
    await captureDragLayout(app, page, testInfo.outputPath('same-folder-tab-insertion.png'))
    const final = await page.evaluate(async () => {
      await window.api.session.flush()
      return window.api.session.get()
    })
    expect(final.tabsByWorktree[ids[0]].map((tab) => tab.id).sort()).toEqual(
      [terminalIds[0], terminalIds[3]].sort()
    )
    expect(final.tabsByWorktree[ids[3]] ?? []).toEqual([])
    await targetTab.click()
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    await expect(pane(ids[0]).locator('[data-tab-id]')).toHaveCount(2)
    expect(
      await pane(ids[0])
        .locator('[data-tab-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-id')))
    ).toEqual([terminalIds[3], terminalIds[0]])
    expect(
      (await page.evaluate(() => window.api.pty.listSessions())).map((item) => item.id).sort()
    ).toEqual(initialPtyIds)
    await pane(ids[0]).getByRole('button', { name: 'New tab', exact: true }).click()
    await page.getByRole('menuitem', { name: /New Terminal: PowerShell/ }).click()
    await expect(pane(ids[0]).locator('[data-tab-id]')).toHaveCount(3)
    const addedTab = pane(ids[0]).locator('[data-tab-id]').last()
    const addedTabId = (await addedTab.getAttribute('data-tab-id'))!
    await addedTab.click({ button: 'right' })
    // Hidden native windows can lose pointer hover while Radix positions the submenu.
    await page.getByRole('menuitem', { name: 'Split terminal', exact: true }).press('ArrowRight')
    await page.getByRole('menuitem', { name: /Split terminal right/ }).press('Enter')
    await expect(pane(ids[0]).locator('.xterm:visible')).toHaveCount(2)
    await expect
      .poll(async () => (await page.evaluate(() => window.api.pty.listSessions())).length)
      .toBe(initialPtyIds.length + 2)
    const created = await page.evaluate(async () => {
      await window.api.session.flush()
      return window.api.session.get()
    })
    expect(created.tabsByWorktree[ids[0]].map((tab) => tab.id)).toContain(addedTabId)
    expect(created.terminalLayoutsByTabId[addedTabId].root?.type).toBe('split')
    const createdPtyIds = (await page.evaluate(() => window.api.pty.listSessions()))
      .map((item) => item.id)
      .sort()
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    await expect(pane(ids[0]).locator('[data-tab-id]')).toHaveCount(3)
    await expect(pane(ids[0]).locator('.xterm:visible')).toHaveCount(2)
    expect(
      (await page.evaluate(() => window.api.pty.listSessions())).map((item) => item.id).sort()
    ).toEqual(createdPtyIds)
    await captureDragLayout(app, page, testInfo.outputPath('create-after-tab-move.png'))
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    try {
      await closeElectronAppForE2E(app)
    } finally {
      await cleanupE2EDaemons(profilePath)
    }
  }
})
