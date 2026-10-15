import { expect, type Locator } from '@stablyai/playwright-test'

export async function assertPackagedChatFilterHighlight(button: Locator, inactiveWidth: number) {
  const expectedPixels = await button.evaluate(() =>
    Math.max(1, Math.floor(window.devicePixelRatio))
  )
  await expect
    .poll(() =>
      button.evaluate((node) => {
        if (node.getAnimations().some((animation) => animation.playState === 'running')) {
          return null
        }
        const style = getComputedStyle(node)
        return {
          style: style.borderTopStyle,
          // Why: Chromium snaps CSS borders to physical pixels on scaled Windows displays.
          pixels: Math.round(Number.parseFloat(style.borderTopWidth) * window.devicePixelRatio)
        }
      })
    )
    .toEqual({ style: 'solid', pixels: expectedPixels })
  const activeBox = await button.boundingBox()
  expect(activeBox).not.toBeNull()
  expect(activeBox?.width).toBe(inactiveWidth)
}
