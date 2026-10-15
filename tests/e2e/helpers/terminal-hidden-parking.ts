import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { getActiveTabId } from './store'
import { waitForActiveTerminalManager, waitForPaneIdentitySnapshot } from './terminal'
import { PTY_SESSION_ID_SEPARATOR } from '../../../src/shared/pty-session-id-format'

function resolveParkWaitTimeoutMs(parkDelayMs?: number): number {
  const delay = parkDelayMs ?? (Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500)
  return Math.max(20_000, delay * 10)
}

// Why: TerminalPane unmount deletes its entry from window.__paneManagers, so a
// missing manager is the observable signal that the tab's xterm was parked.
export async function waitForTabParked(
  page: Page,
  tabId: string,
  options?: { parkDelayMs?: number }
): Promise<number> {
  const parkWaitStartedAt = Date.now()
  await expect
    .poll(async () => page.evaluate((id) => window.__paneManagers?.get(id) !== undefined, tabId), {
      timeout: resolveParkWaitTimeoutMs(options?.parkDelayMs),
      message: `terminal tab ${tabId} did not park (pane manager still mounted)`
    })
    .toBe(false)
  return Date.now() - parkWaitStartedAt
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('createActiveTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
    return tab.id
  }, worktreeId)

  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: 'newly created terminal tab did not become active'
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  return tabId
}

async function waitForRestorableDecoy(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<boolean> {
  const ownedByWorktree = await page.evaluate(
    ({ worktreeId, tabId, separator }) => {
      const ptyId = window.__store
        ?.getState()
        .tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)?.ptyId
      const separatorIndex = ptyId?.lastIndexOf(separator) ?? -1
      return separatorIndex >= 0 && ptyId?.slice(0, separatorIndex) === worktreeId
    },
    { worktreeId, tabId, separator: PTY_SESSION_ID_SEPARATOR }
  )
  if (!ownedByWorktree) {
    return false
  }
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ worktreeId, tabId }) => {
            const tab = window.__store
              ?.getState()
              .tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
            return tab?.ptyId
              ? window.__terminalParkingDebug?.authoritativeSnapshot(tab.ptyId) === true
              : false
          },
          { worktreeId, tabId }
        ),
      { timeout: 60_000, message: 'worktree-owned decoy never became snapshot-restorable' }
    )
    .toBe(true)
  return true
}

// Why: #8262 exempts the single most-recently-hidden tab from cold-park. An
// active target therefore needs two decoys (hide it, then move the exemption);
// an already-hidden target needs one. Returns waitForTabParked's elapsed time.
export async function parkHiddenTabBehindDecoy(
  page: Page,
  worktreeId: string,
  targetTabId: string,
  options?: { parkDelayMs?: number; requireRestorableDecoy?: boolean }
): Promise<number> {
  // An active target needs one decoy to become old and another to take the
  // last-active exemption; already-hidden targets need only the latter.
  if ((await getActiveTabId(page)) === targetTabId) {
    if (options?.requireRestorableDecoy) {
      let foundRestorableDecoy = false
      for (let attempt = 0; attempt < 4 && !foundRestorableDecoy; attempt += 1) {
        const decoyId = await createActiveTerminalTab(page, worktreeId)
        foundRestorableDecoy = await waitForRestorableDecoy(page, worktreeId, decoyId)
      }
      if (!foundRestorableDecoy) {
        throw new Error('No worktree-owned decoy was available to replace the park exemption')
      }
    } else {
      await createActiveTerminalTab(page, worktreeId)
    }
  }
  await createActiveTerminalTab(page, worktreeId)
  return waitForTabParked(page, targetTabId, options)
}
