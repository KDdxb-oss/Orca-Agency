import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@stablyai/playwright-test'
import {
  buildFreshShellProbeInputSequence,
  encodedShellMarkerCommand
} from '../terminal-probe-input-sequence'

export async function waitForPackagedNativeShellInput(
  page: Page,
  worktreeId: string
): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }
  let ptyId = ''
  await expect
    .poll(
      async () => {
        ptyId = await page.evaluate(async (id) => {
          const session = (await window.api.pty.listSessions()).find(
            (entry) => entry.worktreeId === id
          )
          if (!session) {
            return ''
          }
          const snapshot = await window.api.pty.getMainBufferSnapshot(session.id, {
            scrollbackRows: 10
          })
          return snapshot?.data.includes('\x1b[?1004h') ? session.id : ''
        }, worktreeId)
        return ptyId
      },
      { timeout: 30_000 }
    )
    .not.toBe('')

  // PSReadLine focus mode can precede readiness; require actual shell execution.
  const marker = `ORCA_PTY_READY_${randomUUID()}`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const input of buildFreshShellProbeInputSequence(encodedShellMarkerCommand(marker))) {
      await page.evaluate(({ id, input }) => window.api.pty.write(id, input, 'driving'), {
        id: ptyId,
        input
      })
    }
    const probeDeadline = Math.min(deadline, Date.now() + 3_000)
    while (Date.now() < probeDeadline) {
      const output = await page.evaluate(async (id) => {
        const snapshot = await window.api.pty.getMainBufferSnapshot(id, { scrollbackRows: 100 })
        return snapshot?.data ?? ''
      }, ptyId)
      if (output.includes(marker)) {
        return
      }
      await page.waitForTimeout(100)
    }
  }
  throw new Error(`Packaged native PTY ${ptyId} did not execute its readiness probe`)
}
