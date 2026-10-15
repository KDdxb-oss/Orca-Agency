import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron, expect, test, type Page } from '@stablyai/playwright-test'
import { Terminal } from '@xterm/headless'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { assertPackagedExecutableIdentity } from './helpers/packaged-executable-identity'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import { captureHiddenRendererScreenshot } from './helpers/hidden-renderer-screenshot'

async function clickPrintedFileLink(
  page: Page,
  printedPath: string,
  worktreeId: string
): Promise<void> {
  const snapshot = async () =>
    page.evaluate(async (owner) => {
      const session = (await window.api.pty.listSessions()).find(
        (item) => item.worktreeId === owner || item.id.startsWith(`${owner}@@`)
      )
      return session
        ? window.api.pty.getMainBufferSnapshot(session.id, { scrollbackRows: 100 })
        : null
    }, worktreeId)
  await expect
    .poll(async () => (await snapshot())?.data.split(printedPath).length ?? 0, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3)
  const frame = await snapshot()
  if (!frame) {
    throw new Error('Terminal snapshot unavailable')
  }
  const terminal = new Terminal({ cols: frame.cols, rows: frame.rows })
  await new Promise<void>((resolve) => terminal.write(frame.data, resolve))
  const buffer = terminal.buffer.active
  const visibleRows = Array.from({ length: frame.rows }, (_, row) =>
    (buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? '').padEnd(frame.cols)
  )
  const visibleCells = visibleRows.join('')
  terminal.dispose()
  const printedRow = visibleRows.findLastIndex((line) => line.trim() === printedPath)
  if (printedRow === -1) {
    throw new Error(`Terminal did not render a standalone line containing ${printedPath}`)
  }
  const start = printedRow * frame.cols + visibleRows[printedRow].indexOf(printedPath)
  const center = start + Math.floor(printedPath.length / 2)
  const screen = await page.locator('.xterm:visible .xterm-screen').boundingBox()
  if (!screen) {
    throw new Error('Visible terminal screen unavailable')
  }
  const point = {
    x: screen.x + ((center % frame.cols) + 0.5) * (screen.width / frame.cols),
    y: screen.y + (Math.floor(center / frame.cols) + 0.5) * (screen.height / frame.rows)
  }
  writeFileSync(
    test.info().outputPath('link-probe.json'),
    JSON.stringify({ frame, screen, point, visibleCells }, null, 2)
  )
  // Why: hidden Electron windows can defer painting; capture a frame before hit testing.
  await captureHiddenRendererScreenshot(page, test.info().outputPath('link-probe.png'))
  await page.mouse.move(point.x, point.y)
  await expect(
    page.locator('.pane-link-tooltip:visible').filter({ hasText: 'linked.md' })
  ).toBeVisible()
  await page.mouse.click(point.x, point.y)
  const popover = page.locator('[data-terminal-link-action-popover]')
  await expect(popover).toBeVisible()
  await expect(popover.locator('[data-terminal-link-destination]')).toContainText('linked.md')
  await popover.getByRole('button', { name: /Open file/i }).click()
}

