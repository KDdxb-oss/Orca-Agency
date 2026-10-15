import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron, test, expect } from '@stablyai/playwright-test'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import { assertPackagedExecutableIdentity } from './helpers/packaged-executable-identity'
import { waitForPackagedNativeShellInput } from './helpers/packaged-native-shell-readiness'

function readShellOutput(file: string): string {
  const bytes = readFileSync(file)
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8')
}

// Run against the production executable, without the test-only renderer store.
test('packaged sidebar and cross-workspace terminals', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
{}, testInfo) => {
  const executablePath = process.env.ORCA_SMOKE_EXECUTABLE
  test.skip(!executablePath, 'Set ORCA_SMOKE_EXECUTABLE to the packaged Orca executable')
  test.setTimeout(180_000)
  const userDataDir = testInfo.outputPath('profile')
  mkdirSync(userDataDir, { recursive: true })
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    JSON.stringify({
      ...profile,
      ui: { ...profile.ui, groupBy: 'workspace-status', sortBy: 'smart' }
    })
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
    expect(
      await retryTransientMainEvaluate(() => app.evaluate(({ app }) => app.getPath('home')))
    ).toBe(isolation.isolatedHome)
    expect(await retryTransientMainEvaluate(() => app.evaluate(({ app }) => app.isPackaged))).toBe(
      true
    )
    const page = await app.firstWindow({ timeout: 60_000 })
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
    const folderPaths = ['first', 'second', 'third'].map((name) => path.join(userDataDir, name))
    folderPaths.forEach((folder) => mkdirSync(folder, { recursive: true }))
    const ids = await page.evaluate(async (folders) => {
      const group = await window.api.projectGroups.create({
        name: 'Smoke projects',
        parentPath: folders[0]
      })
      const ids: string[] = []
      for (const [index, folderPath] of folders.entries()) {
        const folder = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          folderPath,
          name: `Smoke project ${index + 1}`
        })
        await window.api.folderWorkspaces.update({
          folderWorkspaceId: folder.id,
          updates: {
            workspaceStatus: 'in-progress',
            lastActivityAt: Date.now() - (index + 1) * 86400000
          }
        })
        ids.push(folder.id)
      }
      return ids
    }, folderPaths)
    await page.reload()
    await page.waitForFunction(() => Boolean(window.api))
    const row = (id: string) =>
      page.locator(`[role="option"][data-worktree-id="folder:${id}"]`).first()
    const lane = (id: string) =>
      row(id).evaluate((element) => {
        const top = element.getBoundingClientRect().top
        return [...document.querySelectorAll('[role="button"][data-workspace-status]')]
          .filter((header) => header.getBoundingClientRect().top < top)
          .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
          ?.getAttribute('data-workspace-status')
      })
    const list = page.locator('[role="listbox"][data-worktree-sidebar]')
    await expect(row(ids[0])).toBeVisible()
    await expect(row(ids[0]).locator('[data-worktree-status-context]')).toContainText(
      'Smoke projects'
    )
    await expect(row(ids[0]).locator('[data-worktree-status-context]')).toContainText('1d')
    await row(ids[2]).locator('[data-worktree-card-surface]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to Status' }).hover()
    await page.getByRole('menuitemradio', { name: 'Done' }).click()
    await expect.poll(() => lane(ids[2])).toBe('completed')
    await row(ids[0]).locator('[data-worktree-card-surface]').click()
    await expect(page.locator('.xterm:visible')).toHaveCount(1, { timeout: 30_000 })
    await expect(list).toBeFocused()
    await page.keyboard.press('Delete')
    await expect.poll(() => lane(ids[0])).toBe('completed')
    await page.keyboard.press('Delete')
    await expect.poll(() => lane(ids[0])).toBe('completed')
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(async () => (await window.api.pty.listSessions()).length), {
        timeout: 30_000
      })
      .toBe(1)
    await waitForPackagedNativeShellInput(page, `folder:${ids[0]}`)
    await page.keyboard.type('echo FIRST_WORKSPACE_SMOKE > smoke-output.txt')
    await page.keyboard.press('Enter')
    await expect
      .poll(
        () => {
          const file = path.join(folderPaths[0], 'smoke-output.txt')
          return existsSync(file) ? readShellOutput(file) : ''
        },
        { timeout: 45_000 }
      )
      .toContain('FIRST_WORKSPACE_SMOKE')

    await row(ids[1]).locator('[data-worktree-card-surface]').click()
    await expect(page.locator('.xterm:visible')).toHaveCount(1, { timeout: 30_000 })
    await expect(list).toBeFocused()
    await page.keyboard.press('Delete')
    await expect.poll(() => lane(ids[1])).toBe('completed')
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm:visible .xterm-helper-textarea')).toBeFocused()
    await page.keyboard.press('Delete')
    await expect.poll(() => lane(ids[1])).toBe('completed')
    await expect
      .poll(() => page.evaluate(async () => (await window.api.pty.listSessions()).length), {
        timeout: 30_000
      })
      .toBe(2)
    await waitForPackagedNativeShellInput(page, `folder:${ids[1]}`)
    await page.keyboard.type('echo SECOND_WORKSPACE_SMOKE > smoke-output.txt')
    await page.keyboard.press('Enter')
    await expect
      .poll(
        () => {
          const file = path.join(folderPaths[1], 'smoke-output.txt')
          return existsSync(file) ? readShellOutput(file) : ''
        },
        { timeout: 45_000 }
      )
      .toContain('SECOND_WORKSPACE_SMOKE')

    // Exercise the main-to-renderer bridge and real metadata persistence.
    const session = await page.evaluate(async () => {
      await window.api.session.flush()
      return window.api.session.get()
    })
    const tab = session.tabsByWorktree[`folder:${ids[1]}`]?.[0]
    if (!tab) {
      throw new Error('Second workspace did not persist its terminal tab')
    }
    const leafId = session.terminalLayoutsByTabId[tab.id]?.activeLeafId
    if (!leafId) {
      throw new Error('Second workspace did not persist its terminal pane')
    }
    const now = Date.now()
    const status = {
      paneKey: `${tab.id}:${leafId}`,
      tabId: tab.id,
      worktreeId: `folder:${ids[1]}`,
      connectionId: null,
      state: 'working',
      agentType: 'claude',
      prompt: 'Smoke new task',
      receivedAt: now,
      stateStartedAt: now
    }
    await retryTransientMainEvaluate(() =>
      app.evaluate(({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0].webContents.send('agentStatus:set', payload)
      }, status)
    )
    await expect.poll(() => lane(ids[1])).toBe('in-progress')
    await expect(row(ids[1])).toContainText('Smoke new task')
    await row(ids[1]).locator('[data-worktree-card-surface]').click()
    await page.keyboard.press('Delete')
    await expect.poll(() => lane(ids[1])).toBe('completed')
    await retryTransientMainEvaluate(() =>
      app.evaluate(
        ({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send('agentStatus:set', payload)
        },
        {
          ...status,
          receivedAt: now + 1,
          evidenceObservedAt: now - 120_000,
          restoredUnconfirmed: true
        }
      )
    )
    await expect.poll(() => lane(ids[1])).toBe('completed')

    // Smart prioritizes working attention; Recent uses the recorded activity times.
    await page.evaluate(async (ids) => {
      for (const [index, id] of ids.slice(0, 2).entries()) {
        await window.api.folderWorkspaces.update({
          folderWorkspaceId: id,
          updates: {
            lastActivityAt: Date.now() + (2 - index) * 600_000
          }
        })
      }
    }, ids)
    const displayedOrder = () =>
      page.locator('[role="option"][data-worktree-id]').evaluateAll((elements) =>
        elements
          .map((element) => ({
            id: element.getAttribute('data-worktree-id'),
            top: element.getBoundingClientRect().top
          }))
          .sort((a, b) => a.top - b.top)
          .map((element) => element.id)
      )
    await expect
      .poll(async () =>
        (await displayedOrder()).filter(
          (id) => id === `folder:${ids[0]}` || id === `folder:${ids[1]}`
        )
      )
      .toEqual([`folder:${ids[1]}`, `folder:${ids[0]}`])
    await page.reload()
    await page.getByRole('button', { name: 'Workspace options' }).click()
    await page.getByRole('menuitem', { name: /Sort by/ }).hover()
    await page.getByRole('menuitemradio', { name: 'Name', exact: true }).click()
    await page.keyboard.press('Escape')
    // Reattached PTYs can bump activity during reload; set the comparison after they reconnect.
    await page.evaluate(async (ids) => {
      for (const [index, id] of ids.slice(0, 2).entries()) {
        await window.api.folderWorkspaces.update({
          folderWorkspaceId: id,
          updates: { lastActivityAt: Date.now() + (2 - index) * 600_000 }
        })
      }
    }, ids)
    await page.getByRole('button', { name: 'Workspace options' }).click()
    await page.getByRole('menuitem', { name: /Sort by/ }).hover()
    await page.getByRole('menuitemradio', { name: 'Recent', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect
      .poll(async () =>
        (await displayedOrder()).filter(
          (id) => id === `folder:${ids[0]}` || id === `folder:${ids[1]}`
        )
      )
      .toEqual([`folder:${ids[0]}`, `folder:${ids[1]}`])

    await page.getByText('Sessions', { exact: true }).first().click()
    const cards = page.locator('[data-testid="session-grid-card"]')
    await expect(cards).toHaveCount(2)
    await expect(cards.locator('.xterm')).toHaveCount(2, { timeout: 30_000 })
    await cards.nth(0).locator('.xterm').click()
    await page.keyboard.type('echo GRID_CARD_ZERO > grid-output.txt')
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        folderPaths.some((folder) => {
          const file = path.join(folder, 'grid-output.txt')
          return existsSync(file) && readShellOutput(file).includes('GRID_CARD_ZERO')
        })
      )
      .toBe(true)
    await cards.nth(1).locator('.xterm').click()
    await page.keyboard.type('echo GRID_CARD_ONE > grid-output.txt')
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        folderPaths.some((folder) => {
          const file = path.join(folder, 'grid-output.txt')
          return existsSync(file) && readShellOutput(file).includes('GRID_CARD_ONE')
        })
      )
      .toBe(true)
    const outputs = folderPaths
      .slice(0, 2)
      .map((folder) => readShellOutput(path.join(folder, 'grid-output.txt')))
    expect(outputs.some((output) => output.includes('GRID_CARD_ZERO'))).toBe(true)
    expect(outputs.some((output) => output.includes('GRID_CARD_ONE'))).toBe(true)
    expect(errors).toEqual([])
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    try {
      const page = app.windows()[0]
      if (page) {
        await page
          .screenshot({ path: testInfo.outputPath('packaged-sidebar-final.png') })
          .catch(() => {})
        const snapshots = await page
          .evaluate(async () => {
            const sessions = await window.api.pty.listSessions()
            return Promise.all(
              sessions.map(async (session) => ({
                session,
                snapshot: await window.api.pty.getMainBufferSnapshot(session.id, {
                  scrollbackRows: 100
                })
              }))
            )
          })
          .catch(() => null)
        writeFileSync(
          testInfo.outputPath('terminal-snapshots.json'),
          JSON.stringify(snapshots, null, 2)
        )
      }
    } finally {
      try {
        await closeElectronAppForE2E(app)
      } finally {
        await cleanupE2EDaemons(userDataDir)
      }
    }
  }
})
