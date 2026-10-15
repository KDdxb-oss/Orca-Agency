import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'

export async function assertPackagedMouseHistory(
  app: ElectronApplication,
  page: Page
): Promise<void> {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return
  }
  const rows = page.locator('[data-chat-sidebar-id]')
  const previous = rows.filter({ hasText: 'Earlier client draft' })
  const current = rows.filter({ hasText: 'Saved client name' })
  await previous.click()
  await expect(previous).toHaveAttribute('aria-selected', 'true')
  await current.click()
  await expect(current).toHaveAttribute('aria-selected', 'true')
  const hostWindow = await app.browserWindow(page)
  const contentsId = await hostWindow.evaluate((window) => window.webContents.id)
  const dispatch = async (direction: 'browser-backward' | 'browser-forward'): Promise<void> => {
    await app.evaluate(
      ({ webContents, BrowserWindow }, args) => {
        const contents = webContents.fromId(args.contentsId)
        const window = contents && BrowserWindow.fromWebContents(contents)
        if (!window) {
          throw new Error('Fixture window no longer exists')
        }
        const originalFocusedContents = webContents.getFocusedWebContents
        // Hidden fixture: simulate ownership without revealing or focusing its window.
        webContents.getFocusedWebContents = () => window.webContents
        try {
          if (webContents.getFocusedWebContents() !== window.webContents) {
            throw new Error('Hidden fixture focus simulation failed')
          }
          window.emit('app-command', { preventDefault: () => {} }, args.direction)
        } finally {
          webContents.getFocusedWebContents = originalFocusedContents
        }
      },
      { direction, contentsId }
    )
  }
  await dispatch('browser-backward')
  await expect(previous).toHaveAttribute('aria-selected', 'true')
  await dispatch('browser-forward')
  await expect(current).toHaveAttribute('aria-selected', 'true')
}