test('packaged file links and folder workspace splits retain their workspace', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
{}, testInfo) => {
  const executablePath = process.env.ORCA_SMOKE_EXECUTABLE
  test.skip(!executablePath, 'Set ORCA_SMOKE_EXECUTABLE to the packaged Orca executable')
  test.setTimeout(240_000)
  const userDataDir = testInfo.outputPath('profile')
  const folders = ['a', 'b'].map((name) => path.join(userDataDir, name))
  folders.forEach((folder) => mkdirSync(folder, { recursive: true }))
  writeFileSync(path.join(folders[0], 'linked.md'), '# File link smoke\n')
  writeFileSync(path.join(folders[1], 'linked.md'), '# Second file link smoke\n')
  const externalFile = path.join(userDataDir, 'app-code', 'docs', 'agent', 'linked.md')
  mkdirSync(path.dirname(externalFile), { recursive: true })
  writeFileSync(externalFile, '# Relative file from the same chat\n')
  const externalAnchor = path.join(path.dirname(externalFile), 'research.md')
  writeFileSync(externalAnchor, '# Earlier research file\n')
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    JSON.stringify(getE2ECompletedOnboardingProfile())
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...inheritedEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir
  })
  const app = await electron.launch({
    executablePath,
    args: [],
    env: { ...isolation.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_E2E_HEADLESS: '1' }
  })
  try {
    await assertPackagedExecutableIdentity(app, executablePath)
    const page = await app.firstWindow()
    await retryTransientMainEvaluate(() =>
      app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.setBackgroundThrottling(false)
        }
      })
    )
    await page.waitForFunction(() => Boolean(window.api))
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const ids = await page.evaluate(async (folderPaths) => {
      const group = await window.api.projectGroups.create({
        name: 'File link smoke',
        parentPath: folderPaths[0]
      })
      const ids: string[] = []
      for (const [index, folderPath] of folderPaths.entries()) {
        const folder = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          folderPath,
          name: `Link project ${index + 1}`
        })
        ids.push(folder.id)
      }
      return ids
    }, folders)
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api))
    const row = (id: string) => page.locator(`[role="option"][data-worktree-id="folder:${id}"]`)

    await row(ids[0]).locator('[data-worktree-card-surface]').click()
    await expect(row(ids[0])).toHaveAttribute('aria-current', 'page')
    await expect
      .poll(() => page.evaluate(async () => (await window.api.pty.listSessions()).length), {
        timeout: 30_000
      })
      .toBe(1)
    await page.locator('.xterm:visible .xterm-helper-textarea').click()
    await expect(page.locator('.xterm:visible .xterm-helper-textarea')).toBeFocused()
    await page.keyboard.type('echo ./linked.md')
    await page.keyboard.press('Enter')
    await clickPrintedFileLink(page, './linked.md', `folder:${ids[0]}`)
    await expect(page.locator('.editor-header-path').first()).toContainText('linked.md')
    await expect(row(ids[0])).toHaveAttribute('aria-current', 'page')
    await app.evaluate(({ ipcMain }) => {
      // Capture the app's clipboard boundary without overwriting Brooks's clipboard.
      ipcMain.removeHandler('clipboard:writeText')
      ipcMain.handle('clipboard:writeText', (_event, text: string) => {
        Reflect.set(globalThis, 'copiedFilePathSmoke', text)
      })
    })
    await page
      .locator('[data-tab-id]')
      .filter({ hasText: 'linked.md' })
      .first()
      .click({ button: 'right' })
    const copyPath = page.getByRole('menuitem', { name: 'Copy Path', exact: true })
    await expect(copyPath).toBeVisible()
    await expect(copyPath).toBeEnabled()
    // Hidden Windows renderers can stop the pointer-stability animation frames.
    await copyPath.click({ force: true })
    await expect
      .poll(() =>
        app.evaluate(() =>
          'copiedFilePathSmoke' in globalThis ? globalThis.copiedFilePathSmoke : undefined
        )
      )
      .toBe(path.join(folders[0], 'linked.md'))

    await page
      .locator('[data-tab-id]')
      .filter({ hasText: 'linked.md' })
      .first()
      .locator('[data-tab-close-button]')
      .click()
    await page.locator('.xterm:visible .xterm-helper-textarea').click()
    // An earlier sibling proves the code folder; the target's full path is never printed.
    const printedExternalAnchor = externalAnchor.replaceAll('\\', '/')
    await page.keyboard.type(`echo "${printedExternalAnchor}"`)
    await page.keyboard.press('Enter')
    await page.keyboard.type('echo docs/agent/linked.md')
    await page.keyboard.press('Enter')
    await clickPrintedFileLink(page, 'docs/agent/linked.md', `folder:${ids[0]}`)
    await expect(page.locator('.editor-header-path').first()).toContainText('linked.md')
    await expect(
      page.getByText('Relative file from the same chat', { exact: false }).first()
    ).toBeVisible()
    await expect(row(ids[0])).toHaveAttribute('aria-current', 'page')
    await captureHiddenRendererScreenshot(
      page,
      testInfo.outputPath('relative-file-in-owning-chat.png')
    )

    await row(ids[1]).locator('[data-worktree-card-surface]').click()
    await expect(row(ids[1])).toHaveAttribute('aria-current', 'page')
    await expect
      .poll(() => page.evaluate(async () => (await window.api.pty.listSessions()).length), {
        timeout: 30_000
      })
      .toBe(2)
    await page.locator('.xterm:visible .xterm-helper-textarea').click()
    await expect(page.locator('.xterm:visible .xterm-helper-textarea')).toBeFocused()
    await page.keyboard.type('echo ./linked.md')
    await page.keyboard.press('Enter')
    await clickPrintedFileLink(page, './linked.md', `folder:${ids[1]}`)
    await expect(page.locator('.editor-header-path').first()).toContainText('linked.md')
    await expect(row(ids[1])).toHaveAttribute('aria-current', 'page')
    await captureHiddenRendererScreenshot(
      page,
      testInfo.outputPath('file-in-current-workspace.png')
    )

    const surface = (id: string) => page.locator(`[data-workspace-surface-id="folder:${id}"]`)
    await row(ids[0]).locator('[data-worktree-card-surface]').click()
    const bounds = await surface(ids[0]).boundingBox()
    expect(bounds).not.toBeNull()
    await row(ids[1])
      .locator('[data-worktree-card-surface]')
      .dragTo(surface(ids[0]), {
        sourcePosition: { x: 80, y: 16 },
        targetPosition: { x: 8, y: Math.floor(bounds!.height / 2) }
      })
    await expect(page.locator('[data-workspace-split="true"]')).toBeVisible()
    await expect(surface(ids[0]).locator('[data-tab-group-body-id]')).toBeVisible()
    await expect(surface(ids[1]).locator('[data-tab-group-body-id]')).toBeVisible()
    await row(ids[1]).locator('[data-worktree-card-surface]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Unsplit workspace' }).click()
    await expect(page.locator('[data-workspace-split="true"]')).toHaveCount(0)
    await expect(row(ids[0])).toHaveAttribute('aria-current', 'page')

    await row(ids[1])
      .locator('[data-worktree-card-surface]')
      .dragTo(surface(ids[0]), {
        sourcePosition: { x: 80, y: 16 },
        targetPosition: { x: 8, y: Math.floor(bounds!.height / 2) }
      })
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api))
    await row(ids[0]).locator('[data-worktree-card-surface]').click()
    await expect(page.locator('[data-workspace-split="true"]')).toBeVisible()
    await expect(surface(ids[0])).toBeVisible()
    await expect(surface(ids[1])).toBeVisible()
    await captureHiddenRendererScreenshot(page, testInfo.outputPath('folder-workspace-split.png'))
    await row(ids[1]).locator('[data-worktree-card-surface]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Unsplit workspace' }).click()
    await expect(page.locator('[data-workspace-split="true"]')).toHaveCount(0)
    await expect(row(ids[0])).toHaveAttribute('aria-current', 'page')
    expect(errors).toEqual([])
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
  }
})
