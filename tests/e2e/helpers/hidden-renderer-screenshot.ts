import type { Page } from '@stablyai/playwright-test'

// Hidden Windows renderers occasionally miss one compositor capture under Windows.
export async function captureHiddenRendererScreenshot(
  page: Page,
  screenshotPath: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.screenshot({ path: screenshotPath, timeout: 10_000 })
      return
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Timeout') || attempt === 2) {
        throw error
      }
    }
  }
}
