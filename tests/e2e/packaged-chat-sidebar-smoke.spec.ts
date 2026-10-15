import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron, test, expect } from '@stablyai/playwright-test'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { retryTransientMainEvaluate } from './helpers/electron-main-evaluate-retry'
import { assertPackagedExecutableIdentity } from './helpers/packaged-executable-identity'
import { assertPackagedDefaultHomeCodexRestart } from './helpers/packaged-codex-restart-smoke'
import { assertPackagedMouseHistory } from './helpers/packaged-mouse-history-smoke'
import { assertPackagedChatFilterHighlight } from './helpers/packaged-chat-filter-highlight'
import { captureHiddenRendererScreenshot } from './helpers/hidden-renderer-screenshot'

test('packaged chat sidebar restores closed chats and resumes one exact session', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
{}, testInfo) => {
  const executablePath = process.env.ORCA_SMOKE_EXECUTABLE
  test.skip(!executablePath, 'Set ORCA_SMOKE_EXECUTABLE to the reviewed executable')
  // The combined package checks include several cold Windows reloads and screenshots.
  test.setTimeout(360_000)
  const userDataDir = testInfo.outputPath('profile')
  mkdirSync(userDataDir, { recursive: true })
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
    env: {
      ...isolation.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_HEADLESS: '1',
      // Why: use Playwright's established compositor capture path for this hidden fixture.
      PLAYWRIGHT_LEGACY_SCREENSHOT: '1'
    }
  })
  try {
    await assertPackagedExecutableIdentity(app, executablePath)
    expect(
      await retryTransientMainEvaluate(() => app.evaluate(({ app }) => app.getPath('home')))
    ).toBe(isolation.isolatedHome)
    expect(await retryTransientMainEvaluate(() => app.evaluate(({ app }) => app.isPackaged))).toBe(
      true
    )
    expect(
      await retryTransientMainEvaluate(() =>
        app.evaluate(({ app }) =>
          app.commandLine
            .getSwitchValue('enable-features')
            .split(',')
            .includes('CDPScreenshotNewSurface')
        )
      )
    ).toBe(false)
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.setBackgroundThrottling(false)
      }
    })
    await page.waitForFunction(() => Boolean(window.api))
    const nativeArchitecture = await retryTransientMainEvaluate(() =>
      app.evaluate(() => process.arch)
    )
    if (process.platform === 'win32' && nativeArchitecture === 'arm64') {
      const speechPolicy = await page.evaluate(async () => {
        const catalog = await window.api.speech.getCatalog()
        let rejected = false
        try {
          await window.api.speech.startDictation('whisper-tiny', undefined, 'arm-policy-smoke')
        } catch (error) {
          rejected = String(error).includes('Local dictation is unavailable on Windows ARM64.')
        }
        return {
          nativeArchitecture: 'arm64',
          localModels: catalog.filter((model) => model.provider === 'local').length,
          cloudModels: catalog.filter((model) => model.provider === 'openai').length,
          localStartupRejected: rejected
        }
      })
      expect(speechPolicy).toEqual({
        nativeArchitecture: 'arm64',
        localModels: 0,
        cloudModels: 2,
        localStartupRejected: true
      })
      console.log(`ORCA_ARM64_SPEECH_POLICY:${JSON.stringify(speechPolicy)}`)
      await page.evaluate(() => window.api.updater.check())
      const updateStatus = await page.evaluate(() => window.api.updater.getStatus())
      expect(updateStatus).toEqual({ state: 'idle' })
      await expect(page.getByRole('heading', { name: 'Update Check Failed' })).toHaveCount(0)
      await expect(
        page.getByRole('button', { name: 'Update failed. Click to expand.' })
      ).toHaveCount(0)
      await captureHiddenRendererScreenshot(
        page,
        testInfo.outputPath('packaged-quiet-weekly-updates.png')
      )
    }
    expect(await page.evaluate(() => Boolean(window.__store))).toBe(false)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const folder = path.join(userDataDir, 'agency-project')
    mkdirSync(folder, { recursive: true })
    const nextFolder = path.join(userDataDir, 'local-tools')
    mkdirSync(nextFolder, { recursive: true })
    const capture = path.join(folder, 'resume-capture.txt')
    const stub = path.join(folder, 'claude-smoke.cmd')
    writeFileSync(stub, `@echo off\r\necho %CD% ^| %* >> "${capture}"\r\n`)
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    ]
    const projectBucket = path.join(userDataDir, 'projects', 'original-folder')
    mkdirSync(projectBucket, { recursive: true })
    const transcripts = ids.map((id) => path.join(projectBucket, `${id}.jsonl`))
    transcripts.forEach((file, index) =>
      writeFileSync(
        file,
        `${JSON.stringify({ type: 'user', sessionId: ids[index], cwd: folder, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Smoke transcript only' } })}\n`
      )
    )
    await page.evaluate(
      async ({ folder, nextFolder, ids, transcripts, stub }) => {
        await window.api.projectGroups.create({ name: 'Local tools', parentPath: nextFolder })
        const group = await window.api.projectGroups.create({
          name: 'Client folder',
          parentPath: folder
        })
        const workspace = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          folderPath: folder,
          name: 'Client work'
        })
        const now = Date.now()
        const sessions = Object.fromEntries(
          ids.map((id, index) => [
            JSON.stringify(['local', 'claude', id]),
            {
              worktreeId: `folder:${workspace.id}`,
              snapshot: {
                executionHostId: 'local' as const,
                executionHostPlatform: 'win32' as const,
                agent: 'claude' as const,
                sessionId: id,
                title:
                  index === 0
                    ? 'Latest client research'
                    : index === 1
                      ? 'Earlier client draft'
                      : 'Scheduled audit',
                cwd: folder,
                filePath: transcripts[index],
                codexHome: null,
                createdAt: new Date(now - 86_400_000).toISOString(),
                updatedAt: new Date(now - (index + 1) * 60_000).toISOString(),
                modifiedAt: new Date(now - (index + 1) * 60_000).toISOString()
              }
            }
          ])
        )
        // The stub records the real launch command and cwd without making an AI request.
        await window.api.settings.set({
          terminalWindowsShell: 'powershell.exe',
          terminalWindowsPowerShellImplementation: 'powershell.exe',
          agentCmdOverrides: { claude: `& '${stub.replaceAll("'", "''")}'` },
          chatSidebar: {
            view: 'chats',
            groupBy: 'status',
            sessions,
            automationChats: [JSON.stringify(['local', 'claude', ids[2]])]
          }
        })
      },
      { folder, nextFolder, ids, transcripts, stub }
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    const rows = page.locator('[data-chat-sidebar-id]')
    const latest = rows.filter({ hasText: 'Latest client research' })
    await expect(latest).toBeVisible()
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('Latest client research')
    await expect(rows.filter({ hasText: 'Earlier client draft' })).toContainText('agency-project')
    expect((await latest.boundingBox())?.height).toBe(36)
    await expect(rows.filter({ hasText: 'Earlier client draft' })).not.toHaveAttribute(
      'data-chat-sub-tab',
      'true'
    )
    await expect(latest).toHaveAttribute('data-chat-completed', 'false')
    await latest.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename chat', exact: true }).click()
    await page.getByRole('textbox', { name: 'Chat name', exact: true }).fill('Saved client name')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const renamed = rows.filter({ hasText: 'Saved client name' })
    await renamed.getByRole('button', { name: 'Mark Saved client name done' }).click()
    await expect(renamed).toHaveAttribute('data-chat-completed', 'true')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(renamed).toBeVisible()
    await expect(renamed).toHaveAttribute('data-chat-completed', 'true')
    await page.getByRole('button', { name: /^Chat grouping and folder filters/ }).click()
    const progressFilter = page.getByRole('menuitemcheckbox', {
      name: 'Hide Done chats',
      exact: true
    })
    await progressFilter.click()
    await expect(progressFilter).toHaveAttribute('aria-checked', 'true')
    await captureHiddenRendererScreenshot(page, testInfo.outputPath('packaged-chat-filters.png'))
    await page.keyboard.press('Escape')
    await expect(renamed).toHaveCount(0)
    await expect(rows).toHaveCount(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(renamed).toHaveCount(0)
    await expect(rows).toHaveCount(1)
    await page.getByRole('button', { name: /^Chat grouping and folder filters/ }).click()
    await expect(progressFilter).toHaveAttribute('aria-checked', 'true')
    await progressFilter.click()
    await page.keyboard.press('Escape')
    await expect(renamed).toBeVisible()
    await expect(rows).toHaveCount(2)
    const filterButton = page.getByRole('button', {
      name: /^Chat grouping and folder filters/
    })
    await expect(filterButton).toHaveAttribute('data-filters-active', 'false')
    const inactiveBox = await filterButton.boundingBox()
    expect(inactiveBox).not.toBeNull()
    if (!inactiveBox) {
      throw new Error('Filter button has no visible bounds')
    }
    for (const option of ['Hide Done chats', 'Show only open chats', 'Collapse Done folders']) {
      await expect(page.getByRole('menu')).toHaveCount(0)
      await filterButton.click()
      await page.getByRole('menuitemcheckbox', { name: option, exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(filterButton).toHaveAttribute('data-filters-active', 'true')
      await assertPackagedChatFilterHighlight(filterButton, inactiveBox.width)
      await filterButton.click()
      await page.getByRole('menuitemcheckbox', { name: option, exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(filterButton).toHaveAttribute('data-filters-active', 'false')
    }
    await renamed.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Change folder', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'local-tools', exact: true }).click()
    await expect(renamed).toContainText('local-tools')
    await expect(rows.filter({ hasText: 'Earlier client draft' })).toContainText('agency-project')
    await renamed.dblclick()
    await expect
      .poll(() => (existsSync(capture) ? readFileSync(capture, 'utf8') : ''), { timeout: 45_000 })
      .toContain(ids[0])
    const launched = readFileSync(capture, 'utf8').trim().split(/\r?\n/)
    expect(launched).toHaveLength(1)
    expect(launched[0]).toContain(nextFolder)
    expect(existsSync(transcripts[0])).toBe(true)
    await expect(rows).toHaveCount(2)
    await expect(renamed).toHaveAttribute('aria-selected', 'true')
    await expect(renamed).toHaveAttribute('data-chat-completed', 'true')
    const generatedWorkspace = await page.evaluate(async (folder) => {
      const added = await window.api.repos.add({ path: folder, kind: 'folder' })
      if ('error' in added) {
        throw new Error(added.error)
      }
      const { worktree } = await window.api.worktrees.create({
        repoId: added.repo.id,
        name: 'coho',
        nameWasGenerated: true
      })
      const settings = await window.api.settings.get()
      const snapshot = Object.values(settings.chatSidebar?.sessions ?? {})[0].snapshot
      if (!snapshot) {
        throw new Error('Missing smoke session snapshot')
      }
      const sessionId = '44444444-4444-4444-8444-444444444444'
      await window.api.settings.set({
        chatSidebar: {
          ...settings.chatSidebar,
          sessions: {
            ...settings.chatSidebar?.sessions,
            [JSON.stringify(['local', 'claude', sessionId])]: {
              worktreeId: worktree.id,
              snapshot: { ...snapshot, sessionId, title: 'Set Krisp to record webinar' }
            }
          }
        }
      })
      return { id: worktree.id, mode: worktree.displayNameMode }
    }, folder)
    expect(generatedWorkspace.mode).toBe('automatic')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(rows.filter({ hasText: 'Set Krisp to record webinar' })).toBeVisible()
    await page.evaluate(async (worktreeId) => {
      await window.api.worktrees.updateMeta({ worktreeId, updates: { displayName: 'coho' } })
    }, generatedWorkspace.id)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(rows.filter({ hasText: 'coho' })).toBeVisible()
    await expect(rows.filter({ hasText: 'Set Krisp to record webinar' })).toHaveCount(0)
    await captureHiddenRendererScreenshot(page, testInfo.outputPath('packaged-chat-sidebar.png'))
    const inbox = path.join(userDataDir, 'Uncategorized')
    mkdirSync(inbox)
    await page.evaluate(async (parentPath) => {
      await window.api.projectGroups.create({ name: 'Old inbox label', parentPath })
    }, inbox)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New workspace', exact: true }).click()
    const newChat = page.getByRole('dialog', { name: 'New chat', exact: true })
    await expect(newChat.getByRole('combobox', { name: 'Folder', exact: true })).toContainText(
      'Uncategorized (default)'
    )
    await captureHiddenRendererScreenshot(page, testInfo.outputPath('packaged-new-chat-folder.png'))
    await page.keyboard.press('Escape')
    await assertPackagedDefaultHomeCodexRestart(
      page,
      isolation.isolatedHome,
      folder,
      generatedWorkspace.id
    )
    await assertPackagedMouseHistory(app, page)
    const storeAsset = await app.evaluate(({ app }) => {
      const files = process.mainModule
        ?.require('node:fs')
        .readdirSync(`${app.getAppPath()}/out/renderer/assets`)
      return files.find((file: string) => /^store-.*\.js$/.test(file))
    })
    expect(storeAsset).toBeTruthy()
    await page.evaluate(async (asset) => {
      const module = await import(new URL(`./assets/${asset}`, location.href).href)
      const store = Object.values(module).find(
        (value) => typeof value === 'function' && 'setState' in value
      )
      if (
        typeof store !== 'function' ||
        !('setState' in store) ||
        typeof store.setState !== 'function'
      ) {
        throw new Error('Packaged store missing')
      }
      store.setState({
        orcaProfileAuthStatus: {
          activeProfileId: 'fixture',
          configured: true,
          state: 'reconnect-required',
          persistence: 'none',
          cloud: {
            cloudProfileId: 'fixture',
            userId: 'fixture',
            email: 'fixture@example.com',
            displayName: 'Fixture',
            linkedAt: 0
          }
        },
        persistedUIReady: true,
        dismissedUnexpectedSignoutVersion: null,
        unexpectedSignoutDismissedVersions: []
      })
    }, storeAsset)
    await expect(page.getByRole('heading', { name: "You've been signed out" })).toBeVisible()
    await captureHiddenRendererScreenshot(
      page,
      testInfo.outputPath('packaged-signout-reminder.png')
    )
    expect(errors).toEqual([])
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } catch (error) {
    try {
      const page = await app.firstWindow()
      await page.screenshot({
        path: testInfo.outputPath('packaged-chat-failure.png'),
        timeout: 5000
      })
      const terminals = await page.evaluate(async () => {
        const sessions = await window.api.pty.listSessions()
        return Promise.all(
          sessions.map(async (session) => ({
            id: session.id,
            buffer: await window.api.pty.getMainBufferSnapshot(session.id, { scrollbackRows: 50 })
          }))
        )
      })
      writeFileSync(
        testInfo.outputPath('resume-terminals.json'),
        JSON.stringify(terminals, null, 2)
      )
    } catch (diagnosticError) {
      console.warn('Packaged failure diagnostics unavailable:', diagnosticError)
    }
    throw error
  } finally {
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
  }
})
